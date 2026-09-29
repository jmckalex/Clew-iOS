// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The app page's side of the caller token (docs/dev/frame-bridge.md §1).
// The window is handed its session's token with its vault (main.js#showVault
// takes it off the vault object before anything stores it); every render
// POST the app makes goes through renderPost, and this module is the page's
// ONE answerer for the preview documents it frames — reading view, live
// block frames, the floating panes, canvas cards — which ask for the token
// the first time they need to POST (preview-client/caller-token.js).
import { answersAsk, PREVIEW_ORIGIN, TOKEN_MESSAGE } from '../../shared/caller-token.js';

let token = null;

/** This window's token, from its own vault's delivery (null: no vault). */
export function setCallerToken(value) {
	token = typeof value === 'string' && value ? value : null;
}

/**
 * POST `fields` to a render endpoint (lib/preview-url.js#fragmentUrl,
 * #blockUrl) with the token. No Content-Type: fetch's text/plain keeps the
 * request simple — a JSON type is preflighted from the iOS app page, and
 * nothing there answers OPTIONS; the server parses the body regardless.
 *
 * @param {string} url
 * @param {Record<string, unknown>} fields
 */
export function renderPost(url, fields) {
	return fetch(url, { method: 'POST', body: JSON.stringify({ ...fields, token }) });
}

// Only this window's own child frames, and only on the preview origin; the
// targetOrigin re-checks at delivery, so a frame that navigated elsewhere in
// the meantime receives nothing.
window.addEventListener('message', (event) => {
	if (!token || !answersAsk(event, window)) return;
	event.source.postMessage({ source: 'clew-preview-host', type: TOKEN_MESSAGE, token }, PREVIEW_ORIGIN);
});
