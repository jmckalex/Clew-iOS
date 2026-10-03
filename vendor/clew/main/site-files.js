// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What a website export publishes (export-site.js) — the walk, kept apart and
// electron-free so tests/site-files.test.js holds it. What the explorer shows
// goes out, with two kinds of exception besides a vault's `hidden` list:
//
// - Clew's own machinery: `.clew/` (settings, plugins, caches, the workspace),
//   `.obsidian`, `.git`, `node_modules`, `.trash`, every dotfile.
// - STATE, which is private by default (Clew-docs' finding, 2026-10-03: the
//   app fixture's site carried both): `clewdata.json` at the vault root — the
//   Note API's shared state and every app's `app.kv` — and the `data/`
//   folder of every app (a folder holding clew-app.json: `app.files`). A
//   static page has no bridge to read either, so nothing on the site needs
//   them; an app's CODE still goes out with its folder, as any vault file.
//
// The grants (`app-grants.json`), the trust store and the web-PDF cache live
// in userData, never in a vault, so no walk can reach them.
import fs from 'node:fs';
import path from 'node:path';
import { direntKind, shouldRecurse, walkGuard } from './fs-utils.js';
import { insideByRealpath } from '../engine/vault-bounds.js';
import { KV_FILE } from './kv-store.js';
import { MANIFEST, DATA_DIR } from './app-frames.js';

export const NOTE_EXT = /\.(md|jmd)$/i;
const IGNORED = new Set(['.obsidian', '.clew', '.git', 'node_modules', '.trash']);

/**
 * @param {string} vaultRoot
 * @param {{ excludes: { isHidden(rel: string): boolean }, trusted: boolean }} opts
 *   `trusted` false: a link out of the vault is not followed (vault-bounds).
 * @returns {{ notes: string[], files: string[], withheld: string[] }} vault-
 *   relative; `withheld` names what was left out as private state.
 */
export function siteFiles(vaultRoot, { excludes, trusted }) {
	const notes = [];
	const files = [];
	const withheld = [];
	const seen = walkGuard(vaultRoot);
	const walk = (dir, rel) => {
		let entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		const isApp = entries.some((e) => e.name === MANIFEST && direntKind(dir, e) === 'file');
		for (const entry of entries) {
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (excludes.isHidden(childRel)) continue;
			if (entry.name.startsWith('.') || IGNORED.has(entry.name)) continue;
			const abs = path.join(dir, entry.name);
			const kind = direntKind(dir, entry);
			if (!trusted && kind && !insideByRealpath(abs, vaultRoot)) continue;
			if ((!rel && entry.name === KV_FILE && kind === 'file') || (isApp && entry.name === DATA_DIR && kind === 'dir')) {
				withheld.push(childRel);
				continue;
			}
			if (kind === 'dir') {
				if (shouldRecurse(abs, seen)) walk(abs, childRel);
			} else if (kind === 'file') {
				(NOTE_EXT.test(entry.name) ? notes : files).push(childRel);
			}
		}
	};
	walk(vaultRoot, '');
	return { notes, files, withheld };
}

const decodeAttr = (s) => String(s).replace(/&(quot|lt|gt|#39|amp);/g, (_, e) => ({ quot: '"', lt: '<', gt: '>', '#39': "'", amp: '&' })[e]);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * An `@app[…]` in a static page: there is no bridge, no app origin and no
 * grant on a website, so the box says what is there instead of loading
 * anything — the engine's element kept (preview.css sizes and frames it),
 * its label replaced.
 */
export function staticAppEmbeds(html) {
	return html.replace(/<clew-app-embed\b([^>]*)>[\s\S]*?<\/clew-app-embed>/gi, (whole, attrs) => {
		const target = decodeAttr(/\bdata-app="([^"]*)"/.exec(attrs)?.[1] ?? '');
		// Named as the note wrote it (`Apps/Flashcards`).
		return `<clew-app-embed${attrs} data-static="1"><span class="clew-app-label">`
			+ `${escapeHtml(target || 'An app')} — an app that runs inside Clew, not on a website.</span></clew-app-embed>`;
	});
}
