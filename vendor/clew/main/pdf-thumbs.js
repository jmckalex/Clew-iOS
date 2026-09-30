// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// First-page thumbnails for PDFs shown where a live viewer is too much — a
// portal's miniature of another canvas (docs/dev/pdf-unification.md §2).
// The office-thumbnail arrangement (office-thumbs.js): a MIRRORED cache path
// in the vault, <vault>/.clew/cache/pdf-thumbs/<rel>.png, reused until the
// PDF's mtime moves, jobs strictly one at a time. The picture is drawn by the
// viewer Clew already has — an offscreen window loads pdf-page.html in its
// thumbnail mode and PDFium renders page 1 to a PNG (no screenshot); main
// collects it. PDFium boots in well under a second, so this is cheap enough
// to do on first sight. (iOS answers the same channel natively, with
// QuickLook, at the same path — so a vault synced between them reuses both.)
import { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './fs-utils.js';

const PDF_RE = /\.pdf$/i;
const TIMEOUT = 30_000;
/** The long side of a thumbnail, in pixels. */
export const THUMB_PX = 1024;

export const thumbRel = (rel) => path.join('.clew', 'cache', 'pdf-thumbs', rel + '.png');

/** A cached thumbnail is good while it is at least as new as its PDF. */
export function isFresh(thumbStat, pdfStat) {
	return Boolean(thumbStat && pdfStat && thumbStat.size > 0 && thumbStat.mtimeMs >= pdfStat.mtimeMs);
}

let queue = Promise.resolve();
const inflight = new Map(); // vaultRoot + '\0' + rel → Promise<result>

/**
 * Ensure a fresh thumbnail of one vault PDF's first page. Returns
 * { ok, path (vault-relative), stamp } or { ok: false, reason }.
 */
export function thumbnail(session, rel) {
	if (!PDF_RE.test(rel ?? '')) return Promise.resolve({ ok: false, reason: `not a PDF: ${rel}` });
	let abs;
	try { abs = session.vaults.resolve(rel); } catch (err) { return Promise.resolve({ ok: false, reason: String(err.message) }); }
	let pdfStat;
	try { pdfStat = fs.statSync(abs); } catch { return Promise.resolve({ ok: false, reason: 'missing PDF' }); }
	const outRel = thumbRel(rel);
	const outAbs = path.join(session.vaults.root, outRel);
	let cached = null;
	try { cached = fs.statSync(outAbs); } catch { /* not cached yet */ }
	if (isFresh(cached, pdfStat)) return Promise.resolve({ ok: true, path: outRel, stamp: Math.round(cached.mtimeMs) });
	const key = session.vaults.root + '\0' + rel;
	if (inflight.has(key)) return inflight.get(key);
	const job = queue.then(() => generate(session, rel, outAbs).then(
		(result) => { inflight.delete(key); return result; },
		(err) => {
			inflight.delete(key);
			return { ok: false, reason: String(err?.message ?? err) };
		}));
	inflight.set(key, job);
	queue = job.catch(() => {}); // the chain never breaks
	return job;
}

async function generate(session, rel, outAbs) {
	const encodedRel = rel.split('/').map(encodeURIComponent).join('/');
	const docUrl = `clew-preview://vault/${encodeURIComponent(session.id)}/${encodedRel}`;
	const pageUrl = 'clew-preview://vault/__clew_assets__/clewpdf/pdf-page.html'
		+ `?src=${encodeURIComponent(docUrl)}&thumb=1`;
	const win = new BrowserWindow({
		show: false,
		width: 800,
		height: 1000,
		webPreferences: { offscreen: true, backgroundThrottling: false },
	});
	try {
		await win.loadURL(pageUrl);
		const started = Date.now();
		let base64 = null;
		for (;;) {
			// The page answers null until its document is open; an error says why.
			const answer = await win.webContents.executeJavaScript(
				`window.__clewThumb ? window.__clewThumb(${THUMB_PX}) : null`);
			if (answer?.error) throw new Error(answer.error);
			if (typeof answer?.png === 'string') { base64 = answer.png; break; }
			if (Date.now() - started > TIMEOUT) throw new Error('thumbnail render timed out');
			await new Promise((r) => setTimeout(r, 150));
		}
		const png = Buffer.from(base64, 'base64');
		if (png.length < 256) throw new Error('empty render');
		fs.mkdirSync(path.dirname(outAbs), { recursive: true });
		writeFileAtomic(outAbs, png);
		const stamp = Math.round(fs.statSync(outAbs).mtimeMs);
		return { ok: true, path: thumbRel(rel), stamp };
	} finally {
		win.destroy();
	}
}
