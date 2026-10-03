// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What `clew-app://app/…` serves (docs/dev/frame-bridge.md §2.3): the app
// page's own files — dist/renderer/ and nothing else. Host `app` only; a
// path that leaves the folder, any other host, anything missing → 404. It
// never serves vault content: a root-relative URL in engine HTML injected
// into the app DOM would otherwise land here (canvas/node-content.js and
// canvas/portal.js pin those to the preview origin instead).
//
// The clamp is by normalized path, not realpath: packaged, the folder is
// inside app.asar, whose paths Electron's fs serves but which have no real
// path of their own, and dist/ holds no links.
//
// Electron-free (protocol.js applies it), for tests/app-files.test.js.
import path from 'node:path';

export const APP_HOST = 'app';

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.map': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.woff2': 'font/woff2',
	'.woff': 'font/woff',
	'.ttf': 'font/ttf',
};

/**
 * The file a clew-app URL names, or null (→ 404).
 * @param {string} rendererDir dist/renderer, absolute
 * @param {string} url the request URL
 * @returns {{ file: string, type: string, isPage: boolean } | null}
 */
export function appFileFor(rendererDir, url) {
	let parsed;
	try { parsed = new URL(url); } catch { return null; }
	if (parsed.protocol !== 'clew-app:' || parsed.hostname !== APP_HOST) return null;
	let rel;
	try { rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, ''); } catch { return null; }
	if (rel === '') rel = 'index.html';
	if (rel.includes('\0')) return null;
	const root = path.resolve(rendererDir);
	const file = path.resolve(root, rel);
	if (!file.startsWith(root + path.sep)) return null;
	const type = MIME[path.extname(file).toLowerCase()];
	if (!type) return null;
	return { file, type, isPage: path.basename(file) === 'index.html' && path.dirname(file) === root };
}

/**
 * The app document's CSP as a response HEADER: the policy its own meta tag
 * carries (read from the page itself, so the two cannot drift), plus
 * `frame-ancestors 'none'`, which a meta tag cannot carry — no frame may
 * ever host the app page (§2.3).
 */
export function appPageCsp(html) {
	const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(String(html));
	const policy = (m?.[1] ?? "default-src 'self'").trim().replace(/;\s*$/, '');
	return `${policy}; frame-ancestors 'none'`;
}
