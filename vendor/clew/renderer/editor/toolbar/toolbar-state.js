// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What the toolbar shows for the cursor (plan §6.3): which inline styles
// are on, what kind of block the line is, whether list or table tools apply.
// Pure — from the editor state and the construct model — so it is tested
// without a toolbar.
import { undoDepth, redoDepth } from '@codemirror/commands';

const INLINE = {
	strong: 'strong', intense: 'intense', italic: 'italic', underline: 'underline',
	highlight: 'highlight', strike: 'strike', sub: 'sub', sup: 'sup', code: 'code',
	math: 'math', link: 'link', autolink: 'link', wikilink: 'wikilink', tag: 'tag',
	cite: 'cite', footnote: 'footnote',
};

/**
 * @param {import('@codemirror/state').EditorState} state
 * @param {object[]} model - liveModel(state)
 * @param {{ mode?: string, normalSyntax?: boolean }} [options]
 */
export function deriveState(state, model, { mode = 'source', normalSyntax = false, inCell = false } = {}) {
	const { from, to, head } = state.selection.main;
	const line = state.doc.lineAt(head);
	const contains = (c) => c.from <= from && c.to >= to;
	const smallest = (list) => list.sort((a, b) => (a.to - a.from) - (b.to - b.from))[0] ?? null;

	const inline = new Set();
	for (const c of model) {
		if (c.level === 'inline' && INLINE[c.kind] && contains(c)) inline.add(INLINE[c.kind]);
	}

	const onLine = (c) => c.lineFrom <= line.from && c.lineTo >= line.from;
	const list = smallest(model.filter((c) => ['bullet', 'numbered', 'task'].includes(c.kind) && onLine(c)));
	const env = smallest(model.filter((c) => (c.kind === 'directive' || c.kind === 'environment') && c.from <= head && c.to >= head));
	let blockType = 'paragraph';
	let envName = null;
	const at = (kind) => model.find((c) => c.kind === kind && onLine(c));
	if (at('frontmatter')) blockType = 'frontmatter';
	else if (at('codeFence') || (at('richBlock') && at('richBlock').source === 'fence')) blockType = 'code';
	else if (at('table')) blockType = 'table';
	else if (model.find((c) => c.kind === 'math' && c.level === 'block' && onLine(c))) blockType = 'math';
	else if (at('heading')) blockType = `h${at('heading').depth}`;
	else if (at('callout') || model.find((c) => c.kind === 'quote' && c.callout && onLine(c))) blockType = 'callout';
	else if (at('quote')) blockType = 'quote';
	else if (list) blockType = list.kind;
	else if (at('html')) blockType = 'html';
	else if (env) { blockType = 'env'; envName = env.name || null; }

	return {
		mode,
		normalSyntax,
		canUndo: undoDepth(state) > 0,
		canRedo: redoDepth(state) > 0,
		blockType,
		envName,
		inline,
		inList: Boolean(list),
		listDepth: list?.depth ?? 0,
		inTable: blockType === 'table',
		// A table cell is being edited in place (docs/dev/live-edit.md §5.5c).
		inCell,
		selectionEmpty: from === to,
		multiLine: state.doc.lineAt(from).number !== state.doc.lineAt(to).number,
	};
}
