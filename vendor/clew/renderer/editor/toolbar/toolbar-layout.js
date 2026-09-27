// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Which toolbar groups fit (plan §6.4): pure arithmetic over measured widths,
// so the overflow behaviour is tested without a window. Groups are added in
// priority order while they fit; an `Infinity` priority (the mode switch)
// never drops; a group whose `when(state)` is false is not laid out at all;
// the overflow button's width is reserved only when something overflows.

/**
 * @param {{id: string, priority: number, when?: (s: object) => boolean}[]} groups - spec order
 * @param {Record<string, number>} widths - measured width per group id
 * @param {number} available - the bar's width
 * @param {{ state?: object, separator?: number, overflowButton?: number }} [options]
 * @returns {{ visible: string[], overflow: string[] }} both in spec order
 */
export function layoutGroups(groups, widths, available, { state = {}, separator = 9, overflowButton = 32 } = {}) {
	const live = groups.filter((g) => !g.when || g.when(state));
	const cost = (ids) => ids.reduce((sum, id) => sum + (widths[id] ?? 0), 0) + Math.max(0, ids.length - 1) * separator;
	const all = live.map((g) => g.id);
	if (cost(all) <= available) return { visible: all, overflow: [] };

	const kept = new Set(live.filter((g) => g.priority === Infinity).map((g) => g.id));
	const budget = available - overflowButton - separator;
	const byPriority = live.filter((g) => g.priority !== Infinity).sort((a, b) => b.priority - a.priority);
	for (const g of byPriority) {
		const trial = [...kept, g.id];
		if (cost(trial) <= budget) kept.add(g.id);
	}
	return {
		visible: all.filter((id) => kept.has(id)),
		overflow: all.filter((id) => !kept.has(id)),
	};
}
