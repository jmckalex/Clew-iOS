// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Optional CJK fonts for the PDF viewer.
//
// A PDF that uses Chinese, Japanese or Korean text WITHOUT embedding its
// fonts needs the reader to supply them. EmbedPDF's own answer is to fetch
// them from a CDN at render time; ours is not, because a note app should open
// your files on a train. But the four Noto packs are 139 MB — more than the
// rest of Clew put together — so shipping them in every installer to serve
// the minority of users who need them is equally wrong.
//
// So they are a global app setting: off by default, and when switched on the
// files are downloaded ONCE into userData and served locally from then on.
// Nothing is fetched while you read; the network is touched only by an
// explicit choice on the settings screen.
//
// What ships in the app is src/shared/pdf-fonts.json — 2.6 KB naming the 26
// files and their weights, generated from the packages by
// scripts/gen-pdf-fonts.js. That is what lets us download exactly the right
// files without depending on the 139 MB being present at build time.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import MANIFEST from '../shared/pdf-fonts.json' with { type: 'json' };

const CDN = 'https://cdn.jsdelivr.net/npm';

let progress = null; // { done, total, pack, failed } while a download runs

export function fontsDir() {
	return path.join(app.getPath('userData'), 'pdf-fonts');
}

const packDir = (id) => path.join(fontsDir(), id);
const fileFor = (pack, font) => path.join(packDir(pack.id), font.file);

/** Every font present on disk with a plausible size? */
function packInstalled(pack) {
	return pack.fonts.every((font) => {
		try { return fs.statSync(fileFor(pack, font)).size > 1024; } catch { return false; }
	});
}

export function status() {
	const packs = MANIFEST.packs.map((pack) => ({
		id: pack.id,
		label: pack.label,
		bytes: pack.bytes,
		installed: packInstalled(pack),
	}));
	const installed = packs.every((p) => p.installed);
	return {
		installed,
		downloading: progress !== null,
		progress,
		packs,
		totalBytes: MANIFEST.packs.reduce((sum, p) => sum + p.bytes, 0),
		bytesOnDisk: packs.reduce((sum, p, i) => sum + (p.installed ? MANIFEST.packs[i].bytes : 0), 0),
	};
}

/**
 * Fetch whatever is missing. Safe to call again: files already on disk are
 * skipped, so an interrupted download resumes rather than starting over.
 * Each file lands under a .part name and is renamed only once complete, so a
 * kill mid-write can never leave a truncated font that looks installed.
 */
export async function download() {
	if (progress) return status();
	const missing = [];
	for (const pack of MANIFEST.packs) {
		for (const font of pack.fonts) {
			try { if (fs.statSync(fileFor(pack, font)).size > 1024) continue; } catch { /* missing */ }
			missing.push({ pack, font });
		}
	}
	progress = { done: 0, total: missing.length, pack: null, failed: [] };
	try {
		for (const { pack, font } of missing) {
			progress.pack = pack.label;
			const url = `${CDN}/${pack.pkg}@${pack.version}/fonts/${font.file}`;
			try {
				const response = await fetch(url);
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const bytes = Buffer.from(await response.arrayBuffer());
				fs.mkdirSync(packDir(pack.id), { recursive: true });
				const target = fileFor(pack, font);
				const temp = `${target}.part`;
				fs.writeFileSync(temp, bytes);
				fs.renameSync(temp, target);
			} catch (err) {
				console.warn(`[clew] PDF font download failed (${font.file}):`, err?.message ?? err);
				progress.failed.push(font.file);
			}
			progress.done++;
		}
	} finally {
		progress = null;
	}
	return status();
}

/** Delete the downloaded fonts and reclaim the disk. */
export function remove() {
	fs.rmSync(fontsDir(), { recursive: true, force: true });
	return status();
}

/**
 * EmbedPDF's fontFallback config, pointing at our local copies — or null when
 * the setting is off or the files are not all there, which is EmbedPDF's own
 * "no fallback, and no CDN either" value.
 */
export function fallbackConfig(enabled) {
	if (!enabled) return null;
	const fonts = {};
	for (const pack of MANIFEST.packs) {
		if (!packInstalled(pack)) return null;   // all or nothing; a half set renders worse
		fonts[pack.charset] = pack.fonts.map((font) => ({
			url: `/__clew_assets__/pdffonts/${pack.id}/${encodeURIComponent(font.file)}`,
			weight: font.weight,
			italic: font.italic ?? false,
		}));
	}
	return { fonts };
}
