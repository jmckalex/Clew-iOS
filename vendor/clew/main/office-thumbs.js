// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Static thumbnails for office-document embeds: an offscreen window boots
// the SAME ZetaOffice page the tabs use — chromeless (&thumb=1) — and one
// capturePage becomes a PNG in <vault>/.clew/cache/office-thumbs/<rel>.png,
// served like any vault file and reused until the document's mtime moves.
//
// A thumbnail costs a full transient LibreOffice boot (~2.5 s, ~1.6 GB
// while it runs), which is exactly why it is cached by mtime and why jobs
// run STRICTLY one at a time: a note with five embeds queues five boots,
// never runs five. The mirrored-path cache key (no hashing) is deliberate —
// read-only surfaces (canvas embed scenes) can construct the URL without
// asking anyone.
import { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { status as engineStatus } from './zeta-assets.js';
import { writeFileAtomic } from './fs-utils.js';

const OFFICE_RE = /\.(odt|ods|odp|docx|xlsx|pptx)$/i;
const BOOT_TIMEOUT = 90_000;

export const thumbRel = (rel) => path.join('.clew', 'cache', 'office-thumbs', rel + '.png');

let queue = Promise.resolve();
const inflight = new Map(); // vaultRoot + '\0' + rel → Promise<result>

/**
 * Ensure a fresh thumbnail for one vault office document. Returns
 * { ok, path (vault-relative), stamp } or { ok:false, reason } — 'no-engine'
 * when the wasm bundle is not installed (the caller shows a card instead).
 */
export function thumbnail(session, rel) {
	if (!OFFICE_RE.test(rel)) return Promise.resolve({ ok: false, reason: `not an office document: ${rel}` });
	let abs;
	try { abs = session.vaults.resolve(rel); } catch (err) { return Promise.resolve({ ok: false, reason: String(err.message) }); }
	let docStat;
	try { docStat = fs.statSync(abs); } catch { return Promise.resolve({ ok: false, reason: 'missing document' }); }

	const outRel = thumbRel(rel);
	const outAbs = path.join(session.vaults.root, outRel);
	try {
		const cached = fs.statSync(outAbs);
		if (cached.mtimeMs >= docStat.mtimeMs && cached.size > 0) {
			return Promise.resolve({ ok: true, path: outRel, stamp: Math.round(cached.mtimeMs) });
		}
	} catch { /* not cached yet */ }

	if (!engineStatus().installed) return Promise.resolve({ ok: false, reason: 'no-engine' });

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
	// Portrait for text documents, landscape for sheets and slides.
	const portrait = /\.(odt|docx)$/i.test(rel);
	const [width, height] = portrait ? [900, 1160] : [1280, 800];
	const encodedRel = rel.split('/').map(encodeURIComponent).join('/');
	const docUrl = `clew-preview://vault/${encodeURIComponent(session.id)}/${encodedRel}`;
	const pageUrl = 'clew-preview://vault/__clew_assets__/clewzeta/zeta-page.html'
		+ `?src=${encodeURIComponent(docUrl)}&thumb=1`;

	const win = new BrowserWindow({
		show: false,
		width,
		height,
		webPreferences: { offscreen: true, backgroundThrottling: false },
	});
	try {
		await win.loadURL(pageUrl);
		const started = Date.now();
		for (;;) {
			const state = await win.webContents.executeJavaScript(
				'window.__zetaReport ? (window.__zetaReport.error ?? window.__zetaReport.tUiReady ?? null) : null');
			if (typeof state === 'string') throw new Error(state);
			if (typeof state === 'number') break;
			if (Date.now() - started > BOOT_TIMEOUT) throw new Error('thumbnail render timed out');
			await new Promise((r) => setTimeout(r, 250));
		}
		// Let LibreOffice finish painting after the chrome hides.
		await new Promise((r) => setTimeout(r, 1200));
		const image = await win.webContents.capturePage();
		const png = image.toPNG();
		if (png.length < 1024) throw new Error('empty capture');
		fs.mkdirSync(path.dirname(outAbs), { recursive: true });
		writeFileAtomic(outAbs, png);
		const stamp = Math.round(fs.statSync(outAbs).mtimeMs);
		return { ok: true, path: thumbRel(rel), stamp };
	} finally {
		win.destroy();
	}
}
