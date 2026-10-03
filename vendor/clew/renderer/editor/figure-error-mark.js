// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The source line a figure's error is about, marked in the editor (the
// owner's report, 2026-10-03). The live preview pane renders the figure the
// cursor is in; when it fails, the pane finds the fence line the error names
// (shared/figure-errors.js) and sets it here: a tint and a bar at the line's
// left edge, the message as its tooltip — a LINE decoration, so nothing
// moves. It goes when the figure renders, or when the cursor leaves it.
//
// The leaving is seen INSIDE an editor update (the pane plugin's), where a
// dispatch is refused — so the pane clears LATER, and names the mark it
// clears: `{ clear: id }` removes mark `id` and nothing newer. (Until
// 2026-10-03 the refused dispatch was swallowed and the mark stayed for
// good — the owner's report.)
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';

/** `{ pos, message, id }` to mark the line holding `pos`; `{ clear: id }`
 *  to remove that mark (only that one); null to remove any. */
export const setFigureError = StateEffect.define();

export const figureErrorField = StateField.define({
	create: () => ({ id: null, marks: Decoration.none }),
	update(value, tr) {
		let { id, marks } = value;
		marks = marks.map(tr.changes);
		for (const e of tr.effects) {
			if (!e.is(setFigureError)) continue;
			if (!e.value) { id = null; marks = Decoration.none; continue; }
			if ('clear' in e.value) {
				if (e.value.clear === id) { id = null; marks = Decoration.none; }
				continue;
			}
			const line = tr.state.doc.lineAt(Math.min(Math.max(0, e.value.pos), tr.state.doc.length));
			id = e.value.id ?? null;
			marks = Decoration.set([Decoration.line({
				class: 'cm-figure-error',
				attributes: { title: e.value.message },
			}).range(line.from)]);
		}
		return marks === value.marks && id === value.id ? value : { id, marks };
	},
	provide: (f) => EditorView.decorations.from(f, (v) => v.marks),
});
