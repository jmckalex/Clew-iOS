// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The ZetaOffice engine bundle (LibreOffice wasm + zetajs), downloaded on
// demand — the pdf-fonts pattern, with two twists the fonts don't need:
//
// 1. Every file is verified against a SHA256 pin (src/shared/
//    zeta-manifest.json) before it is installed. The CDN has no versioned
//    URLs, so the pins are the only thing standing between the user and a
//    silently newer LibreOffice nobody has measured. A mismatch fails the
//    install; it does not "probably work".
//
// 2. The two big files stay BROTLI-COMPRESSED on disk (~53 MB instead of
//    262 MB), exactly as the CDN serves them: the download uses node's
//    https directly because fetch() would helpfully decompress, and the
//    preview protocol serves `<name>.br` with Content-Encoding: br so
//    Chromium's network stack decompresses in transit. The pins are hashes
//    of the DECOMPRESSED bytes, so verification decompresses in memory
//    first — which also proves the .br file itself is sound.
//
// In dev, paths.zetaAssets is the repo's gitignored zeta-assets/ (plain
// files, pre-installed by hand — see its PROVENANCE.md); download() and
// remove() refuse to touch anything outside userData, so a dev tree can
// never be modified from the settings screen.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const brotliDecompress = promisify(zlib.brotliDecompress);
import { paths } from './paths.js';
import { writeFileAtomic } from './fs-utils.js';
import MANIFEST from '../shared/zeta-manifest.json' with { type: 'json' };

let progress = null; // { done, total, file, received, expected, failed } while downloading
let lastError = null; // why the last download left the engine uninstalled

const dir = () => paths.zetaAssets;
// Writable/removable: userData (the packaged app's home for it) or an
// explicit CLEW_ZETA_DIR override — never the repo's PROVENANCE-pinned dir.
const managed = () => Boolean(process.env.CLEW_ZETA_DIR)
	|| dir().startsWith(app.getPath('userData') + path.sep);

/** The on-disk name a file is present under, or null: plain, else .br. */
function presentAs(file) {
	for (const name of [file.name, file.name + '.br']) {
		try {
			if (fs.statSync(path.join(dir(), name)).size > 1024) return name;
		} catch { /* not this one */ }
	}
	return null;
}

export function status() {
	let bytesOnDisk = 0;
	let present = 0;
	for (const file of MANIFEST.files) {
		const name = presentAs(file);
		if (!name) continue;
		present++;
		try { bytesOnDisk += fs.statSync(path.join(dir(), name)).size; } catch { /* raced */ }
	}
	return {
		installed: present === MANIFEST.files.length,
		downloading: progress !== null,
		progress,
		lastError,
		wireBytes: MANIFEST.wireBytes,
		bytesOnDisk,
		managed: managed(),
	};
}

/** GET raw bytes (no transparent decompression), following redirects. */
function fetchRaw(url, onBytes, redirects = 0) {
	return new Promise((resolve, reject) => {
		https.get(url, { headers: { 'user-agent': 'Clew' } }, (res) => {
			if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 3) {
				res.resume();
				resolve(fetchRaw(new URL(res.headers.location, url).href, onBytes, redirects + 1));
				return;
			}
			if (res.statusCode !== 200) {
				res.resume();
				reject(new Error(`HTTP ${res.statusCode}`));
				return;
			}
			const expected = Number(res.headers['content-length']) || 0;
			const chunks = [];
			let received = 0;
			res.on('data', (chunk) => {
				chunks.push(chunk);
				received += chunk.length;
				onBytes?.(received, expected);
			});
			res.on('end', () => resolve(Buffer.concat(chunks)));
			res.on('error', reject);
		}).on('error', reject);
	});
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Download and verify whatever is missing. Files already on disk are
 * skipped, so an interrupted download resumes. Each file lands under a
 * .part name and is renamed only once its hash matches the pin.
 */
export async function download() {
	if (progress) return status();
	if (!managed()) return status(); // dev tree: hand-installed, never touched
	const missing = MANIFEST.files.filter((file) => !presentAs(file));
	lastError = null;
	progress = { done: 0, total: missing.length, file: null, received: 0, expected: 0, failed: [] };
	try {
		fs.mkdirSync(dir(), { recursive: true });
		for (const file of missing) {
			progress.file = file.name;
			progress.received = 0;
			progress.expected = 0;
			try {
				const raw = await fetchRaw(file.url, (received, expected) => {
					progress.received = received;
					progress.expected = expected;
				});
				// The CDN brotli-compresses the big files unconditionally; hash
				// what the viewer will actually see. Async so the 162 MB
				// decompression never stalls the main process; the default
				// output cap is far too small for it, so size it to the pin.
				const content = file.br
					? await brotliDecompress(raw, { maxOutputLength: file.bytes + 1024 })
					: raw;
				const hash = sha256(content);
				if (hash !== file.sha256) {
					throw new Error(`hash mismatch (got ${hash.slice(0, 12)}…) — the CDN has moved to a build Clew has not verified`);
				}
				const target = path.join(dir(), file.br ? file.name + '.br' : file.name);
				writeFileAtomic(target, raw);
			} catch (err) {
				console.warn(`[clew] office engine download failed (${file.name}):`, err?.message ?? err);
				progress.failed.push({ file: file.name, error: String(err?.message ?? err) });
			}
			progress.done++;
		}
		if (progress.failed.length > 0) {
			lastError = progress.failed
				.map(({ file, error }) => `${file}: ${error}`).join('; ');
		}
	} finally {
		progress = null;
	}
	return status();
}

/** Delete the downloaded engine and reclaim the disk (userData only). */
export function remove() {
	if (managed()) fs.rmSync(dir(), { recursive: true, force: true });
	return status();
}
