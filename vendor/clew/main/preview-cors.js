// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later


// Who may READ a clew-preview:// response from another origin (protocol
// hardening, 2026-09-29). Everything the protocol serves used to carry
// `Access-Control-Allow-Origin: *`, so any page that could fetch the scheme
// could read what came back. The legitimate cross-origin readers are few:
//
//   - the preview documents themselves (`clew-preview://vault`) — same
//     origin, so CORS never asks, but listed for the requests that carry an
//     Origin anyway (a same-origin POST does);
//   - the APP page, which loads from file:// and therefore sends
//     `Origin: null`: its render POSTs (live edit's block frames, the preview
//     pane, link previews, canvas cards) and its fetches of preview documents.
//
// Any other origin — an http(s) page framed in a note — now gets no
// Access-Control-Allow-Origin, so its fetch of the scheme cannot be read.
// `null` stays allowed because the app page IS null: telling it apart from
// an opaque sandboxed frame needs more than an origin (see HANDOVER §1).
//
// Electron-free, so tests/preview-cors.test.js runs it under plain node.

export const CORS_READERS = new Set(['clew-preview://vault', 'null']);

/** The Access-Control-Allow-Origin a request with this Origin may get, or null. */
export function allowedOrigin(origin) {
	return origin && CORS_READERS.has(origin) ? origin : null;
}

/**
 * `response` as the request's origin may read it: the allowed origin echoed
 * (with `Vary: Origin`, since the header now depends on it), or no
 * Access-Control-Allow-Origin at all. A new Response — some are immutable.
 */
export function narrowCors(origin, response) {
	const headers = new Headers(response.headers);
	const allowed = allowedOrigin(origin);
	if (allowed) {
		headers.set('Access-Control-Allow-Origin', allowed);
		headers.append('Vary', 'Origin');
	} else {
		headers.delete('Access-Control-Allow-Origin');
	}
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
