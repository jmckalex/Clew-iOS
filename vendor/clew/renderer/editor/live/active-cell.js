// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Which table cell is being edited in place (docs/dev/live-edit.md §5.5c):
// one per note editor, held in the note's own state so every provider sees
// the same answer. `from`/`to` is the cell's text in the NOTE — mapped
// through every change, so typing in the cell (forwarded to the note) grows
// it; a change that deletes the cell clears it.
//
// While a cell is active its table is PINNED concealed (reveal-field.js):
// the note's selection sits inside the cell's text, yet the table stays
// drawn, with the cell editor mounted in that cell.
import { StateField, StateEffect, Annotation, MapMode } from '@codemirror/state';

/** `{ row, col, from, to, tableFrom }` — make this cell the active one. */
export const setActiveCell = StateEffect.define({
	map: (v, mapping) => ({
		...v,
		from: mapping.mapPos(v.from, -1),
		to: mapping.mapPos(v.to, 1),
		tableFrom: mapping.mapPos(v.tableFrom, -1),
	}),
});

/** Stop editing in place (the table reflows and may reveal as source). */
export const clearActiveCell = StateEffect.define();

/** On a note transaction: this came from the cell editor (no echo back). */
export const cellEdit = Annotation.define();

/** On a cell-editor transaction: this is the note re-projected (no forward). */
export const cellSync = Annotation.define();

export const activeCellField = StateField.define({
	create: () => null,
	update(value, tr) {
		let next = value;
		if (next && tr.docChanged) {
			const from = tr.changes.mapPos(next.from, -1, MapMode.TrackDel);
			const to = tr.changes.mapPos(next.to, 1, MapMode.TrackDel);
			const tableFrom = tr.changes.mapPos(next.tableFrom, -1);
			// A change that swallowed the cell's edges (its row deleted, the
			// table rewritten outside the cell editor) ends the edit.
			next = from === null || to === null || from > to ? null : { ...next, from, to, tableFrom };
		}
		for (const e of tr.effects) {
			if (e.is(setActiveCell)) next = { ...e.value };
			else if (e.is(clearActiveCell)) next = null;
		}
		return next;
	},
});

/** The active cell of a state, or null (safe when live edit is off). */
export function activeCellOf(state) {
	return state.field(activeCellField, false) ?? null;
}
