// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Who a window listens to (docs/dev/frame-bridge.md §2.8, step 0). Any frame
// in a window can post to `window.top` or to its own parent — a remote page a
// note embeds, a canvas scene's web card — so a listener that acts on a
// message must first ask who sent it, not just what the message says.
//
// - The app page's bridges (PDF, Excalidraw and office saves, the Excalidraw
//   library, file resolution, office thumbnails) act only for a document on
//   the PREVIEW origin: every legitimate sender lives there (the viewer
//   pages under __clew_assets__, and preview documents), and several are
//   NESTED — an office live embed, an Excalidraw or PDF viewer inside a note
//   post to window.top — so "a frame the app created" cannot be the test.
//   A document on the preview origin is vault-authored content, trusted by
//   design; a remote or sandboxed frame is not, and is refused.
// - A document's host messages come from ONE window: its parent (the print
//   view's parent is itself, and main posts there), or, for the bridges'
//   replies, the window the request went to.
import { PREVIEW_ORIGIN, APP_ORIGIN } from './caller-token.js';

export { PREVIEW_ORIGIN, APP_ORIGIN };

/** A message from a document on the preview origin (with a window to answer). */
export function fromPreviewOrigin(event) {
	return event?.origin === PREVIEW_ORIGIN && event.source != null;
}

/** A message from exactly `expected` — the window a document asked, or its parent. */
export function fromWindow(event, expected) {
	return expected != null && event?.source === expected;
}

// Who a window ADDRESSES (§2.8, step 2 — after the app page moved to its
// own origin). Every post used to target '*', forced while the app page was
// `null` (which cannot be a targetOrigin); a message that carries data now
// names the origin it is for, so a frame that has navigated elsewhere in the
// meantime receives nothing:
//   - downward, the app page (and a preview document) addresses its preview
//     frames as PREVIEW_ORIGIN;
//   - upward, a preview document cannot hard-code its parent — the app page,
//     a canvas scene's preview document, or itself in the print view — so it
//     reads it: `location.ancestorOrigins` lists the parent first and the top
//     last (measured on WebKit by the iOS session; Chromium has it too), and
//     is EMPTY at the top, where the "parent" is the document itself;
//   - a reply goes to the asker's own `event.origin`.

/** The origin to address `window.parent` with (the document's own at the
 *  top; '*' where the browser cannot say). */
export function parentOrigin(loc = globalThis.location) {
	const ancestors = loc?.ancestorOrigins;
	if (!ancestors) return '*';
	return ancestors.length ? ancestors[0] : loc.origin;
}

/** The origin to address `window.top` with. */
export function topOrigin(loc = globalThis.location) {
	const ancestors = loc?.ancestorOrigins;
	if (!ancestors) return '*';
	return ancestors.length ? ancestors[ancestors.length - 1] : loc.origin;
}

/**
 * Post `msg` to `target` for `origin` only. An opaque ancestor (`null`) is
 * not a valid targetOrigin and is not a window Clew talks to: nothing is
 * sent. Never throws — a target being torn down is not the sender's error.
 */
export function postTo(target, msg, origin) {
	if (!target || !origin || origin === 'null') return false;
	try {
		target.postMessage(msg, origin);
		return true;
	} catch {
		return false;
	}
}
