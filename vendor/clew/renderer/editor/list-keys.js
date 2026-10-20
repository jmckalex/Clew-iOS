// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Enter and ⌘Enter in a list item (the owner's choice, 2026-10-19). Enter
// stays IN the item — a new line under its text, so an item holds as many
// paragraphs as you like (Enter twice for a blank line between) — and
// ⌘Enter starts the next item, after the whole of this one, wherever the
// cursor is in it. CodeMirror's own rule (lang-markdown's
// insertNewlineContinueMarkup) was the reverse on an item's first line and
// gave a hard-wrapped item no way to a new item at all; and it indents a
// task's continuation past its `[ ] `, four columns beyond the item's
// content, where a second paragraph is an indented code block.
//
// Which item a line belongs to is the tree's answer, except on a BLANK line,
// which the tree leaves out of every item: there it is markdown's own rule —
// the item whose content column the line's indentation reaches. So
// Backspace over the indentation (CodeMirror's deleteMarkupBackward) and
// Enter leaves the list. Elsewhere — a quote inside the item, a fence, an
// empty item (which ends the list), prose — both keys leave the work to
// CodeMirror, as before.
//
// Pure over an EditorState (the specs), so tests/list-keys.test.js needs no
// view; the two commands at the bottom dispatch them.
import { syntaxTree } from '@codemirror/language';
import { EditorSelection } from '@codemirror/state';
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { insertBlankLine } from '@codemirror/commands';

/** Blocks whose newlines are not the list's business. */
const OPAQUE = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock']);
const blank = (text) => /^[\s>]*$/.test(text);

/**
 * An item's shape, read from its first line: where its marker starts, where
 * its content starts (CommonMark's rule: the spaces after the marker, unless
 * there are five or more, or none before the end of the line — then one).
 */
function shape(doc, item) {
	const first = doc.lineAt(item.from);
	const mark = item.getChild('ListMark');
	if (!mark) return null;
	const markFrom = mark.from - first.from;
	const markTo = mark.to - first.from;
	const space = /^[ \t]*/.exec(first.text.slice(markTo))[0];
	const rest = first.text.slice(markTo + space.length);
	const gap = space.length === 0 || space.length >= 5 || rest === '' ? 1 : space.length;
	// A task's box is the item's content, not its marker.
	const text = rest.replace(/^\[[ xX]\]\s*/, '');
	return {
		first, markFrom, markTo, gap, content: markTo + gap,
		mark: first.text.slice(markFrom, markTo),
		task: Boolean(item.getChild('Task')),
		// Nothing but its marker (and an empty box): ending the list is
		// CodeMirror's business.
		empty: text.trim() === '' && doc.lineAt(item.to).number === first.number,
	};
}

/** Everything before column `to` of the item's first line, as continuation:
 *  a quote's `>` kept, any other character a space. */
const prefixOf = (s, to) => s.first.text.slice(0, to).replace(/[^\s>]/g, ' ');

/**
 * The list item a cursor at `pos` is in, or null. `through`: also from
 * inside a quote or a fence within the item (⌘Enter's reach); otherwise
 * those are CodeMirror's.
 */
function itemAt(state, pos, through) {
	const { doc } = state;
	const line = doc.lineAt(pos);
	const tree = syntaxTree(state);
	if (!blank(line.text)) {
		for (let n = tree.resolveInner(pos, -1); n; n = n.parent) {
			if (n.name === 'ListItem') return n;
			if (!through && (OPAQUE.has(n.name) || n.name === 'Blockquote')) return null;
		}
		return null;
	}
	// A blank line: the item, under the nearest line above with text in it,
	// whose content column this line's indentation reaches.
	let above = line.number - 1;
	while (above >= 1 && blank(doc.line(above).text)) above -= 1;
	if (above < 1) return null;
	const indent = /^[\s>]*/.exec(line.text)[0].length;
	const prev = doc.line(above);
	for (let n = tree.resolveInner(prev.to, -1); n; n = n.parent) {
		if (!through && OPAQUE.has(n.name)) return null;
		if (n.name !== 'ListItem') continue;
		const s = shape(doc, n);
		if (s && indent >= s.content) return n;
	}
	return null;
}

/**
 * Enter in a list item: a new line in the same item, under its text. Null
 * where CodeMirror's Enter should run instead.
 *
 * @param {import('@codemirror/state').EditorState} state
 */
export function listEnterSpec(state) {
	const { doc } = state;
	let handled = true;
	const spec = state.changeByRange((range) => {
		const item = handled && itemAt(state, range.head, false);
		const s = item && shape(doc, item);
		const line = doc.lineAt(range.from);
		// Before the item's text on its first line, or an empty item: not ours.
		if (!s || s.empty || (line.number === s.first.number && range.from - line.from < s.content)) {
			handled = false;
			return { range };
		}
		const prefix = prefixOf(s, s.content);
		// A blank line left behind is the item's blank line — empty, or the
		// `>`s of a quote the list is in; an empty quote line inside the item
		// (a second Enter in it) so leaves that quote.
		if (blank(line.text)) {
			const insert = prefix.trimEnd() + state.lineBreak + prefix;
			return { range: EditorSelection.cursor(line.from + insert.length), changes: { from: line.from, to: line.to, insert } };
		}
		// The space before the cursor goes, and so does the space the new
		// line would start with.
		let from = range.from;
		while (from > line.from && /\s/.test(doc.sliceString(from - 1, from))) from -= 1;
		let to = range.to;
		while (to < line.to && /[ \t]/.test(doc.sliceString(to, to + 1))) to += 1;
		const insert = state.lineBreak + prefix;
		return { range: EditorSelection.cursor(from + insert.length), changes: { from, to, insert } };
	});
	return handled ? { ...spec, scrollIntoView: true, userEvent: 'input' } : null;
}

/**
 * ⌘Enter in a list item: the next item, after the whole of this one (its
 * own lines and anything nested in it) — the same marker, the next number,
 * an empty box for a task, a blank line first in a loose list, the numbers
 * after it moved up as CodeMirror moves them. Null outside a list, and on an
 * empty item (CodeMirror's Enter ends the list there).
 *
 * @param {import('@codemirror/state').EditorState} state
 */
export function newListItemSpec(state) {
	const { doc } = state;
	let handled = true;
	const spec = state.changeByRange((range) => {
		const item = handled && itemAt(state, range.head, true);
		const s = item && shape(doc, item);
		if (!s || s.empty) {
			handled = false;
			return { range };
		}
		const ordered = /^(\d+)([.)])$/.exec(s.mark);
		const mark = ordered ? `${Number(ordered[1]) + 1}${ordered[2]}` : s.mark;
		const lead = prefixOf(s, s.markFrom);
		const end = doc.lineAt(item.to);
		// On a blank line past the item's text (Enter left one there), the
		// new item takes that line rather than leaving it behind.
		const line = doc.lineAt(range.head);
		const take = blank(line.text) && line.number > end.number;
		const from = take ? line.from : end.to;
		const gap = looseList(item.parent, doc) && !(take && line.number - 1 > end.number);
		const insert = (take ? '' : state.lineBreak) + (gap ? lead.trimEnd() + state.lineBreak : '')
			+ `${lead}${mark}${' '.repeat(s.gap)}${s.task ? '[ ] ' : ''}`;
		const changes = [{ from, to: take ? line.to : from, insert }];
		if (ordered) renumber(item, doc, changes);
		return { range: EditorSelection.cursor(from + insert.length), changes };
	});
	return handled ? { ...spec, scrollIntoView: true, userEvent: 'input' } : null;
}

/** CodeMirror's test (lang-markdown's nonTightList): a blank line between
 *  the list's first two items. */
function looseList(list, doc) {
	const first = list?.firstChild;
	const second = list?.getChild('ListItem', 'ListItem');
	if (!first || !second) return false;
	const end = doc.lineAt(first.to);
	return end.number + (blank(end.text) ? 0 : 1) < doc.lineAt(second.from).number;
}

/** The items after `item` move up one while their numbers run on from its
 *  (lang-markdown's renumberList): a list of all `1.` stays as it is. */
function renumber(item, doc, changes) {
	const numberOf = (node) => /^(\s*)(\d+)(?=[.)])/.exec(doc.sliceString(node.getChild('ListMark')?.from ?? node.from, node.to));
	let prev = Number(numberOf(item)?.[2]);
	for (let node = item.nextSibling; node; node = node.nextSibling) {
		if (node.name !== 'ListItem') continue;
		const mark = node.getChild('ListMark');
		const m = numberOf(node);
		if (!mark || !m || Number(m[2]) !== prev + 1) return;
		changes.push({ from: mark.from, to: mark.from + m[2].length, insert: String(prev + 2) });
		prev += 1;
	}
}

/** Enter: in a list item, a new line in it; elsewhere false (CodeMirror's). */
export function listEnter(view) {
	const spec = listEnterSpec(view.state);
	if (!spec) return false;
	view.dispatch(view.state.update(spec));
	return true;
}

/** ⌘Enter: in a list item, the next item; on an empty one, CodeMirror's
 *  Enter (the list ends); elsewhere a blank line below, as ⌘Enter was. */
export function newListItem(view) {
	const spec = newListItemSpec(view.state);
	if (spec) {
		view.dispatch(view.state.update(spec));
		return true;
	}
	const { state } = view;
	const item = itemAt(state, state.selection.main.head, true);
	if (item && shape(state.doc, item)?.empty && insertNewlineContinueMarkup(view)) return true;
	return insertBlankLine(view);
}

/**
 * ⌘L, Obsidian's "Toggle checkbox status" (the owner's yes, 2026-10-20): on
 * each line the selection touches, a task is ticked or unticked (any status
 * Clew knows but a space — `[x]`, `[X]`, `[/]`, `[-]`, fill.js's set — unticks;
 * `- [1] Smith` is no task, and becomes `- [ ] [1] Smith`, nothing lost), a list item becomes a task
 * (`- text` → `- [ ] text`, `1. text` → `1. [ ] text`, its marker kept), and
 * any other line — an empty one too — becomes `- [ ] ` and its text, after
 * its indentation and a quote's `>`s. A leading `*strong*` is the dialect's
 * emphasis, not a bullet: a marker needs the space after it. Cursors move
 * with their text.
 *
 * @param {import('@codemirror/state').EditorState} state
 */
export function toggleTaskSpec(state) {
	const { doc } = state;
	const lines = new Set();
	for (const r of state.selection.ranges) {
		let last = doc.lineAt(r.to).number;
		// A selection ending at a line's start does not take that line.
		if (r.to > r.from && doc.line(last).from === r.to) last -= 1;
		for (let n = doc.lineAt(r.from).number; n <= Math.max(last, doc.lineAt(r.from).number); n += 1) lines.add(n);
	}
	const changes = [];
	for (const n of [...lines].sort((a, b) => a - b)) {
		const line = doc.line(n);
		const lead = /^[ \t]*(?:>[ \t]*)*/.exec(line.text)[0].length;
		const rest = line.text.slice(lead);
		const task = /^([-*+]|\d+[.)])([ \t]+)\[([ xX/-])\]/.exec(rest);
		if (task) {
			const at = line.from + lead + task[1].length + task[2].length + 1;
			changes.push({ from: at, to: at + 1, insert: task[3] === ' ' ? 'x' : ' ' });
			continue;
		}
		const item = /^([-*+]|\d+[.)])(?:([ \t]+)|$)/.exec(rest);
		if (item) {
			const at = line.from + lead + item[0].length;
			changes.push({ from: at, insert: item[2] ? '[ ] ' : ' [ ] ' });
		} else {
			changes.push({ from: line.from + lead, insert: '- [ ] ' });
		}
	}
	const set = state.changes(changes);
	return { changes: set, selection: state.selection.map(set, 1), userEvent: 'input.task' };
}

/** ⌘L: make each touched line a task, or tick or untick it (toggleTaskSpec). */
export function toggleTask(view) {
	view.dispatch(view.state.update(toggleTaskSpec(view.state)));
	return true;
}
