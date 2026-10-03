// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The Content-Security-Policy a preview-origin document is served with
// (docs/dev/frame-bridge.md §4.4, §4.9), as a response HEADER — a document
// cannot remove a header the way it could a meta tag it carries.
//
// Two documents, two rules:
//
//   - A NOTE (rendered notes, live edit's block documents — everything
//     protocol.js#wrapPreviewDocument injects into). In a vault this device
//     has not trusted, `script-src` names only Clew's own script URLs —
//     /__clew_preview__/ (the client, the note API), /__clew_assets__/
//     (MathJax, mermaid, the PDF and TeX engines…), /__clew_plugin_file__/
//     (the user's GLOBAL plugins, served only where enabled) — and, by hash,
//     the inline scripts Clew's own template emits for a note with no code
//     (the MathJax configuration; the hashes come from rendering an empty
//     document, render-service.js#templateScriptHashes). No 'unsafe-inline':
//     a note's <script>, its onclick= attributes and javascript: URLs do not
//     run. `'wasm-unsafe-eval'` because the PDF viewer and the TeX engines
//     compile WebAssembly in the document.
//   - VAULT HTML (any other HTML, SVG or XML document the vault holds — a
//     header-html banner, a vault iframe, a @reveal deck): in a restricted
//     vault `script-src 'none'` — it draws, it does not run.
//
// And the network (§4.9), for both: `connect-src 'self' blob: data:` (no
// fetch, XHR, WebSocket, EventSource or beacon to another host),
// `form-action 'none'` (no form posted off the machine) and `worker-src
// 'self' blob:` (no worker loaded from elsewhere, where none of this would
// apply) — unless the device lets this TRUSTED vault reach the network
// (vault-trust.js `network`), which a vault the device already knew had
// before this existed (§4.8), so nothing changed for it. Left open on
// purpose: images (remote images, map tiles), media, frames (remote
// iframes, @reveal decks, web cards), styles and fonts. The residual, said
// plainly: a script the user trusted can still carry data out in the URL
// of an image or a frame it loads.
//
// Pure: protocol.js applies it; tests/preview-csp.test.js holds it.
import crypto from 'node:crypto';

const ORIGIN = 'clew-preview://vault';

/** The script URLs that are Clew's own, as CSP sources (path prefixes). */
export const CLEW_SCRIPT_SOURCES = Object.freeze([
	`${ORIGIN}/__clew_preview__/`,
	`${ORIGIN}/__clew_assets__/`,
	`${ORIGIN}/__clew_plugin_file__/`,
]);

const NETWORK = ["connect-src 'self' blob: data:", "form-action 'none'", "worker-src 'self' blob:"];

/** `'sha256-…'` sources for the inline scripts (no src) of a document. */
export function inlineScriptHashes(html) {
	const hashes = [];
	const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
	let m;
	while ((m = re.exec(String(html))) !== null) {
		if (/\ssrc\s*=/i.test(m[1] ?? '')) continue;
		const digest = crypto.createHash('sha256').update(m[2], 'utf8').digest('base64');
		const source = `'sha256-${digest}'`;
		if (!hashes.includes(source)) hashes.push(source);
	}
	return hashes;
}

/**
 * @param {object} options
 * @param {'note'|'vault'} options.kind a note document, or other vault HTML
 * @param {boolean} options.trusted does this device trust the vault?
 * @param {boolean} options.network may it reach other hosts (trusted only)?
 * @param {string[]} [options.hashes] the template's own inline scripts
 * @returns {string|null} the header's value; null = no CSP (a trusted vault
 *   with the network on: exactly what it had before)
 */
export function previewCsp({ kind, trusted, network = false, hashes = [] }) {
	const directives = [];
	if (!trusted) {
		directives.push(kind === 'note'
			? ['script-src', ...CLEW_SCRIPT_SOURCES, ...hashes, "'wasm-unsafe-eval'"].join(' ')
			: "script-src 'none'");
	}
	if (!(trusted && network)) directives.push(...NETWORK);
	return directives.length ? directives.join('; ') : null;
}

/** Vault files served as documents that can carry script. */
export function isScriptableDocument(file) {
	return /\.(html?|xhtml|svg|xml)$/i.test(String(file));
}
