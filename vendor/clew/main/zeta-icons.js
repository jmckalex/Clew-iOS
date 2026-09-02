// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The LibreOffice icon-theme swap, done to the BYTES we serve rather than
// to a running LibreOffice. The wasm bundle packs its files into one
// soffice.data blob with a JSON metadata of [start, end) offsets — both
// served by our protocol — and it ships only the Colibre theme. The wasm
// build gives no runtime way in: SymbolStyle config is read once at
// startup and never again, and overwriting the packed zip in the
// Emscripten FS mid-boot corrupts a concurrent read (all measured,
// 2026-09-01). So when the vendored Sifr zip is present, the protocol
// serves a soffice.data in which Sifr's bytes REPLACE the Colibre entry,
// with the metadata offsets shifted to match. LibreOffice loads
// "colibre" and draws Sifr. Deterministic, raceless, and undone by
// deleting the vendored zip.
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';

const PACKED_NAME = '/instdir/share/config/images_colibre.zip';

let cache = null; // { key, theme: Buffer|null, meta: {start,end}|null }

/** The splice plan: vendored theme bytes + the Colibre entry's offsets in
 *  the ORIGINAL metadata. Null when the vendored zip is absent (originals
 *  are served untouched) — never throws. */
function plan(iconsDir, zetaDir) {
	const themePath = path.join(iconsDir, 'images_sifr.zip');
	const metaPath = path.join(zetaDir, 'soffice.data.js.metadata');
	let key;
	try {
		key = `${fs.statSync(themePath).mtimeMs}:${fs.statSync(metaPath).mtimeMs}`;
	} catch {
		return null;
	}
	if (cache?.key === key) return cache.plan ? cache : null;
	cache = { key, plan: null };
	try {
		const theme = fs.readFileSync(themePath);
		const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
		const entry = meta.files.find((f) => f.filename === PACKED_NAME);
		if (entry && theme.length > 1024) {
			cache.plan = { theme, start: entry.start, end: entry.end, meta };
		}
	} catch { /* malformed — serve originals */ }
	return cache.plan ? cache : null;
}

/** Adjusted metadata JSON (offsets shifted for the spliced data), or null
 *  to serve the original file. */
export function themedMetadata(iconsDir, zetaDir) {
	const c = plan(iconsDir, zetaDir);
	if (!c) return null;
	const { theme, start, end, meta } = c.plan;
	const delta = theme.length - (end - start);
	const files = meta.files.map((f) => {
		if (f.filename === PACKED_NAME) return { ...f, end: start + theme.length };
		if (f.start >= end) return { ...f, start: f.start + delta, end: f.end + delta };
		return f;
	});
	return JSON.stringify({ ...meta, files, remote_package_size: meta.remote_package_size + delta });
}

/** The splice positions for soffice.data, or null to serve the original. */
export function themedSplice(iconsDir, zetaDir) {
	const c = plan(iconsDir, zetaDir);
	return c ? { start: c.plan.start, end: c.plan.end, theme: c.plan.theme } : null;
}

/** A Transform that replaces byte range [start, end) of the passing
 *  stream with the theme bytes — for the packaged path, where
 *  soffice.data is brotli on disk and decompresses through a pipe. */
export function spliceTransform({ start, end, theme }) {
	let pos = 0;
	let injected = false;
	return new Transform({
		transform(chunk, _enc, cb) {
			const chunkStart = pos;
			const chunkEnd = pos + chunk.length;
			pos = chunkEnd;
			if (chunkEnd <= start) { // wholly before the window
				this.push(chunk);
				return cb();
			}
			if (chunkStart >= end) { // wholly after (inject once on a boundary)
				if (!injected) { injected = true; this.push(theme); }
				this.push(chunk);
				return cb();
			}
			// Overlaps the window: head, one injection, then any tail.
			if (chunkStart < start) this.push(chunk.subarray(0, start - chunkStart));
			if (!injected) { injected = true; this.push(theme); }
			if (chunkEnd > end) this.push(chunk.subarray(end - chunkStart));
			cb();
		},
	});
}
