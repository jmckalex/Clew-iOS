// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The caller token's handshake (docs/dev/frame-bridge.md §1): who may be
// handed the token, and whose answer a document may believe. Pure — the app
// page (renderer/lib/caller-token.js) and every preview document
// (preview-client/caller-token.js) apply the same two rules, on both
// platforms.
//
// The token rides in the render POSTs' bodies; a preview document is never
// SERVED it (its HTML is read too widely for a secret), so it ASKS its
// parent the first time it needs to POST, and a parent answers only a frame
// that is its own child on the preview origin.

/** The one origin a token may be handed to. */
export const PREVIEW_ORIGIN = 'clew-preview://vault';
/** The app page's own origin (frame-bridge.md §2), the same on desktop and
 *  iOS: the one reader every clew-preview:// response grants (§2.6). */
export const APP_ORIGIN = 'clew-app://app';

/** The message type, both ways: the ask and the answer. */
export const TOKEN_MESSAGE = 'caller-token';

/**
 * Whether `self` should answer this message with the token: an ask, from a
 * document on the preview origin that is `self`'s OWN child frame. The parent
 * test reads `source.parent`, which is readable across origins and counts
 * every child browsing context — a DOM query would miss the iframes inside
 * custom elements and shadow roots — and a stale WindowProxy fails it
 * closed. Never `self` itself: a top-level document's parent is itself.
 *
 * @param {{ data: any, origin: string, source: any }} event
 * @param {any} self - the answering window
 */
export function answersAsk(event, self) {
	const { data, origin, source } = event;
	if (data?.source !== 'clew-preview' || data.type !== TOKEN_MESSAGE) return false;
	if (origin !== PREVIEW_ORIGIN || !source || source === self) return false;
	try {
		return source.parent === self;
	} catch {
		return false;
	}
}

/**
 * The token this message hands `self`, or null: an answer, from `self`'s
 * parent — which at the top of a window (the reading-view PDF export's
 * hidden view, which has no host) is `self`, the native side posting it
 * there.
 *
 * @param {{ data: any, source: any }} event
 * @param {any} self - the receiving window
 * @returns {string|null}
 */
export function tokenFrom(event, self) {
	const { data, source } = event;
	if (data?.source !== 'clew-preview-host' || data.type !== TOKEN_MESSAGE) return null;
	if (typeof data.token !== 'string' || !data.token) return null;
	return source && source === self.parent ? data.token : null;
}
