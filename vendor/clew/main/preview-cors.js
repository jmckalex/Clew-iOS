// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later


// Who may READ a clew-preview:// response from another origin, and which
// callers the render POSTs hear (docs/dev/frame-bridge.md §2.6).
//
// History: everything the protocol served carried `Access-Control-Allow-
// Origin: *` until 2026-09-29, then the allowed origin was ECHOED — the
// preview origin and `null`, because the app page loaded from file:// and so
// WAS null, indistinguishable from a sandboxed frame. Since the app page
// moved to its own origin (`clew-app://app`, phase 2 of the frame bridge,
// 2026-10-02), every response carries that origin as a CONSTANT: only the
// app page can hold it, a constant needs no Vary, and `null` — any
// sandboxed frame a note, a plugin or a remote page creates — reads nothing.
// Preview documents reading preview URLs are same-origin and need no ACAO.
//
// Electron-free, so tests/preview-cors.test.js runs it under plain node.
import { APP_ORIGIN, PREVIEW_ORIGIN } from '../shared/caller-token.js';

/** `response` with the one Access-Control-Allow-Origin it may carry. A new
 *  Response — some are immutable. */
export function narrowCors(response) {
	const headers = new Headers(response.headers);
	headers.set('Access-Control-Allow-Origin', APP_ORIGIN);
	headers.delete('Vary');
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * May a render POST (`__clew_fragment__`, `__clew_block__`) with this Origin
 * run at all? The caller token (§1) is the rule; this is the second layer:
 * the app page, a preview document, or no Origin (this handler sees none on
 * most POSTs, measured). `null` — a sandboxed frame — and anything else
 * (http(s), a future clew-frame app) are refused.
 */
export function renderOriginAllowed(origin) {
	return !origin || origin === APP_ORIGIN || origin === PREVIEW_ORIGIN;
}
