// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Dev-vs-packaged filesystem locations, decided once. The critical
// constraint: the engine worker is a PLAIN NODE child process — it cannot
// read inside app.asar — so in the packaged app the engine (vendored
// jmarkdown + its staged node_modules), the engine assets it loads
// (template, extensions), and the preview assets served to iframes all live
// unpacked under process.resourcesPath (see the electron-builder
// extraResources config in package.json).
import { app } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const distDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rootDir = path.dirname(distDir);

// CLEW_USER_DATA points the whole app at an alternate userData directory —
// how a fresh install is simulated on a machine that already has a real
// one. It must land before anything derives a path from userData, and this
// module is the earliest (and only import-time) reader.
if (process.env.CLEW_USER_DATA) {
	app.setPath('userData', process.env.CLEW_USER_DATA);
}

export const paths = app.isPackaged
	? {
		engineWorker: path.join(process.resourcesPath, 'engine', 'jmarkdown', 'src', 'watch-worker.js'),
		engineAssets: path.join(process.resourcesPath, 'engine-assets'),
		previewAssets: path.join(process.resourcesPath, 'preview-assets'),
		// The vendored EmbedPDF OCG build (vendor/embedpdf), not an npm package.
		embedpdfAssets: path.join(process.resourcesPath, 'preview-assets', 'embedpdf'),
		// ZetaOffice wasm bundle: downloaded on demand into userData like
		// the CJK PDF fonts (zeta-assets.js owns download/verify/remove).
		zetaAssets: path.join(app.getPath('userData'), 'zeta-assets'),
		// The vendored Sifr icon theme, spliced over the wasm bundle's
		// Colibre at serve time (zeta-icons.js).
		officeIcons: path.join(process.resourcesPath, 'office-icons'),
		// The bundled demo vault (read-only app payload; main.js copies it
		// into Documents before opening — a vault must be writable).
		demoVault: path.join(process.resourcesPath, 'demo-vault'),
	}
	: {
		engineWorker: require.resolve('jmarkdown/src/watch-worker.js'),
		engineAssets: path.join(distDir, 'engine'),
		previewAssets: path.join(rootDir, 'node_modules'),
		embedpdfAssets: path.join(rootDir, 'vendor', 'embedpdf', 'dist'),
		// CLEW_ZETA_DIR points the office engine somewhere else — a machine
		// without the hand-installed repo bundle, or a download-flow test.
		// The override is also what marks the directory writable/removable
		// (zeta-assets.js#managed): the repo's own zeta-assets/ never is.
		zetaAssets: process.env.CLEW_ZETA_DIR ?? path.join(rootDir, 'zeta-assets'),
		officeIcons: path.join(rootDir, 'vendor', 'libreoffice-icons'),
		// In dev the repo's demo-vault IS the working documentation corpus;
		// it opens in place, no copy.
		demoVault: path.join(rootDir, 'demo-vault'),
	};
