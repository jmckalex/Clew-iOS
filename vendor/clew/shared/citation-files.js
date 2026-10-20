// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later


// Which bibliography files a note's citations draw on, as files: the pure
// half of main/citation-header.js, shared so every host decides alike —
// the vault's `Biblify` (reading view's configuration and an export's), the
// .bib files a note's citations come from (what re-renders it; what a TeX
// without a search path must be handed), and the folders BibTeX searches.
// No Electron, no fs, no process: `node:path` only, which a host without
// Node aliases (Clew-iOS's is posix, as its vault paths are). Tests:
// tests/citation-header.test.js.
import path from 'node:path';
import { citationLines } from './citation-keys.js';

/**
 * A bibliography value as file names — the engine's own reading
 * (bibliographies.js#parseBibliographyList, held to it by a parity test):
 * names separated by commas or new lines, YAML's list dressing (`[…]`,
 * `- `, quotes) taken off. Mirrored, not imported: that module loads the
 * engine's config manager, which never runs in Clew's processes.
 */
export function bibliographyList(value) {
	if (value == null) return [];
	const parts = Array.isArray(value) ? value.flatMap((v) => String(v).split(/[,\n]/)) : String(value).split(/[,\n]/);
	return parts
		.map((part) => part.trim().replace(/^\[|\]$/g, '').trim().replace(/^-\s+/, '').trim().replace(/^(["'])(.*)\1$/, '$2').trim())
		.filter(Boolean);
}

const isUrl = (item) => /^[a-z][a-z0-9+.-]*:/i.test(item);

/** Each listed file made absolute against `dir` (URLs and absolute paths kept). */
export function absoluteList(value, dir) {
	return bibliographyList(value).map((item) => (isUrl(item) || path.isAbsolute(item) ? item : path.resolve(dir, item)));
}

/**
 * The vault's citation settings as the engine's `Biblify` configuration —
 * vault-settings `bibliography` + `bibliographyStyle` — or null when the vault
 * names no bibliography. Reading view's generated config carries it
 * (render-service.js#biblifyConfig), loaded after ~/.jmarkdown and merged over
 * it, the note's header after both; an export is handed the same object
 * (export-worker.mjs), so a note cites alike in both. The files are absolute.
 * A style is one of the engine's named ones (three from
 * @citation-js/plugin-csl, five bundled as CSL files in its csl/ folder), or
 * else a custom .csl file the engine registers by basename (`template`).
 *
 * @param {{ bibliography?: string, bibliographyStyle?: string }} vaultOptions
 * @param {string} vaultRoot - absolute
 * @returns {Record<string, unknown> | null}
 */
export function vaultBiblify(vaultOptions, vaultRoot) {
	const bib = String(vaultOptions?.bibliography ?? '').trim();
	if (!bib) return null;
	const abs = (p) => (path.isAbsolute(p) ? p : path.join(vaultRoot, p));
	const biblify = { 'bibliography': abs(bib), 'resolve': true };
	const style = String(vaultOptions?.bibliographyStyle ?? '').trim();
	if (style) {
		const named = ['apa', 'chicago', 'harvard1', 'vancouver', 'bjps', 'ajp', 'econometrica', 'ergo'];
		if (named.includes(style)) {
			biblify['bibliography style'] = style;
		} else {
			const file = abs(style);
			const name = path.basename(file, '.csl');
			biblify['bibliography style'] = name;
			biblify['template'] = { name, file };
		}
	}
	return biblify;
}

// A citation construct: the LaTeX family (`\cite{`, `\citep[`, `\fullcite{`…)
// or an `@bibliography`; pandoc's `[@key]` / `@key` only where the vault turns
// them on (`@` is otherwise the directive sigil). Over-inclusive on purpose:
// a false positive costs one re-render.
const CITES = /\\[a-z]*cite[a-z]*\*?\s*[[{]|^[ \t]*@bibliography\b/m;
const PANDOC = /\[[^\]\n]*@[\w:./-]|(?:^|[\s(])@[\w:./-]/;

/**
 * The .bib files a note's rendered citations come from — what must re-render
 * its reading view when one of them changes (render-service.js
 * #onFileChanged; before 2026-10-01 nothing did, and reading mode kept the
 * old entry until the note itself changed). Since jmarkdown 909af7a a
 * header's `Bibliography` ADDS to the configured one — here the vault's —
 * unless `Bibliography mode: replace`: so the vault's file (when the note
 * cites anything, or names files of its own) followed by the note's, each
 * against the note's folder; with `replace`, the note's alone.
 *
 * @param {string} noteText
 * @param {string} noteDir - absolute: the note's folder
 * @param {string} [vaultBib] - absolute: the vault's bibliography, or ''
 * @param {{ pandoc?: boolean }} [options] - pandoc citations on in this vault
 * @returns {string[]} absolute paths (URLs left out), configured first
 */
export function noteBibFiles(noteText, noteDir, vaultBib = '', { pandoc = false } = {}) {
	const lines = citationLines(noteText);
	const named = lines.find((line) => line.key === 'bibliography');
	const mode = (lines.find((line) => line.key === 'bibliography mode')?.value ?? '').trim().toLowerCase();
	const own = named ? absoluteList(named.value, noteDir).filter((p) => path.isAbsolute(p)) : [];
	if (own.length && mode === 'replace') return own;
	const cites = own.length > 0 || CITES.test(noteText) || (pandoc && PANDOC.test(noteText));
	const files = vaultBib && cites ? [vaultBib, ...own] : own;
	return files.filter((p, i) => files.indexOf(p) === i);
}

/**
 * Every folder a LaTeX export's bibliographies live in, for BIBINPUTS
 * (export.js#compilePdf): since jmarkdown 909af7a `\bibliography{…}` names
 * EACH file — the note's and the configured ones — by its basename, and
 * bibtex finds a file only on its search path. A note's `../Library/x.bib`
 * was never found there.
 *
 * @param {string} noteText
 * @param {string} noteDir - absolute
 * @param {string[]} configured - absolute paths of the configured files
 * @returns {string[]} folders, the note's first
 */
export function bibliographyDirs(noteText, noteDir, configured = []) {
	const named = citationLines(noteText).find((line) => line.key === 'bibliography');
	const own = named ? absoluteList(named.value, noteDir) : [];
	const dirs = [noteDir, ...[...own, ...configured].filter((p) => path.isAbsolute(p)).map((p) => path.dirname(p))];
	return dirs.filter((d, i) => dirs.indexOf(d) === i);
}
