// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Edit-conflict safety, main's half (FEATURE-IDEAS #1; Clew-iOS
// CONFLICT-SAFETY.md item 1): an editor's save must never overwrite a
// version of the note it has not SEEN — another device's edit arriving
// through a sync client, another app's save. The watcher narrows the window
// (a changed file reloads a clean editor, and a dirty one gets the conflict
// banner) but does not close it: an autosave inside its debounce, or one
// that lands before chokidar's awaitWriteFinish settles, wrote over the other
// version unseen.
//
// So the vault remembers, per note, what it last READ or WROTE — the file's
// mtime and a hash of its text — and a guarded write checks the disk first:
// if the mtime moved AND the disk's text is neither what was seen nor what
// is being written, nothing is written and the answer is the disk's text.
// A moved mtime with the same text (a sync client touching the file, the
// same edit on both sides) is no conflict. `force` writes regardless — the
// user chose "keep mine".
//
// The mtime recorded after a write comes from a FRESH stat once the atomic
// rename is done: Clew-iOS recorded a cached, pre-write mtime and raised a
// false conflict on every second save (its integration pass, 2026-10-03).
//
// Electron-free, so tests/write-guard.test.js holds it.
import crypto from 'node:crypto';
import fs from 'node:fs';

/** Vault state is never guarded: Clew's own files and the Note API's store. */
export function guardable(rel) {
	const r = String(rel ?? '').replace(/\\/g, '/');
	return !(r === '.clew' || r.startsWith('.clew/') || r === 'clewdata.json');
}

const hashOf = (text) => crypto.createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex');

export class WriteGuard {
	/** rel → { mtimeMs, hash } as last read or written. */
	#seen = new Map();

	/**
	 * Read a note and remember what was read: the mtime from before AND
	 * after the read must agree, or a write in between would be remembered
	 * against the old text (read again, a few times, then give up and
	 * remember nothing — the next guarded write then cannot judge, and writes).
	 */
	read(rel, abs) {
		for (let attempt = 0; attempt < 3; attempt++) {
			const before = fs.statSync(abs).mtimeMs;
			const text = fs.readFileSync(abs, 'utf8');
			const after = fs.statSync(abs).mtimeMs;
			if (before === after) {
				this.#seen.set(rel, { mtimeMs: after, hash: hashOf(text) });
				return text;
			}
		}
		this.#seen.delete(rel);
		return fs.readFileSync(abs, 'utf8');
	}

	/**
	 * Before a guarded write: null to go ahead, or `{ conflict: true, disk }`.
	 * A note never read in this session cannot be judged, and goes ahead.
	 */
	check(rel, abs, content) {
		if (!guardable(rel)) return null;
		const seen = this.#seen.get(rel);
		if (!seen) return null;
		let mtimeMs;
		try { mtimeMs = fs.statSync(abs).mtimeMs; } catch { return null; /* gone: a write recreates it */ }
		if (mtimeMs === seen.mtimeMs) return null;
		const disk = fs.readFileSync(abs, 'utf8');
		const hash = hashOf(disk);
		if (hash === seen.hash || disk === content) {
			// Touched, or the same edit on both sides: no conflict — and now seen.
			this.#seen.set(rel, { mtimeMs, hash });
			return null;
		}
		return { conflict: true, disk };
	}

	/** After a write: what is on disk now is what was written, as of a fresh stat. */
	wrote(rel, abs, content) {
		try {
			this.#seen.set(rel, { mtimeMs: fs.statSync(abs).mtimeMs, hash: hashOf(content) });
		} catch {
			this.#seen.delete(rel);
		}
	}

	/** A rename or delete: what was seen at the old path is not at the new one. */
	forget(rel) {
		for (const key of [...this.#seen.keys()]) {
			if (key === rel || key.startsWith(`${rel}/`)) this.#seen.delete(key);
		}
	}

	clear() {
		this.#seen.clear();
	}
}
