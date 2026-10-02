// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What dist/ was built FROM: a content hash of every file under src/ (all a
// build reads of ours — bundles, copied pages, styles, the engine assets),
// written by scripts/build.js and the dev watcher as dist/build-stamp.json,
// and checked by the smoke harness before a scenario runs (main.js) — a run
// on a dist/ older than the code it is meant to measure measures nothing
// (2026-10-02: Clew-docs read a bundle's timestamp and asked whether an
// "after" came from an interim build). Content, not mtimes: `git stash pop`
// and checkouts rewrite sources in the same second as a build, and a commit
// changes no file time at all. Electron-free; the caller passes the root.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STAMP = path.join('dist', 'build-stamp.json');

/** `src/…` path → sha1 of its content, for every file under src/. */
export function sourceHashes(root) {
	const out = {};
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith('.')) continue;
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(abs);
			else if (entry.isFile()) {
				out[path.relative(root, abs).split(path.sep).join('/')] = crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
			}
		}
	};
	walk(path.join(root, 'src'));
	return out;
}

/** Record the sources dist/ is being built from (call after the build). */
export function writeBuildStamp(root, sources = sourceHashes(root)) {
	fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
	fs.writeFileSync(path.join(root, STAMP), JSON.stringify({ builtAt: new Date().toISOString(), sources }));
}

/**
 * How the sources at `root` differ from what a build was made from.
 *
 * @param {string} root - the checkout whose src/ to read
 * @param {string} [stampFile] - the build's stamp (default: root's own dist/)
 * @returns {{ builtAt: string|null, changed: string[] } | null} changed is
 *   every source edited, added or removed since (sorted, `+`/`-` marking an
 *   added or removed file); null when there is no stamp at all
 */
export function staleSources(root, stampFile = path.join(root, STAMP)) {
	let stamp;
	try {
		stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
	} catch {
		return null;
	}
	const now = sourceHashes(root);
	const then = stamp.sources ?? {};
	const changed = [];
	for (const [file, hash] of Object.entries(now)) {
		if (!(file in then)) changed.push(`+${file}`);
		else if (then[file] !== hash) changed.push(file);
	}
	for (const file of Object.keys(then)) if (!(file in now)) changed.push(`-${file}`);
	return { builtAt: stamp.builtAt ?? null, changed: changed.sort((a, b) => a.replace(/^[+-]/, '').localeCompare(b.replace(/^[+-]/, ''))) };
}
