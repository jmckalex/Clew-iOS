// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The reveal rule, the one idea live edit hangs on: a construct shows its
// SOURCE when any selection range touches it, and is concealed otherwise.
//
// What "touches" means per construct — inline span, its line, the whole
// block, a directive's opener/closer lines — is decided by the model
// (live/model.js, `extents` / `lineExtents`), so this stays a range test and
// the rules live in one place. Boundaries are inclusive: a cursor sitting
// just after `*word*` reveals it, which is what lets the arrow keys walk out
// through the delimiters instead of jumping over them.
//
// Each construct is judged on its own: a revealed outer construct does not
// reveal the ones inside it, nor the other way round.
//
// Pure — no view, no state field (that is the provider's business).

/**
 * Is this construct revealed by these selection ranges?
 *
 * @param {{extents: {from:number,to:number}[], lineExtents: {from:number,to:number}[]}} construct
 * @param {readonly {from: number, to: number}[]} ranges - `state.selection.ranges`
 * @param {'construct'|'line'} [mode] - the `liveReveal` setting: `line`
 *   widens every extent to whole lines.
 * @returns {boolean}
 */
export function revealed(construct, ranges, mode = 'construct') {
	const extents = mode === 'line' ? construct.lineExtents : construct.extents;
	for (const r of ranges) {
		const a = Math.min(r.from, r.to);
		const b = Math.max(r.from, r.to);
		for (const e of extents) {
			if (a <= e.to && b >= e.from) return true;
		}
	}
	return false;
}

/**
 * The revealed set for a model and a selection, with a signature the
 * providers compare to skip rebuilding when the cursor moved but nothing
 * it touches changed.
 *
 * @param {object[]} model - liveModel(state)
 * @param {readonly {from: number, to: number}[]} ranges
 * @param {'construct'|'line'} [mode]
 * @param {string|null} [pinned] - a construct id never revealed (a table
 *   whose cell is being edited in place stays drawn)
 * @returns {{ ids: Set<string>, signature: string }}
 */
export function revealSet(model, ranges, mode = 'construct', pinned = null) {
	const ids = new Set();
	for (const c of model) if (c.id !== pinned && revealed(c, ranges, mode)) ids.add(c.id);
	return { ids, signature: [...ids].join(' ') };
}
