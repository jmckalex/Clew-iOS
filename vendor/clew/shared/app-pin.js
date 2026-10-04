// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Pinning an app within its note — `@app+[Apps/Ticker]{pin=bottom}` or
// `pin=top` (the owner's ask, 2026-10-04: in the note, not a dock across
// notes). It behaves as CSS `position: sticky` would: the app scrolls with
// the note until its place leaves the pane at the pinned edge, then stays
// at that edge while the rest scrolls — a bottom pin while you read ABOVE
// its place, a top pin once you are BELOW it. Its frame never moves in the
// DOM (that would reload it): reading view moves the frame's holder
// (preview-client/app-embed.js), live edit the frame itself
// (editor/live/frame-layer.js), both by style alone, from this one rule.

/** The pin a directive's source asks for — `top`, `bottom` — or null. */
export function pinOf(source) {
	const m = /\{[^}]*?\bpin\s*=\s*["']?(top|bottom)\b/i.exec(String(source ?? ''));
	return m ? m[1].toLowerCase() : null;
}

/**
 * Where a pinned box goes, all in one coordinate frame.
 *
 * @param {{ top: number, height: number, viewTop: number, viewBottom: number,
 *   pin: string|null }} at - the box's own place, and the visible span
 * @returns {{ top: number, stuck: boolean }} its place, or the edge it is
 *   held at (never above the view's top, however tall the box)
 */
export function pinnedTop({ top, height, viewTop, viewBottom, pin }) {
	if (pin === 'top' && top < viewTop) return { top: viewTop, stuck: true };
	if (pin === 'bottom' && top + height > viewBottom) return { top: Math.max(viewTop, viewBottom - height), stuck: true };
	return { top, stuck: false };
}
