// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The smallest single change that turns one text into another: the common
// prefix and suffix kept, only the middle replaced. A file reloaded from
// disk is applied this way (editor/pool.js), so everything that maps
// positions through the change — the cursor, a table cell being edited in
// place (live/active-cell.js) — survives an edit made somewhere else.

/**
 * @param {string} before
 * @param {string} after
 * @returns {{from: number, to: number, insert: string}|null} null when equal
 */
export function minimalChange(before, after) {
	if (before === after) return null;
	let start = 0;
	const max = Math.min(before.length, after.length);
	while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
	let end = 0;
	while (end < max - start
		&& before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
	return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
}
