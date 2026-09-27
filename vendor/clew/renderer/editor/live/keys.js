// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// ArrowUp / ArrowDown INTO a block widget (docs/dev/live-edit.md §5.9).
// CodeMirror's vertical motion treats a block replacement — display maths,
// a diagram's frame, a table, a rule — as one unit and carries the cursor
// clean past it, so a drawn block could be reached only by the mouse
// (measured: ArrowUp from below a `$$` block landed on the line above it).
// Obsidian walks in, and so does this: when the motion would cross a block
// replacement, the cursor stops at its near edge instead, the construct
// reveals, and the next arrow moves through its source.
import { keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { blockField } from './block-field.js';

/**
 * @param {import('@codemirror/view').EditorView} view
 * @param {boolean} forward - down (true) or up
 */
function intoBlock(view, forward) {
	const { state } = view;
	const sel = state.selection;
	if (sel.ranges.length > 1 || !sel.main.empty) return false;
	const head = sel.main.head;
	const target = view.moveVertically(sel.main, forward).head;
	if (forward ? target <= head : target >= head) return false;
	const line = state.doc.lineAt(head);
	let edge = null;
	state.field(blockField).deco.between(forward ? line.to : target, forward ? target : line.from, (from, to, deco) => {
		if (!deco.spec.block) return;
		// Down: the first block below this line; up: the last one above it.
		if (forward && from > line.to && (edge === null || from < edge)) edge = from;
		if (!forward && to < line.from && (edge === null || to > edge)) edge = to;
	});
	if (edge === null) return false;
	view.dispatch({ selection: { anchor: edge }, scrollIntoView: true, userEvent: 'select' });
	return true;
}

export const liveKeys = Prec.high(keymap.of([
	{ key: 'ArrowDown', run: (view) => intoBlock(view, true) },
	{ key: 'ArrowUp', run: (view) => intoBlock(view, false) },
]));
