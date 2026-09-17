// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The identity of the staged TeX engines, so a changed build cannot be served
// stale.
//
// protocol.js serves the mp-tikz-wasm tree (`__clew_assets__/mptikz/`) as
// `Cache-Control: public, max-age=31536000, immutable`, and rightly: it is
// a pinned, read-only build whose wasm Chromium can only code-cache if it is
// allowed to store it, and whose bundle files a figure re-reads by the
// dozen. But the URLs carry no version — the library fetches
// `bundles/<name>/files/<path>` with nothing of the manifest's per-file
// hash in the URL (confirmed with its author) — so when the build behind
// them changes, Chromium keeps answering from its HTTP cache for a year.
// Measured consequence, 2026-09-17: a profile that had rendered against one
// day's master build kept that build's luaotfload.sty after the master was
// rebuilt with the plain-TeX fix, and every plain `font=note` figure kept
// failing in that profile while a fresh one passed. Any restage has the same
// shape — and so does an app upgrade, whose engines arrive at the same URLs.
//
// The remedy is a stamp: the same file identity scripts/stage-mptikz.js uses
// to decide whether the master has changed (mtimes and sizes of the engines
// and the two bundle indexes), plus the app version. main.js compares it
// with the one recorded in userData at every start and, when they differ,
// clears the default session's HTTP cache before any window opens. A clear
// costs nothing that is not refetched anyway; a missing record (first run,
// or an upgrade from a build without this file) clears once too.
//
// Electron-free, like the other main modules with unit tests.
import fs from 'node:fs';
import path from 'node:path';

/** The files whose change means "a different build" — stage-mptikz.js#masterIdentity's list. */
export const STAMP_FILES = ['index.js', 'mplib.wasm', 'tex.wasm', 'dvisvgm.wasm', 'luatex.wasm',
	path.join('bundles', 'index.json'), path.join('bundles', 'hot.json')];

/** A string that changes whenever the staged build or the app does. */
export function assetStamp(assetsDir, appVersion = '') {
	const parts = STAMP_FILES.map((f) => {
		try {
			const st = fs.statSync(path.join(assetsDir, f));
			return `${f}:${Math.round(st.mtimeMs)}:${st.size}`;
		} catch { return `${f}:-`; }
	});
	return `${appVersion}|${parts.join('|')}`;
}

/**
 * Compare the current stamp with the recorded one and record the current.
 * Returns true when the caller should clear the cache — a change, or no
 * record at all.
 */
export function stampChanged(recordFile, stamp) {
	let previous = null;
	try { previous = fs.readFileSync(recordFile, 'utf8'); } catch { /* none yet */ }
	if (previous === stamp) return false;
	fs.mkdirSync(path.dirname(recordFile), { recursive: true });
	fs.writeFileSync(recordFile, stamp);
	return true;
}
