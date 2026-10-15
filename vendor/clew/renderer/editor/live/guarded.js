// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// One construct live edit cannot draw costs that construct, never the note.
// Both decoration providers draw each construct through guarded(): the block
// field (block-field.js), whose throw is its create failing — the whole
// note's live edit gone while the tab still says live, which every note
// holding a table suffered from 8619a67 to 2026-10-15 — and the inline layer
// (inline-layer.js), whose throw loses every mark, chip and line class.

// What failed to draw and has been said (kind + message): a construct that
// throws stays source on every rebuild, and is reported once.
const warned = new Set();

/**
 * Draw one construct `c` with `draw()`. A throw leaves it as SOURCE: each
 * of `lists` (the decorations pushed, ranges claimed) is cut back to where
 * it was, and a console.warn names the construct's kind, once per kind and
 * message.
 */
export function guarded(c, draw, ...lists) {
	const lengths = lists.map((list) => list.length);
	try {
		draw();
	} catch (err) {
		lists.forEach((list, i) => { list.length = lengths[i]; });
		const key = `${c.kind}\u0000${err?.message ?? err}`;
		if (warned.has(key)) return;
		warned.add(key);
		console.warn(`[clew live edit] a ${c.kind} could not be drawn; it shows as source:`, err);
	}
}
