// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// How far up the window's notices must sit so they cover no PDF viewer's
// status chip ("saving…", "not saved — changed elsewhere"), which each viewer
// draws at its own bottom-right corner (pdf-page.html #status). The notices
// are centred at the bottom of the window, so a viewer whose corner is there
// — a PDF tab, the right pane of a split — had its chip hidden by the very
// notice that explains it (Clew-docs' report, 2026-10-04: a conflict's
// "Later"). The chip lives in the viewer's own document, out of the app
// page's reach, so the CORNER is kept clear rather than the chip measured.

/** The corner a viewer's chip may occupy, generously (its text varies). */
export const CHIP_CORNER = { width: 300, height: 40 };
const GAP = 6;

/**
 * @param {{ left: number, right: number, top: number, bottom: number }} notices
 *   the notices column as it sits at its resting `bottom`
 * @param {{ left: number, right: number, bottom: number }[]} viewers each
 *   visible viewer frame's rect
 * @param {number} viewportHeight
 * @param {number} restingBottom the column's CSS `bottom` at rest (px)
 * @returns {number} the `bottom` (px) to give the column: at rest unless it
 *   covers a viewer's corner, else just above the highest corner it covers
 */
export function noticeLift(notices, viewers, viewportHeight, restingBottom) {
	let bottom = restingBottom;
	for (const v of viewers) {
		const corner = {
			left: Math.max(v.left, v.right - CHIP_CORNER.width),
			right: v.right,
			top: v.bottom - CHIP_CORNER.height,
			bottom: v.bottom,
		};
		const apart = notices.right <= corner.left || notices.left >= corner.right
			|| notices.bottom <= corner.top || notices.top >= corner.bottom;
		if (apart) continue;
		bottom = Math.max(bottom, viewportHeight - corner.top + GAP);
	}
	return Math.round(bottom);
}
