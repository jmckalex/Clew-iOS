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
import fs from 'node:fs';
import os from 'node:os';
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

// The same in dev and packaged: both are the DEVICE's, never a vault's.
function trustPaths() {
	return {
		// Which vaults this device trusts to run their notes' code
		// (main/vault-trust.js; docs/dev/frame-bridge.md §4.2).
		vaultTrust: path.join(app.getPath('userData'), 'vault-trust.json'),
		// A restricted vault's exports run from here, not from the note's
		// folder: the engine's config cascade then sees the user's global
		// ~/.jmarkdown and this directory's one key, never a vault's own
		// .jmarkdown/config.json (export.js).
		restrictedExport: path.join(app.getPath('userData'), 'restricted-export'),
		// Web PDFs a note's frames name, fetched by Clew and cached for the
		// whole DEVICE (remote-pdf-cache.js) — never in a vault, whose .clew/
		// travels and could carry a planted copy.
		remotePdfs: path.join(app.getPath('userData'), 'remote-pdfs'),
	};
}

export const paths = app.isPackaged
	? {
		engineWorker: path.join(process.resourcesPath, 'engine', 'jmarkdown', 'src', 'watch-worker.js'),
		engineAssets: path.join(process.resourcesPath, 'engine-assets'),
		previewAssets: path.join(process.resourcesPath, 'preview-assets'),
		// The vendored EmbedPDF OCG build (vendor/embedpdf), not an npm package.
		embedpdfAssets: path.join(process.resourcesPath, 'preview-assets', 'embedpdf'),
		// The staged mp-tikz-wasm build (extraResources), whole: the engines
		// fetch their TeX bundles file by file through kpathsea, so the tree
		// must stay unpacked and complete.
		mptikzAssets: path.join(process.resourcesPath, 'mptikz'),
		// ZetaOffice wasm bundle: downloaded on demand into userData like
		// the CJK PDF fonts (zeta-assets.js owns download/verify/remove).
		zetaAssets: path.join(app.getPath('userData'), 'zeta-assets'),
		// The note's typeface as font files a TeX run can load (main/
		// note-fonts.js): extracted from the machine's own font folder at
		// launch — Apple's and Microsoft's faces cannot ship — into userData.
		noteFonts: path.join(app.getPath('userData'), 'note-fonts'),
		// The bundled demo vault (read-only app payload; main.js copies it
		// into Documents before opening — a vault must be writable).
		demoVault: path.join(process.resourcesPath, 'demo-vault'),
		// Globally installed plugins: written by the USER, never by Clew or
		// by a vault, which is why installing there is a one-time act while
		// enabling stays per-vault (main/plugins.js).
		globalPlugins: path.join(app.getPath('userData'), 'plugins'),
		...trustPaths(),
	}
	: {
		engineWorker: require.resolve('jmarkdown/src/watch-worker.js'),
		engineAssets: path.join(distDir, 'engine'),
		previewAssets: path.join(rootDir, 'node_modules'),
		embedpdfAssets: path.join(rootDir, 'vendor', 'embedpdf', 'dist'),
		// mp-tikz-wasm: MetaPost/pdfTeX/LuaTeX/dvisvgm compiled to wasm, so
		// TikZ and MetaPost figures typeset in the preview with no TeX
		// installation. 74 MB of engines and TeX bundles, so it is neither
		// committed nor bundled: dev prefers the master's own build (always
		// current with work done there), and falls back to the staged copy
		// that packaging ships (scripts/stage-mptikz.js). CLEW_MPTIKZ_DIR
		// overrides both — a machine with neither, or a staging test.
		mptikzAssets: process.env.CLEW_MPTIKZ_DIR
			?? [
				path.join(os.homedir(), 'Source', 'mp-tikz-wasm', 'dist'),
				path.join(rootDir, 'mptikz-assets'),
			].find((dir) => fs.existsSync(dir))
			?? path.join(rootDir, 'mptikz-assets'),
		// CLEW_ZETA_DIR points the office engine somewhere else — a machine
		// without the hand-installed repo bundle, or a download-flow test.
		// The override is also what marks the directory writable/removable
		// (zeta-assets.js#managed): the repo's own zeta-assets/ never is.
		zetaAssets: process.env.CLEW_ZETA_DIR ?? path.join(rootDir, 'zeta-assets'),
		noteFonts: path.join(app.getPath('userData'), 'note-fonts'),
		// In dev the repo's demo-vault IS the working documentation corpus;
		// it opens in place, no copy.
		demoVault: path.join(rootDir, 'demo-vault'),
		// Same userData location in dev, so a plugin installed while
		// developing is the same one the packaged app finds.
		globalPlugins: path.join(app.getPath('userData'), 'plugins'),
		...trustPaths(),
	};
