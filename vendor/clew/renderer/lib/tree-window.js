// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * @file The file explorer's windowing arithmetic, kept away from the DOM so
 * it can be tested under plain node (tests/tree-window.test.js).
 *
 * The explorer used to build one row element per visible entry. That is
 * fine until a vault turns out to contain a library: the owner's ph341
 * vault (five presentation folders symlinking one reveal.js tree) rendered
 * 20,503 rows and took 23.5 s to settle, because a vault opened for the
 * first time has nothing collapsed. Windowing makes the cost the size of
 * the VIEWPORT rather than the size of the vault — about forty rows.
 *
 * The tree is drawn as a FLAT list (depth is padding, not nesting), which
 * is what makes this possible at all: a flat list has a row height, and a
 * row height gives an index for any scroll position.
 */

/**
 * The tree as the rows actually drawn, depth-first, skipping the children
 * of collapsed folders — the order the explorer paints and the order the
 * keyboard would walk.
 *
 * @param {Array} entries vaultStore.tree (folders carry `children`)
 * @param {Set<string>} collapsed paths of closed folders
 * @returns {Array<{entry: object, depth: number}>}
 */
export function flattenTree(entries, collapsed = new Set()) {
	const rows = [];
	const walk = (list, depth) => {
		for (const entry of list ?? []) {
			rows.push({ entry, depth });
			if (entry.type === 'folder' && !collapsed.has(entry.path)) walk(entry.children, depth + 1);
		}
	};
	walk(entries, 0);
	return rows;
}

/**
 * Which rows to build for a given scroll position. `overscan` rows are
 * drawn beyond each edge so a flick of the wheel does not show blank
 * space before the next paint.
 *
 * Both ends are clamped to the list, and the range is half-open
 * (`[first, last)`) so `rows.slice(first, last)` is the window.
 */
export function visibleRange({ scrollTop, viewportHeight, rowHeight, total, overscan = 8 }) {
	if (!(rowHeight > 0) || total <= 0) return { first: 0, last: 0 };
	const firstVisible = Math.floor(Math.max(0, scrollTop) / rowHeight);
	const visibleCount = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1;
	const first = Math.max(0, firstVisible - overscan);
	const last = Math.min(total, firstVisible + visibleCount + overscan);
	return { first, last };
}

/**
 * The scrollTop that brings row `index` into view, or null when it already
 * is — used by "Rename…" and by a freshly created note, either of which may
 * name a row that is nowhere near the window.
 */
export function scrollTopFor({ index, scrollTop, viewportHeight, rowHeight }) {
	if (!(rowHeight > 0) || index < 0) return null;
	const top = index * rowHeight;
	const bottom = top + rowHeight;
	if (top < scrollTop) return top;
	if (bottom > scrollTop + viewportHeight) return Math.max(0, bottom - viewportHeight);
	return null;
}
