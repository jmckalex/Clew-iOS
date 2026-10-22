// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What Clew makes of an export's engine run, on every host: the
// configuration it sets before the build (configureExportBuild — the
// export worker's block until 2026-10-20), where an image embed points from
// the file the export writes (exportEmbedPath — its resolveEmbed's
// arithmetic) and processFile's options for a note (noteExportOptions —
// export.js's list, which changed three times in one week). The desktop's
// export worker (export-worker.mjs, a forked Node) and Clew-iOS's (a page's)
// import them rather than copy them (Clew-iOS's LaTeX exports, U1/U4/U7). No
// fs, no process, node:path alone: the engine's configuration and a realpath
// are handed in (tests/export-config.test.js, tests/shared-export-modules.
// test.js).
import path from 'node:path';
import { latexStyleConfig, headerValues, STYLE_KEYS } from './latex-style.js';
import { obsidianComment, obsidianInlineComment } from './obsidian-comments.js';

/**
 * Clew's own engine rules an export registers, as the preview's generated
 * config loads them (render-service.js `Extensions`): an export runs the
 * user's config cascade, which names none of Clew's. Each host registers them
 * with the engine's registerExtensions (utils.js) after importing the engine
 * and before processFile — so after the engine's own rules, as in the
 * preview, and tried before them. Obsidian's `%%` comments
 * (obsidian-comments.js).
 */
export const EXPORT_EXTENSIONS = Object.freeze([obsidianComment, obsidianInlineComment]);

/**
 * Set an export's configuration on the engine's own configManager, after the
 * user's config files and before processFile.
 *
 * @param {{ get: Function, set: Function, mergeMetadata: Function }} configManager
 *   the engine's (config-manager.js)
 * @param {{ to: 'html'|'latex', latexStyle?: { locale: string, platform: string } | null,
 *   biblify?: Record<string, unknown> | null, defaults?: object }} build
 *   the output; latex-style.js#latexStyleWanted's answer; the vault's Biblify
 *   (shared/citation-files.js#vaultBiblify); the engine's DEFAULT_CONFIG
 */
export function configureExportBuild(configManager, { to, latexStyle = null, biblify = null, defaults = {} } = {}) {
	// A header is a `---`-fenced block, as reading view reads one (render-
	// service.js's generated config, `Header style: fenced`): the engine's
	// own bare-key header took a note's first line `Note: remember this.`
	// as a key and waited for a `---` that never came, and the note
	// exported EMPTY — HTML, LaTeX and a 0-byte PDF, no error (Clew-docs,
	// 2026-10-20). Notes and books alike (book.js reads it for chapters).
	configManager.set('Header style', 'fenced');
	// An HTML export cites as reading view does: the vault's `Biblify`
	// (shared/citation-files.js#vaultBiblify, the object reading view's
	// generated config carries, null when the vault names no file) set over
	// the user's config as the engine merges that later config file over
	// ~/.jmarkdown, key by key: `resolve` on (without it a note citing only
	// the vault's file exported `\cite{key}` as written), the vault's style,
	// a custom .csl's `template`. The note's header is merged later and wins,
	// as in reading view (`Resolve citations: false`, its own `Bibliography
	// style`). The file itself is processFile's `bibliography`
	// (noteExportOptions). HTML only, the output reading view is: in LaTeX the
	// citations are natbib's — `resolve` changes nothing there (measured) —
	// and the style (natbib's numeric for a numeric CSL) stays the user's
	// config's, as before.
	if (to === 'html' && biblify) {
		for (const [key, value] of Object.entries(biblify)) {
			if (key !== 'bibliography') configManager.set(`Biblify.${key}`, value);
		}
	}
	// The title-page directives as LaTeX's own title (jmarkdown's `LaTeX
	// maketitle`, default off — the owner, 2026-10-20: "jmarkdown should
	// write @title[…] and @author[…] and @date[…] … as \title{…} and
	// \author{…} and \date{…} … and then add a \maketitle"; Clew turns it
	// on): every LaTeX build, a note's or a book's, whatever the style
	// setting. A header's `LaTeX maketitle: false` is merged later and wins.
	if (to === 'latex') configManager.set('LaTeX maketitle', true);
	// Clew's LaTeX style (latex-style.js): configuration added to what the
	// user's config files gave the engine at import — decided before the
	// build, and again when the engine merges the document's header
	// (wrapped here: the engine's own parse; a note with no header never
	// merges one), from the config as it was, so the header's `Lang` and
	// `LaTeX engine` decide it and no key the header set is touched. Once,
	// and for the engine's own configuration only: a book's chapter checks
	// merge into TRIAL copies made with Object.create(configManager)
	// (book.js#sameAsBook), which inherit this wrapper — re-deciding from a
	// chapter's one key reset a German book's language to English
	// (measured).
	if (latexStyle && to === 'latex') {
		const user = new Map(['Lang', ...STYLE_KEYS].map((k) => [k, configManager.get(k)]));
		const style = (header) => {
			for (const key of STYLE_KEYS) if (!(key in header)) configManager.set(key, user.get(key));
			const where = { ...latexStyle, defaults, header };
			for (const [key, value] of latexStyleConfig((k) => user.get(k), where)) configManager.set(key, value);
		};
		style({});
		const merge = configManager.mergeMetadata;
		let decided = false;
		configManager.mergeMetadata = function (metadata) {
			const merged = merge.call(this, metadata);
			if (this === configManager && !decided) {
				decided = true;
				style(headerValues(metadata));
			}
			return merged;
		};
	}
}

/**
 * Where an image embed points, as an export writes it: `abs` (the vault file
 * the embed resolved to, clamped already — vault-files.js#resolveFileTarget)
 * RELATIVE to the folder of the file the export writes (processFile's
 * `output`) — never absolute, which would put the user's home folder and
 * vault layout into a .tex or .html they share, and not relative to the note,
 * which only works for an export saved beside it (TeX never searches
 * TEXINPUTS for a `../` path, and the engine copies an image path into HTML as
 * written — measured). For LaTeX both the folder and the image by `realpath`:
 * TeX climbs `..` from its REAL working folder, a browser from the URL it was
 * given, and under a symlinked folder (macOS's /var → /private/var holds every
 * temp folder — `clew export`'s build) the two count differently, so a vault
 * reached through a link (a linked folder, an external volume) gives
 * `../Attachments/…`, not a climb out to the link's own path. In a BOOK
 * (`chapters`) the answer is relative to the CHAPTER the embed is written in
 * (the engine's `file`, jmarkdown 283cd30), and nothing more: the engine reads
 * it as a Markdown image written there and rebases it itself — onto the
 * master's folder, then onto each page's folder (split HTML) or the .tex's
 * (LaTeX), the last between REAL paths (jmarkdown dc36e9b). One mechanism: a
 * correction here as well would be counted twice. No output, or a book's
 * embed with no file named: `abs` itself.
 *
 * @param {{ abs: string, output?: string, to?: string, chapters?: string[],
 *   file?: string, realpath?: (p: string) => string }} o - `realpath` throws
 *   for a path not there yet (taken as given); a host without links passes none
 * @returns {string} with `/` separators
 */
export function exportEmbedPath({ abs, output, to, chapters, file, realpath = (p) => p }) {
	if (!output) return abs;
	if (chapters?.length) {
		if (!file) return abs;   // the engine names no file: nothing to be relative to
		return path.relative(path.dirname(file), abs).split(path.sep).join('/');
	}
	const from = path.dirname(path.resolve(output));
	let wanted = path.relative(from, abs);
	if (to === 'latex') {
		let realFrom = from, realTo = abs;
		try { realFrom = realpath(from); } catch { /* not there yet: as given */ }
		try { realTo = realpath(abs); } catch { /* as resolved */ }
		wanted = path.relative(realFrom, realTo);
	}
	return wanted.split(path.sep).join('/');
}

/**
 * processFile's options for a NOTE's export (export.js; a book's are
 * export-book.js's): its output, the vault's standard-syntax choice (as
 * previews honour it), the vault's bibliography for this build only (jmarkdown
 * 455cb61: an export runs the user's own config cascade, not Clew's generated
 * one, so without it a note citing only the vault's file exported every such
 * citation undefined; a configured file in every respect — a note's own
 * Bibliography adds to it, `Bibliography mode: replace` drops it), the figure
 * cache, the figures copied beside the output, and what draws them.
 *
 * @param {{ format: 'html'|'latex'|'pdf', output: string, vaultSettings?: object,
 *   vaultRoot: string, cacheDir?: string, figureEngine?: object }} o
 */
export function noteExportOptions({ format, output, vaultSettings = {}, vaultRoot, cacheDir, figureEngine = {} }) {
	const vaultBib = String(vaultSettings.bibliography ?? '').trim();
	return {
		to: format === 'html' ? 'html' : 'latex',
		output,
		normalSyntax: vaultSettings.normalSyntax === true,
		bibliography: vaultBib ? [path.resolve(vaultRoot, vaultBib)] : [],
		cacheDir,
		copyFigures: true,
		...figureEngine,
	};
}
