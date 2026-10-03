// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// PDF save safety (the owner's ask, 2026-10-03; the notes' write guard,
// main/write-guard.js, extended to annotated PDFs): a viewer's save must
// never overwrite a version of the PDF it did not LOAD — the same PDF
// annotated on another device and synced in, or saved by another viewer of
// it in this window, or by another app.
//
// A viewer names the version it loaded by the SHA-1 of its bytes, computed
// as it opens them (preview-client/pdf-core.js) — so the guard needs nothing
// recorded when the file was served, and a port (Clew-iOS) can keep the same
// viewer code and do this check natively. A save carries that `base`; the
// write goes ahead when the disk still holds it, or already holds exactly
// what is being written; otherwise nothing is written. The disk's hash is
// cached by mtime and size, so an ordinary autosave reads nothing back; the
// cache is refreshed by a FRESH stat after every write (Clew-iOS's lesson:
// a cached pre-write mtime made every second save a false conflict).
//
// Electron-free: tests/pdf-guard.test.js holds it.
import crypto from 'node:crypto';
import fs from 'node:fs';

export const sha1 = (bytes) => crypto.createHash('sha1').update(bytes).digest('hex');

export class PdfGuard {
	/** abs → { mtimeMs, size, hash } as last hashed or written. */
	#known = new Map();

	/** The SHA-1 of the file at `abs`, read only when it changed since last asked. */
	hashOf(abs) {
		const st = fs.statSync(abs);
		const k = this.#known.get(abs);
		if (k && k.mtimeMs === st.mtimeMs && k.size === st.size) return k.hash;
		const hash = sha1(fs.readFileSync(abs));
		this.#known.set(abs, { mtimeMs: st.mtimeMs, size: st.size, hash });
		return hash;
	}

	/**
	 * Before a guarded write of `bytes` by a viewer that loaded `base`:
	 * null to go ahead, or `{ conflict: true, diskHash, mineHash }`. No base
	 * (an older viewer, a caller that cannot say) cannot be judged, and goes
	 * ahead — as every PDF save did before.
	 */
	check(abs, bytes, base) {
		if (!base) return null;
		const disk = this.hashOf(abs);
		if (disk === base) return null;
		const mine = sha1(bytes);
		if (disk === mine) return null;
		return { conflict: true, diskHash: disk, mineHash: mine };
	}

	/** After a write: the file now holds `bytes`, as of a fresh stat. Returns their hash. */
	wrote(abs, bytes) {
		const hash = sha1(bytes);
		try {
			const st = fs.statSync(abs);
			this.#known.set(abs, { mtimeMs: st.mtimeMs, size: st.size, hash });
		} catch {
			this.#known.delete(abs);
		}
		return hash;
	}
}
