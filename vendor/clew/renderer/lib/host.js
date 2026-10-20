// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What the host the renderer runs in says it is, through `window.clew.host`:
// the desktop app's preload says nothing; Clew-iOS's shim sets
// `{ touchFirst: true }`. Code shared with the iPad offers a touch affordance
// on it alone — the toolbar's Next item (the owner's ask, 2026-10-20: the
// on-screen keyboard has no ⌘) — with no build-time patch, and never on a
// Mac or a Windows touchscreen. Read when asked: the shim sets it before the
// renderer starts, a test never.

/** Whether the host is touch-first (the iPad). */
export function touchFirst() {
	return globalThis.window?.clew?.host?.touchFirst === true;
}
