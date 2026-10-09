// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Formatting commands: the implementation behind the Format menu
// (src/shared/format-spec.js declares the structure; every item here is a
// registry command, so the palette and the hotkey editor see them all).
// Everything operates on the active tab's live editor via the pool.
import { EditorSelection } from '@codemirror/state';
import { startCompletion } from '@codemirror/autocomplete';
import { indentMore, indentLess, insertBlankLine, undo, redo } from '@codemirror/commands';
import { toggleWrapSpec } from '../editor/toggle-wrap.js';
import { vaultSettingsStore } from '../state/vault-settings-store.js';
import { saveAndInsert } from '../editor/attachments.js';
import { CALLOUT_TYPES, BUILTIN_CALLOUT_TYPES } from '#jmarkdown/callout-table.js';
import { CELL_SAFE_COMMANDS } from '../../shared/format-spec.js';
import {
	activeCellView, applyStructure, leaveCell, tableTarget, activateCell, rowIndex,
} from '../editor/live/table-cell-editor.js';
import { activeCellOf } from '../editor/live/active-cell.js';
import { cellAt } from '../editor/live/table-cell-model.js';
import {
	insertRow, deleteRow, insertColumn, deleteColumn, moveRow, moveColumn, setAlignment,
} from '../editor/tables.js';
import { notice } from '../plugins.js';
import { typedRefText } from '../editor/live/numbering.js';
import { numberingFor, bookPlace } from '../editor/live/numbering-source.js';
import { viewNotePath } from '../editor/view-note-path.js';
import { openNoteAtLine } from './actions.js';
import { openListModal } from '../components/modals/list-modal.js';
import { workspaceStore } from '../state/workspace-store.js';
import { EditorView } from '@codemirror/view';
import { registerCommand, unregisterCommand, buildContext } from './registry.js';
import { editorPool } from '../editor/pool.js';

export const needsEditor = (ctx) =>
	ctx.notePath !== null && ctx.activeTab?.view?.mode !== 'reading';

/** The active tab's NOTE editor (the pooled view). */
export function activeMainView() {
	const ctx = buildContext();
	return editorPool.get(ctx.activeTab?.id)?.view ?? null;
}

/**
 * The editor a formatting command acts on: the table cell being edited in
 * place when there is one (its changes forward to the note like typing),
 * else the note's editor. Plugins' commands inherit the routing.
 */
export function activeEditorView() {
	const main = activeMainView();
	return activeCellView(main) ?? main;
}

// ---- inline helpers --------------------------------------------------------

/** Wrap each selection range in marker pairs, or unwrap: markers just
 *  outside or inside the range, or a construct of that kind around it
 *  (editor/toggle-wrap.js — the construct model finds its delimiters). */
export function toggleWrap(view, before, after = before) {
	view.dispatch(toggleWrapSpec(view.state, before, after, { normalSyntax: normalSyntax() }));
	view.focus();
}

/** The vault's dialect switch: standard markdown's `**bold**`, `*italic*`. */
const normalSyntax = () => vaultSettingsStore.get('normalSyntax') === true;

/** Insert before+content+after at the selection; the content (selection or
 *  placeholder) ends up selected so it can be typed over. */
function insertInline(view, before, after, placeholder = '') {
	const range = view.state.selection.main;
	const inner = range.empty ? placeholder : view.state.sliceDoc(range.from, range.to);
	view.dispatch({
		changes: { from: range.from, to: range.to, insert: before + inner + after },
		selection: EditorSelection.range(
			range.from + before.length,
			range.from + before.length + inner.length,
		),
	});
	view.focus();
}

/** Wrap the selection as [[selection]] (cursor before ]]), or insert empty
 *  brackets and pop the wikilink completion. */
export function insertWikilink(view) {
	const range = view.state.selection.main;
	const text = view.state.sliceDoc(range.from, range.to);
	view.dispatch({
		changes: { from: range.from, to: range.to, insert: `[[${text}]]` },
		selection: { anchor: range.from + 2 + text.length },
	});
	view.focus();
	if (!text) startCompletion(view);
}

// ---- line helpers ----------------------------------------------------------

function selectedLines(state) {
	const { from, to } = state.selection.main;
	const first = state.doc.lineAt(from).number;
	const last = state.doc.lineAt(to).number;
	const lines = [];
	for (let n = first; n <= last; n++) lines.push(state.doc.line(n));
	return lines;
}

/** Replace each selected line's text via mapFn; selection covers the result
 *  (end position accounts for the length deltas of every earlier line). */
function changeLines(view, mapFn) {
	const lines = selectedLines(view.state);
	const mapped = lines.map((line, i) => mapFn(line.text, i));
	const changes = lines.map((line, i) => ({ from: line.from, to: line.to, insert: mapped[i] }));
	let delta = 0;
	for (let i = 0; i < lines.length - 1; i++) delta += mapped[i].length - lines[i].text.length;
	view.dispatch({
		changes,
		selection: EditorSelection.range(
			lines[0].from,
			lines.at(-1).from + delta + mapped.at(-1).length,
		),
	});
	view.focus();
}

const BLOCK_PREFIX_RE = /^(\s*)(?:[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d+[.)][ \t]+|>[ \t]+)/;
const stripPrefix = (text) => text.replace(BLOCK_PREFIX_RE, '$1');

/**
 * On an EMPTY line (or a selection of nothing but blank lines) a line
 * command has nothing to wrap, and used to do nothing at all — which is
 * where you start a list, and where the `//` menu always leaves you. There
 * it writes the marker and puts the cursor where the text goes.
 *
 * @returns {boolean} whether it handled the line
 */
function startOnEmptyLine(view, before, after = '') {
	const lines = selectedLines(view.state);
	if (!lines.every((l) => l.text.trim() === '')) return false;
	const line = lines[0];
	const indent = /^\s*/.exec(line.text)[0];
	view.dispatch({
		changes: { from: line.from, to: lines.at(-1).to, insert: indent + before + after },
		selection: { anchor: line.from + indent.length + before.length },
	});
	view.focus();
	return true;
}

/** Toggle a list/quote prefix on the selected lines. */
function toggleLinePrefix(view, kind) {
	const detect = {
		bullet: /^\s*[-*+][ \t]+(?!\[)/,
		task: /^\s*[-*+][ \t]+\[[ xX]\][ \t]/,
		numbered: /^\s*\d+[.)][ \t]/,
		quote: /^\s*>[ \t]/,
	}[kind];
	const start = kind === 'bullet' ? '- ' : kind === 'task' ? '- [ ] ' : kind === 'numbered' ? '1. ' : '> ';
	if (startOnEmptyLine(view, start)) return;
	const lines = selectedLines(view.state).map((l) => l.text);
	const allAlready = lines.every((t) => t.trim() === '' || detect.test(t));
	changeLines(view, (text, i) => {
		if (text.trim() === '') return text;
		const stripped = stripPrefix(text);
		if (allAlready) return stripped;
		const indent = /^\s*/.exec(stripped)[0];
		const body = stripped.slice(indent.length);
		const prefix = kind === 'bullet' ? '- '
			: kind === 'task' ? '- [ ] '
			: kind === 'numbered' ? `${i + 1}. `
			: '> ';
		return indent + prefix + body;
	});
}

function setHeading(view, level) {
	changeLines(view, (text) => {
		const body = text.replace(/^\s*#{1,6}[ \t]+/, '');
		return level === 0 ? body : '#'.repeat(level) + ' ' + body;
	});
}

// Alignment (jmarkdown): ">> text <<" centers, ">> text" right-aligns.
const CENTER_RE = /^>> ?(.*?) ?<<\s*$/;
const RIGHT_RE = /^>> ?(.*)$/;
const stripAlign = (text) => {
	const center = CENTER_RE.exec(text);
	if (center) return center[1];
	const right = RIGHT_RE.exec(text);
	if (right && !/<<\s*$/.test(text)) return right[1];
	return text;
};

function toggleAlign(view, kind) {
	if (kind !== 'clear' && startOnEmptyLine(view, '>> ', kind === 'center' ? ' <<' : '')) return;
	const lines = selectedLines(view.state).map((l) => l.text);
	const detect = kind === 'center'
		? (t) => CENTER_RE.test(t)
		: (t) => RIGHT_RE.test(t) && !/<<\s*$/.test(t);
	const allAlready = lines.every((t) => t.trim() === '' || detect(t));
	changeLines(view, (text) => {
		if (text.trim() === '') return text;
		const body = stripAlign(text);
		if (allAlready || kind === 'clear') return body;
		return kind === 'center' ? `>> ${body} <<` : `>> ${body}`;
	});
}

function wrapAlert(view, type) {
	const range = view.state.selection.main;
	if (range.empty) {
		insertBlock(view, `> [!${type}]\n> Alert text`, 'Alert text');
		return;
	}
	changeLines(view, (text, i) => {
		const line = `> ${stripPrefix(text)}`;
		return i === 0 ? `> [!${type}]\n${line}` : line;
	});
}

// ---- block insertion -------------------------------------------------------

/** Insert a block at the cursor on its own lines (blank-line padded), and
 *  select `placeholder` inside it when given. */
function insertBlock(view, text, placeholder = null) {
	const { state } = view;
	const range = state.selection.main;
	const line = state.doc.lineAt(range.from);
	const before = line.text.trim() === '' ? '' : '\n\n';
	const atEnd = range.to >= state.doc.length;
	const nextLine = !atEnd && state.doc.lineAt(range.to).number < state.doc.lines
		? state.doc.line(state.doc.lineAt(range.to).number + 1).text
		: '';
	const after = nextLine.trim() === '' ? '\n' : '\n\n';
	const insert = before + text + after;
	const base = range.from + before.length;
	const at = placeholder ? text.indexOf(placeholder) : -1;
	view.dispatch({
		changes: { from: range.from, to: range.to, insert },
		selection: at !== -1
			? EditorSelection.range(base + at, base + at + placeholder.length)
			: { anchor: base + text.length },
	});
	view.focus();
}

/** Wrap the selection (or a placeholder) in a container fence. */
function wrapContainer(view, header, footer = ':::', placeholder = 'Content') {
	const range = view.state.selection.main;
	if (range.empty) {
		insertBlock(view, `${header}\n${placeholder}\n${footer}`, placeholder);
		return;
	}
	const selection = view.state.sliceDoc(range.from, range.to);
	insertBlock(view, `${header}\n${selection}\n${footer}`);
}

function insertTable(view, rows, cols) {
	const cells = (fill) => '|' + Array(cols).fill(fill).join('|') + '|';
	const header = '|' + Array.from({ length: cols }, (_, i) => ` Col ${i + 1} `).join('|') + '|';
	const lines = [header, cells('-------'), ...Array(rows).fill(cells('       '))];
	insertBlock(view, lines.join('\n'), ' Col 1 ');
}

/** Insert an empty row below the current table row. */
function insertTableRow(view) {
	const { state } = view;
	const line = state.doc.lineAt(state.selection.main.from);
	const cellCount = (line.text.match(/\|/g) ?? []).length - 1;
	if (!line.text.trim().startsWith('|') || cellCount < 1) return;
	const row = '|' + Array(cellCount).fill('   ').join('|') + '|';
	view.dispatch({
		changes: { from: line.to, insert: '\n' + row },
		selection: { anchor: line.to + 3 },
	});
	view.focus();
}

/** Focus what was being edited: the cell editor, or the note. */
function refocus(main) {
	(activeCellView(main) ?? main).focus();
}

/**
 * A structural table operation on the table under the active cell or the
 * cursor (tables.js does the work; table-cell-editor.js#applyStructure
 * writes it and lands in the right cell). Rows are LOGICAL: a GFM table's
 * header is row 0; a headerless table has no header rows (`h` is 0).
 */
function tableOp(view, op) {
	const t = tableTarget(view);
	if (!t) return false;
	const rows = t.ranges.rows.length;
	const { row, col } = t;
	const h = t.ranges.headerRows;
	const at = (table, r) => rowIndex(table, r);
	const ops = {
		'row-above': [(tb) => insertRow(tb, row < h ? tb.delimiterRow + 1 : at(tb, row)), () => ({ row: Math.max(h, row), col })],
		'row-below': [(tb) => insertRow(tb, row < h ? tb.delimiterRow + 1 : at(tb, row) + 1), () => ({ row: row < h ? h : row + 1, col })],
		'delete-row': [(tb) => (row < h ? tb : deleteRow(tb, at(tb, row))), () => ({ row: Math.max(0, Math.min(row, rows - 2)), col })],
		'col-left': [(tb) => insertColumn(tb, col), () => ({ row, col })],
		'col-right': [(tb) => insertColumn(tb, col + 1), () => ({ row, col: col + 1 })],
		'delete-col': [(tb) => deleteColumn(tb, col), () => ({ row, col: Math.max(0, col - 1) })],
		'row-up': [(tb) => (row <= h ? tb : moveRow(tb, at(tb, row), at(tb, row - 1))), () => ({ row: row - 1, col })],
		'row-down': [(tb) => (row < h || row >= rows - 1 ? tb : moveRow(tb, at(tb, row), at(tb, row + 1))), () => ({ row: row + 1, col })],
		'col-move-left': [(tb) => moveColumn(tb, col, col - 1), () => ({ row, col: col - 1 })],
		'col-move-right': [(tb) => moveColumn(tb, col, col + 1), () => ({ row, col: col + 1 })],
		'align-left': [(tb) => setAlignment(tb, col, 'left'), () => ({ row, col })],
		'align-center': [(tb) => setAlignment(tb, col, 'center'), () => ({ row, col })],
		'align-right': [(tb) => setAlignment(tb, col, 'right'), () => ({ row, col })],
		'align-none': [(tb) => setAlignment(tb, col, null), () => ({ row, col })],
		// A reflow that keeps the cell: format the table in place.
		format: [(tb) => ({ ...tb }), () => ({ row, col })],
	};
	const [fn, to] = ops[op];
	return applyStructure(view, fn, to);
}

/** Reflow the table of the cell being edited in place, and keep editing it. */
export function formatTableKeepingCell(view) {
	return Boolean(activeCellOf(view.state)) && tableOp(view, 'format');
}

/** Live edit, cursor in a table's source: edit the cell under it in place. */
function editCellAtCursor(view) {
	if (activeCellOf(view.state)) return;
	const t = tableTarget(view);
	if (!t) { notice('Put the cursor in a table first'); return; }
	const pos = view.state.selection.main.head;
	const cell = cellAt(t.ranges, pos) ?? { row: t.row, col: t.col };
	const range = t.ranges.rows[cell.row][cell.col];
	activateCell(view, t.first, t.last, cell.row, cell.col, Math.max(0, pos - range.from));
}

/** `[text](url)` at the selection; the text is the selection when none given. */
function insertLink(view, url, text) {
	const range = view.state.selection.main;
	const label = text ?? view.state.sliceDoc(range.from, range.to);
	const insert = `[${label || 'link'}](${url})`;
	view.dispatch({
		changes: { from: range.from, to: range.to, insert },
		selection: label ? { anchor: range.from + insert.length }
			: EditorSelection.range(range.from + 1, range.from + 5),
	});
	view.focus();
}

/** A file picker; the chosen files go where pasted ones go (attachments.js). */
function pickAttachment(view) {
	const input = document.createElement('input');
	input.type = 'file';
	input.multiple = true;
	input.addEventListener('change', () => {
		if (input.files?.length) saveAndInsert(view, [...input.files], view.state.selection.main.head);
	});
	input.click();
}

/** `> [!type]±` around the selection (or a placeholder body). */
function wrapCallout(view, type, fold) {
	const range = view.state.selection.main;
	if (range.empty) {
		insertBlock(view, `> [!${type}]${fold}\n> Text`, 'Text');
		return;
	}
	changeLines(view, (text, i) => {
		const line = `> ${stripPrefix(text)}`;
		return i === 0 ? `> [!${type}]${fold}\n${line}` : line;
	});
}

/** A figure block of a given kind, with an optional `show=` choice. */
function insertFigure(view, kind, show) {
	const bodies = {
		mermaid: 'graph LR\n  A --> B',
		tikz: '\\begin{tikzpicture}\n  \\draw (0,0) -- (1,1);\n\\end{tikzpicture}',
		latex: '$\\displaystyle \\int_0^1 x\\,dx$',
		tex: '$$\\sqrt{2}$$\n\\nopagenumbers\\bye',
		metapost: 'beginfig(1);\n  draw fullcircle scaled 2cm;\nendfig;',
	};
	const info = kind + (show && kind !== 'mermaid' ? ` show=${show}` : '');
	wrapContainer(view, '```' + info, '```', bodies[kind] ?? '');
}

/**
 * `:::name` around the selection — or `@begin(name)`/`@end(name)` when the
 * note already writes its environments that way (one look, not a setting).
 */
function wrapEnvironment(view, name) {
	const atStyle = /^[ \t]*@begin\(/m.test(view.state.doc.toString());
	if (atStyle) wrapContainer(view, `@begin(${name})`, `@end(${name})`, 'Content');
	else wrapContainer(view, `:::${name}`, ':::', 'Content');
}

/**
 * ⌘-Enter on a task line flips its checkbox — in either editing mode. Off a
 * task line it is CodeMirror's own ⌘-Enter (a blank line below), which the
 * chord would otherwise have taken away.
 */
function toggleTask(view) {
	const { state } = view;
	const line = state.doc.lineAt(state.selection.main.head);
	const m = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\]/.exec(line.text);
	if (!m) return insertBlankLine(view);
	const at = line.from + m[1].length + 1;
	view.dispatch({ changes: { from: at, to: at + 1, insert: m[2] === ' ' ? 'x' : ' ' }, userEvent: 'input.task' });
	return true;
}

/** A list of the note's labels (§5.13) — kind, number, title — to jump to;
 *  Back returns. */
function jumpToLabel(view) {
	// In a book, every label of the book (book-map.js): one in another
	// chapter says which, and opens it there.
	const notePath = viewNotePath(view);
	const numbering = numberingFor(view.state.doc, notePath);
	const items = [...numbering.labels].map(([key, t]) => ({
		label: key,
		detail: `${t.status === 'ok' && t.number ? typedRefText(t.type, t.number, true) : 'no number'}${t.title ? ` — ${t.title}` : ''}`
			+ (t.path && t.path !== notePath ? ` · ${bookPlace(t.path)?.chapter ?? t.path}` : ''),
		run: () => {
			if (t.path && t.path !== notePath) { openNoteAtLine(t.path, t.line); return; }
			const from = view.state.doc.lineAt(view.state.selection.main.head).number;
			const tab = workspaceStore.activeTab();
			if (tab) workspaceStore.recordAnchorJump(tab.id, from, t.line, { editor: true });
			const at = view.state.doc.line(Math.min(t.line, view.state.doc.lines)).from;
			view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) });
			view.focus();
		},
	}));
	openListModal({ placeholder: numbering.book ? `Jump to a label in “${numbering.book.title}”…` : 'Jump to a label in this note…', items, emptyText: numbering.book ? 'No labels in this book' : 'No labels in this note' });
}

// ---- the commands ----------------------------------------------------------

/** A command body over the active editor (the note's, or a table cell's). */
const run = (fn, id) => (ctx, args) => {
	const view = activeEditorView();
	if (!view) return;
	// Inside a table cell only inline formatting makes sense: a heading
	// or a list in a cell is not a thing GFM can hold.
	if (view !== activeMainView() && !CELL_SAFE_COMMANDS.has(id)) {
		notice('Not inside a table cell — press Esc to edit the table as source');
		return;
	}
	fn(view, args ?? {});
};

const calloutCommand = (type, label) => ({
	id: `format:callout-${type}`, name: `Insert ${label.toLowerCase()} callout`,
	fn: (v, { fold = '' } = {}) => wrapCallout(v, type, fold),
});

/**
 * The palette's "Insert … callout" commands for the CUSTOM types
 * (renderer/callouts.js calls this after each sync): one per type a
 * definition adds, and a built-in's again under the title a definition
 * gave it (the same id, so a hotkey bound to it stays bound).
 */
const customCalloutIds = new Set();
export function syncCalloutCommands(types) {
	for (const id of customCalloutIds) unregisterCommand(id);
	customCalloutIds.clear();
	for (const [type, { label }] of Object.entries({ ...BUILTIN_CALLOUT_TYPES, ...types })) {
		const { id, name, fn } = calloutCommand(type, label);
		registerCommand({ id, name, when: needsEditor, run: run(fn, id) });
		if (!BUILTIN_CALLOUT_TYPES[type]) customCalloutIds.add(id);
	}
}

export function registerFormatCommands() {
	// Commands that act on the NOTE's editor and the table as a whole.
	const main = (fn) => () => { const view = activeMainView(); if (view) fn(view); };
	const commands = [
		// Inline styles (legacy edit:* ids kept for existing rebindings).
		// Under the vault's normalSyntax the same commands write standard
		// markdown: strong is `**`, italic `*` (the engine's reading there).
		// The usual editor chords (⌘B bold, ⌘I italic, ⌘U underline); the
		// dialect's extra styles on ⌘⇧ + a mnemonic letter; sub/superscript
		// on ⌘⌥↓/↑ (the punctuation chords Word uses — ⌘= — are zoom here,
		// and ⌥ turns punctuation into other characters on a Mac keyboard).
		{ id: 'edit:format-strong', name: 'Format: strong (*text*)', hotkeys: ['Mod-b'], fn: (v) => toggleWrap(v, normalSyntax() ? '**' : '*') },
		{ id: 'edit:format-intense', name: 'Format: intense (**text**)', hotkeys: ['Mod-Shift-b'], fn: (v) => toggleWrap(v, '**') },
		{ id: 'edit:format-italic', name: 'Format: italic (/text/)', hotkeys: ['Mod-i'], fn: (v) => toggleWrap(v, normalSyntax() ? '*' : '/') },
		{ id: 'format:underline', name: 'Format: underline (__text__)', hotkeys: ['Mod-u'], fn: (v) => toggleWrap(v, '__') },
		{ id: 'edit:format-highlight', name: 'Format: highlight (==text==)', hotkeys: ['Mod-Shift-h'], fn: (v) => toggleWrap(v, '==') },
		{ id: 'edit:format-strike', name: 'Format: strikethrough (~text~)', hotkeys: ['Mod-Shift-x'], fn: (v) => toggleWrap(v, '~') },
		{ id: 'format:subscript', name: 'Format: subscript (_{text})', hotkeys: ['Mod-Alt-ArrowDown'], fn: (v) => toggleWrap(v, '_{', '}') },
		{ id: 'format:superscript', name: 'Format: superscript (^{text})', hotkeys: ['Mod-Alt-ArrowUp'], fn: (v) => toggleWrap(v, '^{', '}') },
		{ id: 'edit:format-code', name: 'Format: inline code', hotkeys: ['Mod-Shift-c'], fn: (v) => toggleWrap(v, '`') },
		{ id: 'edit:format-math', name: 'Format: inline math ($x$)', hotkeys: ['Mod-Shift-m'], fn: (v) => toggleWrap(v, '$') },

		// Headings.
		...[1, 2, 3, 4, 5, 6].map((level) => ({
			id: `format:heading-${level}`, name: `Format: heading ${level}`,
			fn: (v) => setHeading(v, level),
		})),
		{ id: 'format:heading-clear', name: 'Format: clear heading', fn: (v) => setHeading(v, 0) },

		// Paragraph.
		{ id: 'format:bullet-list', name: 'Format: bullet list', fn: (v) => toggleLinePrefix(v, 'bullet') },
		{ id: 'format:numbered-list', name: 'Format: numbered list', fn: (v) => toggleLinePrefix(v, 'numbered') },
		{ id: 'format:task-list', name: 'Format: task list', fn: (v) => toggleLinePrefix(v, 'task') },
		{ id: 'format:blockquote', name: 'Format: blockquote', fn: (v) => toggleLinePrefix(v, 'quote') },
		// The engine's description list is `Term:: definition` (description-
		// lists.js); this wrote Pandoc's two-line `Term` / `: definition`,
		// which the engine does not read (the owner's report, 2026-09-27).
		{ id: 'format:description-list', name: 'Insert description list',
			fn: (v) => insertBlock(v, 'Term:: Definition of the term.', 'Term') },
		{ id: 'format:horizontal-rule', name: 'Insert horizontal rule', fn: (v) => insertBlock(v, '---') },

		// Alignment.
		{ id: 'format:align-center', name: 'Format: center (>> text <<)', fn: (v) => toggleAlign(v, 'center') },
		{ id: 'format:align-right', name: 'Format: right-align (>> text)', fn: (v) => toggleAlign(v, 'right') },
		{ id: 'format:align-clear', name: 'Format: clear alignment', fn: (v) => toggleAlign(v, 'clear') },

		// Alerts.
		...['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'].map((type) => ({
			id: `format:alert-${type.toLowerCase()}`, name: `Insert ${type.toLowerCase()} alert`,
			fn: (v) => wrapAlert(v, type),
		})),

		// Tables.
		{ id: 'format:table-2', name: 'Insert table (2×2)', fn: (v) => insertTable(v, 2, 2) },
		{ id: 'format:table-3', name: 'Insert table (3×3)', fn: (v) => insertTable(v, 3, 3) },
		{ id: 'format:table-4', name: 'Insert table (4 rows × 3 columns)', fn: (v) => insertTable(v, 4, 3) },
		{ id: 'format:table-row', name: 'Insert table row below',
			main: (v) => tableOp(v, 'row-below') || insertTableRow(v) },

		// Insert.
		{ id: 'edit:insert-wikilink', name: 'Insert wikilink', hotkeys: ['Mod-k'], fn: (v) => insertWikilink(v) },
		{ id: 'format:footnote', name: 'Insert footnote ([fn: …])',
			fn: (v) => insertInline(v, '[fn: ', ']', 'Footnote text') },
		{ id: 'format:citation', name: 'Insert citation (\\cite{…})',
			fn: (v) => { insertInline(v, '\\cite{', '}'); startCompletion(v); } },
		// Cross-references (§5.13): Clew WRITES the @ forms; the colon twins
		// stay readable and rendered. A reference opens label completion.
		{ id: 'format:label', name: 'Insert label (@label[key])',
			fn: (v) => insertInline(v, '@label[', ']', '') },
		{ id: 'format:reference', name: 'Insert reference (@ref[key])',
			fn: (v) => { insertInline(v, '@ref[', ']', ''); startCompletion(v); } },
		{ id: 'format:cref', name: 'Insert typed reference (@cref[key])',
			fn: (v) => { insertInline(v, '@cref[', ']', ''); startCompletion(v); } },
		{ id: 'format:Cref', name: 'Insert capitalised typed reference (@Cref[key])',
			fn: (v) => { insertInline(v, '@Cref[', ']', ''); startCompletion(v); } },
		{ id: 'format:toc', name: 'Insert table of contents ({{TOC}})', fn: (v) => insertBlock(v, '{{TOC}}') },
		{ id: 'format:today', name: "Insert today's date (:today)", fn: (v) => insertInline(v, ':today', '') },

		// Blocks.
		{ id: 'format:code-fence', name: 'Insert code fence',
			fn: (v) => wrapContainer(v, '```', '```', 'code') },
		{ id: 'format:math-block', name: 'Insert math block ($$…$$)',
			fn: (v) => wrapContainer(v, '$$', '$$', 'e = mc^2') },
		{ id: 'format:mermaid', name: 'Insert mermaid diagram',
			fn: (v) => wrapContainer(v, ':::mermaid', ':::', 'graph LR\n  A --> B') },
		{ id: 'format:tikz', name: 'Insert TiKZ diagram',
			fn: (v) => wrapContainer(v, ':::TiKZ', ':::',
				'\\begin{tikzpicture}\n  \\draw (0,0) -- (1,1);\n\\end{tikzpicture}') },
		{ id: 'format:mathematica', name: 'Insert Mathematica block',
			fn: (v) => wrapContainer(v, ':::Mathematica{output="svg"}', ':::', 'Plot[Sin[x], {x, 0, 2 Pi}]') },
		{ id: 'format:game', name: 'Insert game matrix (:::game)',
			fn: (v) => wrapContainer(v, ':::game', ':::',
				'       | Cooperate | Defect\n-------+-----------+--------\nCooperate | 3, 3   | 0, 5\nDefect    | 5, 0   | 1, 1') },
		{ id: 'format:markdown-demo', name: 'Insert markdown demo block',
			fn: (v) => wrapContainer(v, ':::markdown-demo', ':::', 'This is *some* /text/.') },
		{ id: 'format:tex-block', name: 'Insert LaTeX-only block (:::TeX)',
			fn: (v) => wrapContainer(v, ':::TeX', ':::', '% LaTeX-only content (verbatim)') },
		{ id: 'format:html-block', name: 'Insert HTML-only block (:::HTML)',
			fn: (v) => wrapContainer(v, ':::HTML', ':::', 'Web-only content (markdown processed)') },
		{ id: 'format:abstract', name: 'Insert abstract block',
			fn: (v) => wrapContainer(v, ':::abstract', ':::', 'Abstract text.') },
		{ id: 'format:title-box', name: 'Insert title box',
			fn: (v) => wrapContainer(v, ':::title-box', ':::', 'Title\n***\nBody text.') },
		{ id: 'format:comment', name: 'Insert comment block (omitted from output)',
			fn: (v) => wrapContainer(v, ':::comment', ':::', 'Editorial note.') },
		{ id: 'format:container', name: 'Insert generic container (:::name)',
			fn: (v) => wrapContainer(v, ':::name', ':::', 'Content') },
		// Live edit's toolbar (docs/dev/live-edit.md §6.2); every one
		// works in source mode too. Args come from the toolbar's popovers.
		{ id: 'edit:undo', name: 'Undo', main: (v) => { undo(v); refocus(v); } },
		{ id: 'edit:redo', name: 'Redo', main: (v) => { redo(v); refocus(v); } },
		{ id: 'format:insert-link', name: 'Insert link ([text](url))',
			fn: (v, { url = '', text } = {}) => insertLink(v, url, text) },
		{ id: 'format:insert-attachment', name: 'Insert attachment…', fn: (v) => pickAttachment(v) },
		{ id: 'format:table', name: 'Insert table…',
			fn: (v, { rows = 2, cols = 2 } = {}) => insertTable(v, Math.max(1, rows), Math.max(1, cols)) },
		{ id: 'format:callout', name: 'Insert callout…',
			fn: (v, { type = 'note', fold = '' } = {}) => wrapCallout(v, type, fold) },
		...Object.entries(CALLOUT_TYPES).map(([type, { label }]) => calloutCommand(type, label)),
		{ id: 'format:code-fence-lang', name: 'Insert code fence (language)…',
			fn: (v, { lang = '' } = {}) => wrapContainer(v, '```' + lang, '```', 'code') },
		{ id: 'format:math-env', name: 'Insert math environment…',
			fn: (v, { name = 'equation' } = {}) => wrapContainer(v, `\\begin{${name}}`, `\\end{${name}}`, name === 'align' || name === 'align*' ? 'a &= b \\\\\n  &= c' : 'e = mc^2') },
		{ id: 'format:figure', name: 'Insert figure…',
			fn: (v, { kind = 'mermaid', show = '' } = {}) => insertFigure(v, kind, show) },
		{ id: 'format:env', name: 'Insert environment…',
			fn: (v, { name = 'theorem' } = {}) => wrapEnvironment(v, name) },
		// Tables, whole (docs/dev/live-edit.md §5.5c): in a cell being edited
		// in place, or with the cursor in a table's source.
		{ id: 'format:table-row-above', name: 'Table: insert row above', main: (v) => tableOp(v, 'row-above') },
		{ id: 'format:table-delete-row', name: 'Table: delete row', main: (v) => tableOp(v, 'delete-row') },
		{ id: 'format:table-col-left', name: 'Table: insert column left', main: (v) => tableOp(v, 'col-left') },
		{ id: 'format:table-col-right', name: 'Table: insert column right', main: (v) => tableOp(v, 'col-right') },
		{ id: 'format:table-delete-col', name: 'Table: delete column', main: (v) => tableOp(v, 'delete-col') },
		{ id: 'format:table-move-row-up', name: 'Table: move row up', main: (v) => tableOp(v, 'row-up') },
		{ id: 'format:table-move-row-down', name: 'Table: move row down', main: (v) => tableOp(v, 'row-down') },
		{ id: 'format:table-move-col-left', name: 'Table: move column left', main: (v) => tableOp(v, 'col-move-left') },
		{ id: 'format:table-move-col-right', name: 'Table: move column right', main: (v) => tableOp(v, 'col-move-right') },
		...['left', 'center', 'right', 'none'].map((align) => ({
			id: `format:table-align-${align}`, name: `Table: align column ${align === 'none' ? '(default)' : align}`,
			main: (v) => tableOp(v, `align-${align}`),
		})),
		{ id: 'editor:table-source', name: 'Table: edit as source', main: (v) => leaveCell(v) },
		{ id: 'editor:table-edit-cell', name: 'Table: edit the cell in place', main: (v) => editCellAtCursor(v) },
		// Lists (live edit's toolbar; they work in source mode too).
		{ id: 'format:indent', name: 'Indent list item / lines', fn: (v) => indentMore(v) },
		{ id: 'format:outdent', name: 'Outdent list item / lines', fn: (v) => indentLess(v) },
		{ id: 'editor:toggle-task', name: 'Toggle task checkbox', hotkeys: ['Mod-Enter'], fn: (v) => toggleTask(v) },
		{ id: 'editor:jump-to-label', name: 'Jump to label…', main: (v) => jumpToLabel(v) },
	];

	for (const { id, name, hotkeys, fn, main: onMain } of commands) {
		registerCommand({ id, name, hotkeys, when: needsEditor, run: onMain ? main(onMain) : run(fn, id) });
	}
}
