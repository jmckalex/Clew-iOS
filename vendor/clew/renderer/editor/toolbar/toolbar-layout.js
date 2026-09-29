// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Which toolbar groups fit, and on which row (plan §6.4; two rows, the
// owner's ask 2026-09-29): pure arithmetic over measured widths, so the
// layout is tested without a window.
//
//   - Rows break at group boundaries, in NATURAL order: a row takes groups
//     left to right while they fit, the first that does not starts the next
//     row, and no later group backfills an earlier row — buttons stay where
//     muscle memory expects them.
//   - The mode switch (an `Infinity` priority, `align: 'end'`) never goes
//     and ends ROW 1, where it sits when there is one row.
//   - Only when `maxRows` rows cannot hold everything do groups go into the
//     `…` menu, by the priority rule (kept highest first, while the rest
//     still pack); the `…` button's width is reserved at the end of the last
//     row only then.
//   - Hysteresis: once on more rows than one, going back to one needs
//     `hysteresis` px of slack, so a width at the threshold cannot flicker.
//   - A group whose `when(state)` is false is not laid out at all — and the
//     ROW COUNT comes from the groups that are always there: a context group
//     (the table tools) fits into those rows or goes into `…`, and never
//     changes the bar's height. Else a caret entering a table would add a
//     row and move the text, and leaving would take it away again.

/**
 * @param {{id: string, priority: number, align?: string, when?: (s: object) => boolean}[]} groups - spec order
 * @param {Record<string, number>} widths - measured width per group id (no separator)
 * @param {number} available - the bar's content width
 * @param {{ state?: object, separator?: number, overflowButton?: number,
 *   maxRows?: number, previousRows?: number, hysteresis?: number }} [options]
 * @returns {{ rows: string[][], visible: string[], overflow: string[] }}
 *   rows in visual order (row 1 ends with the mode switch); visible and
 *   overflow in spec order
 */
export function layoutRows(groups, widths, available, {
	state = {}, separator = 9, overflowButton = 32, maxRows = 2, previousRows = 1, hysteresis = 8,
} = {}) {
	const live = groups.filter((g) => !g.when || g.when(state));
	const always = groups.filter((g) => !g.when).map((g) => g.id);
	const fixed = live.filter((g) => g.priority === Infinity).map((g) => g.id);
	const width = (id) => widths[id] ?? 0;
	const cost = (ids) => ids.reduce((sum, id) => sum + width(id), 0) + Math.max(0, ids.length - 1) * separator;
	const all = live.map((g) => g.id);

	// Coming back from more rows, row 1 keeps the same slack the one-row test
	// asked for — else it would simply take everything again.
	const slack = previousRows > 1 ? hysteresis : 0;

	/** Natural-order rows for `ids`, or null past `rows`; `more` reserves
	 *  the `…` button at the end of the last row. */
	const pack = (ids, rows, more) => {
		const flowing = ids.filter((id) => !fixed.includes(id));
		const tail = (row) => {
			let reserve = row === 0 ? slack + (fixed.length ? cost(fixed) + separator : 0) : 0;
			if (more && row === rows - 1) reserve += overflowButton + separator;
			return reserve;
		};
		const out = [[]];
		for (const id of flowing) {
			const row = out.length - 1;
			if (cost([...out[row], id]) + tail(row) <= available) {
				out[row].push(id);
				continue;
			}
			if (out.length === rows) return null;
			out.push([id]);
			if (width(id) + tail(out.length - 1) > available) return null;
		}
		if (fixed.length && cost([...out[0], ...fixed]) + slack > available) return null;
		out[0].push(...fixed);
		return out.filter((row) => row.length);
	};

	// How many rows: one when the always-there groups fit one — with slack to
	// spare when coming back from more — else as many as allowed.
	const rowCount = cost(always) + slack <= available ? 1 : maxRows;
	// Everything on one row.
	if (rowCount === 1 && cost(all) <= available) {
		return { rows: [all.filter((id) => !fixed.includes(id)).concat(fixed)], visible: all, overflow: [] };
	}
	maxRows = rowCount;
	// Everything on those rows.
	if (maxRows > 1) {
		const rows = pack(all, maxRows, false);
		if (rows) return { rows, visible: all, overflow: [] };
	}
	// Past that, the priority rule: keep the highest while the rest pack.
	const kept = new Set(fixed);
	const byPriority = live.filter((g) => g.priority !== Infinity).sort((a, b) => b.priority - a.priority);
	for (const g of byPriority) {
		const trial = all.filter((id) => kept.has(id) || id === g.id);
		if (pack(trial, maxRows, true)) kept.add(g.id);
	}
	const visible = all.filter((id) => kept.has(id));
	return {
		rows: pack(visible, maxRows, true) ?? [visible],
		visible,
		overflow: all.filter((id) => !kept.has(id)),
	};
}

/** One row only: the layout before two rows (kept for its tests and callers). */
export function layoutGroups(groups, widths, available, { state = {}, separator = 9, overflowButton = 32 } = {}) {
	const { visible, overflow } = layoutRows(groups, widths, available, { state, separator, overflowButton, maxRows: 1 });
	return { visible, overflow };
}
