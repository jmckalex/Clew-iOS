// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Where an export's figures go (the owner's "Outside", 2026-10-06; jmarkdown
// d134995's processFile `cacheDir` / `copyFigures`). An export makes the
// engine render diagrams itself — mermaid, MetaPost, TiKZ, video posters,
// Mathematica — and the engine used to keep them in folders beside the NOTE,
// inside the vault. Now:
//
//   - the CACHE is outside the vault: a trusted vault's under the device's
//     export cache (`<userData>/export-cache/<vault>`), reused by its later
//     exports and capped (pruneExportCache, oldest first); a restricted
//     vault's a temporary folder of the export's own, removed when it ends;
//   - the COPIES — every cached file the output refers to — are the engine's
//     `<output base>-figures/<kind>/`, marked with FIGURES_MARKER, so a kept
//     .tex or .html stands on its own wherever the cache is.
//
// Electron-free, so its rules are unit-tested (tests/export-cache.test.js);
// export.js and export-book.js do the rest.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The cache's ceiling, every vault's together. */
export const EXPORT_CACHE_LIMIT = 500 * 1024 * 1024;

/** The engine's mark on a figures folder it made (jmarkdown figure-cache.js
 *  FIGURES_MARKER — never imported: that module loads the engine's config
 *  manager; a test holds the two equal). */
export const FIGURES_MARKER = '.jmarkdown-figures';

// A figure compiles in a `.run-*` folder of its own inside its kind's folder
// (figure-cache.js compileInRunDir), removed when the compile ends; one older
// than this was left by a worker that died.
const RUN_STALE_MS = 60 * 60 * 1000;

/** The folder the engine copies an output's figures into: `x.tex` → `x-figures`. */
export function figuresFolder(output) {
	return `${output.replace(/\.[^./\\]+$/, '')}-figures`;
}

/** 'none', 'marked' (the engine's: it may go), or 'foreign' (the user's: never touched). */
export function figuresState(dir) {
	if (!fs.existsSync(dir)) return 'none';
	return fs.existsSync(path.join(dir, FIGURES_MARKER)) ? 'marked' : 'foreign';
}

/**
 * The other exports a figures folder may serve: `x.tex` and `x.html` share
 * `x-figures/`, and a book's pages (`x/index.html`) use it too. While one of
 * them is there, the folder is kept — trashed, it would break that file.
 */
export function otherOutputs(output) {
	const stem = output.replace(/\.[^./\\]+$/, '');
	return [`${stem}.tex`, `${stem}.html`, path.join(stem, 'index.html')]
		.filter((p) => path.resolve(p) !== path.resolve(output) && fs.existsSync(p));
}

/** A trusted vault's own folder in the export cache, named by a hash of its identity (vault-trust.js#identityKey). */
export function vaultCacheDir(root, identity) {
	return path.join(root, crypto.createHash('sha256').update(String(identity), 'utf8').digest('hex').slice(0, 16));
}

/**
 * Mark the cached files an export used as used now, so the prune keeps them
 * longest: every copy in its figures folder (`<kind>/<file>`) names one.
 */
export function markUsed(cacheDir, figures, now = Date.now()) {
	const when = new Date(now);
	let kinds = [];
	try { kinds = fs.readdirSync(figures, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return; }
	for (const kind of kinds) {
		let names = [];
		try { names = fs.readdirSync(path.join(figures, kind.name)); } catch { continue; }
		for (const name of names) {
			try { fs.utimesSync(path.join(cacheDir, kind.name, name), when, when); } catch { /* not the cache's */ }
		}
	}
}

/**
 * Keep the export cache under `limit`: the least recently used files go first
 * (their mtime — markUsed's), then any folder left empty. A run folder older
 * than an hour goes whatever the total. Never called while an export runs
 * (export.js), so nothing a build is about to read is removed.
 * @returns {{ removed: number, bytes: number }} files removed, bytes kept
 */
export function pruneExportCache(root, { limit = EXPORT_CACHE_LIMIT, now = Date.now() } = {}) {
	const files = [];
	const dirs = [];
	const walk = (dir) => {
		let entries = [];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name.startsWith('.run-')) {
					try { if (now - fs.statSync(abs).mtimeMs > RUN_STALE_MS) fs.rmSync(abs, { recursive: true, force: true }); } catch { /* gone */ }
					continue;
				}
				dirs.push(abs);
				walk(abs);
			} else if (entry.isFile()) {
				try {
					const st = fs.statSync(abs);
					files.push({ abs, size: st.size, mtimeMs: st.mtimeMs });
				} catch { /* gone */ }
			}
		}
	};
	walk(root);
	let bytes = files.reduce((n, f) => n + f.size, 0);
	let removed = 0;
	if (bytes > limit) {
		files.sort((a, b) => a.mtimeMs - b.mtimeMs);
		for (const f of files) {
			if (bytes <= limit) break;
			try { fs.rmSync(f.abs, { force: true }); bytes -= f.size; removed += 1; } catch { /* kept */ }
		}
	}
	// Deepest first, so a vault's folder empties after its kinds.
	for (const dir of dirs.sort((a, b) => b.length - a.length)) {
		try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch { /* not empty, or gone */ }
	}
	return { removed, bytes };
}

const FOREIGN = /Copy figures: (.+?)\/ was not made by jmarkdown/;

/**
 * The engine's warning about a figures folder that is not its own, said for
 * the reader: where the output's figures are instead, and what to do. Other
 * warnings pass unchanged.
 */
export function explainFiguresWarnings(warnings, { restricted }) {
	return warnings.map((w) => {
		const text = String(w);
		const m = FOREIGN.exec(text);
		if (!m) return w;
		const where = restricted
			? 'they were in a temporary folder this export removed, so its diagrams will not show'
			: 'it refers to Clew\'s export cache on this computer instead, which is pruned, so the file will not travel';
		return `${m[1]}/ beside the export is not one Clew or jmarkdown made, so its figures were not copied there: ${where}. Rename or move ${m[1]}/ and export again.`;
	});
}

// What draws an export's TikZ and MetaPost (jmarkdown 21dee42, figure-engine.js:
// processFile's `figureEngine` / `mpTikzDist`). 'external' is the installed
// tools (lualatex, dvisvgm, mpost, mptopdf), as always; 'auto' is mp-tikz-wasm
// — the preview's own build — with the tools for what it cannot draw; 'wasm'
// the library alone. A TRUSTED vault's exports follow the `exportFigureEngine`
// setting, 'auto' by default since step C (2026-10-11): from jmarkdown
// c82d206 a figure needing a file the library's bundles lack (siunitx, say)
// goes to the tools too, as a font it cannot find already did, so a TeX
// user's figures do not regress; 'external' is the tools alone. A
// RESTRICTED vault's always get 'wasm', whatever the setting: TeX is a
// programming language, and the installed lualatex reads any file this user
// can (measured: `\input{<a file outside the vault>}` in a TikZ node drew that
// file's text into the exported figure), while the library's TeX sees no disk.

/** The values the `exportFigureEngine` setting takes, its default first. */
export const FIGURE_ENGINE_SETTINGS = ['auto', 'external'];

/** The mark a choice of the setting leaves beside it in clew-settings.json. */
export const FIGURE_ENGINE_CHOSEN = 'exportFigureEngineChosen';

/**
 * clew-settings.json as read, with an `exportFigureEngine` nobody chose
 * taken out, so the default applies. Every save writes every key
 * (settings-store.js), so dev.9–11 wrote their default, 'external', into the
 * file at the first vault opened, and a default changed since would never
 * reach that user. A value set from the Settings page carries the mark
 * (SettingsStore#set) and is kept, 'external' included.
 */
export function unpinFigureEngine(stored) {
	if (!stored || typeof stored !== 'object' || stored[FIGURE_ENGINE_CHOSEN] === true || !('exportFigureEngine' in stored)) return stored;
	const { exportFigureEngine, ...rest } = stored;
	return rest;
}

/**
 * The processFile options for an export's figures: `{}` (the installed tools,
 * no option at all) or `{ figureEngine, mpTikzDist }`. `dist` is the staged
 * mp-tikz-wasm (paths.js#mptikzAssets — the build the preview draws with).
 * Only 'external' asks for the tools alone; anything else is the default.
 */
export function figureEngineOptions({ trusted, dist, setting }) {
	if (!trusted) return { figureEngine: 'wasm', mpTikzDist: dist };
	return setting === 'external' ? {} : { figureEngine: 'auto', mpTikzDist: dist };
}

/**
 * The programs the engine runs over a figure's TeX (tikz.js, metapost.js; a
 * test holds this to the vendored sources).
 */
export const TEX_TOOLS = ['lualatex', 'dvisvgm', 'mpost', 'mptopdf'];

/**
 * A folder of stand-ins for TEX_TOOLS that refuse, put FIRST on a restricted
 * export's PATH. Since jmarkdown c82d206 'wasm' never runs the tools on any
 * path — a figure the library does not draw is a `jmd-refused` marker — so
 * these are the SECOND guard: before it, a library that would not load, or a
 * figure that threw in it, went to the installed tools (measured: a dist with
 * no index.js drew the \input above with lualatex). Each refusal leaves its
 * tool's name in `ran.log` beside them, so a run can show none was reached.
 * Only the engine's worker gets them — compilePdf's latexmk is the user's TeX
 * by nature, and a PDF via LaTeX typesets the document's own TeX, its TikZ
 * included. POSIX only: Windows finds programs by extension (.exe), which a
 * script is not — null there, and the PATH unchanged.
 */
export function texRefusalDir(dir, platform = process.platform) {
	if (platform === 'win32') return null;
	fs.mkdirSync(dir, { recursive: true });
	for (const tool of TEX_TOOLS) {
		const file = path.join(dir, tool);
		fs.writeFileSync(file, `#!/bin/sh\necho "${tool}" >> "$(dirname "$0")/ran.log"\necho "${tool} was not run: in a vault this device does not trust, an export's figures are drawn by Clew's built-in TeX only" >&2\nexit 1\n`);
		fs.chmodSync(file, 0o755);
	}
	return dir;
}
