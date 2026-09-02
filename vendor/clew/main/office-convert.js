// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The cheap rung under the wasm editor: when DESKTOP LibreOffice is
// installed, an office document can be shown as a PDF (soffice --headless
// --convert-to, cached in .clew/cache) in the EmbedPDF viewer Clew already
// has, and edited externally — no 53 MB download required. Both the
// no-engine fallback and a permanent alternative for people who prefer
// their real LibreOffice.
import { app, shell } from 'electron';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { toolchainPath } from './render-service.js';

const CONVERT_TIMEOUT = 120_000;

/** Where a desktop LibreOffice lives, per platform; null when none found. */
export function findSoffice() {
	const candidates = process.platform === 'darwin'
		? [
			'/Applications/LibreOffice.app/Contents/MacOS/soffice',
			path.join(app.getPath('home'), 'Applications', 'LibreOffice.app', 'Contents', 'MacOS', 'soffice'),
		]
		: process.platform === 'win32'
			? [
				'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
				'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
			]
			: ['/usr/bin/soffice', '/usr/local/bin/soffice', '/snap/bin/libreoffice', '/usr/bin/libreoffice'];
	for (const candidate of candidates) {
		try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
	}
	return null;
}

export const available = () => findSoffice() !== null;

/**
 * Convert one vault office document to PDF in <vault>/.clew/cache/
 * office-pdf/, reusing the cached copy while it is newer than the source.
 * Returns the vault-relative path of the PDF (servable by the preview
 * protocol like any vault file).
 *
 * A private UserInstallation profile keeps headless conversion working
 * even while the user's own LibreOffice is open (the default profile is
 * lock-file guarded, and a running desktop instance would win).
 */
export async function convertToPdf(vaults, rel) {
	const soffice = findSoffice();
	if (!soffice) return { ok: false, reason: 'no-soffice' };
	const abs = vaults.resolve(rel);
	if (!/\.(odt|ods|odp|docx|xlsx|pptx)$/i.test(rel) || !fs.existsSync(abs)) {
		return { ok: false, reason: `not an office document: ${rel}` };
	}

	const key = crypto.createHash('sha1').update(rel).digest('hex').slice(0, 12);
	const outDirRel = path.join('.clew', 'cache', 'office-pdf', key);
	const outDir = path.join(vaults.root, outDirRel);
	const base = path.basename(rel).replace(/\.[^.]+$/, '');
	const pdfAbs = path.join(outDir, base + '.pdf');
	const pdfRel = path.join(outDirRel, base + '.pdf');

	try {
		if (fs.statSync(pdfAbs).mtimeMs >= fs.statSync(abs).mtimeMs) {
			return { ok: true, path: pdfRel, cached: true };
		}
	} catch { /* not cached yet */ }

	fs.mkdirSync(outDir, { recursive: true });
	const profile = path.join(app.getPath('userData'), 'office-convert-profile');
	await new Promise((resolve, reject) => {
		execFile(soffice, [
			`-env:UserInstallation=${String(new URL('file://' + profile))}`,
			'--headless', '--convert-to', 'pdf', '--outdir', outDir, abs,
		], { timeout: CONVERT_TIMEOUT, env: { ...process.env, PATH: toolchainPath() } },
		(err, _stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
	});
	if (!fs.existsSync(pdfAbs)) return { ok: false, reason: 'conversion produced no PDF' };
	return { ok: true, path: pdfRel };
}

/**
 * Hand the document to the desktop: LibreOffice when present, otherwise
 * whatever the OS considers the default app for it.
 */
export function openExternally(vaults, rel) {
	const abs = vaults.resolve(rel);
	if (!/\.(odt|ods|odp|docx|xlsx|pptx)$/i.test(rel) || !fs.existsSync(abs)) {
		throw new Error(`Not an office document: ${rel}`);
	}
	const soffice = findSoffice();
	if (soffice && process.platform === 'darwin') {
		// The binary path is .../LibreOffice.app/Contents/MacOS/soffice —
		// `open -a` on the .app bundle is the citizenly way to focus it.
		const appBundle = soffice.replace(/\/Contents\/MacOS\/soffice$/, '');
		execFile('open', ['-a', appBundle, abs]);
		return 'libreoffice';
	}
	if (soffice) {
		const child = execFile(soffice, [abs]);
		child.unref?.();
		return 'libreoffice';
	}
	shell.openPath(abs);
	return 'default-app';
}
