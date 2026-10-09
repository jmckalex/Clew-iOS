// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later


// A note's citation context, for the blocks rendered on its behalf.
//
// A note's header decides how its citations resolve — `Bibliography`,
// `Resolve citations`, `Bibliography style` and the rest of the engine's
// citation keys. Live edit's block frames (and the preview pane, and link
// previews) render a snippet on its own, so they never saw that header: a
// `\cite` in an embedded note stayed raw in a live frame while reading mode
// resolved it (the iOS port's finding, measured on desktop 2026-09-29). This
// returns those keys as a fenced header to put in front of the snippet — the
// bibliography path made absolute, since the header's is relative to the
// note and the snippet renders from a cache folder. Nothing else in the
// header travels: a title or a banner would draw in every frame.
//
// Pure (path only), so tests/citation-header.test.js runs it under node.
import path from 'node:path';
import { citationLines } from '../shared/citation-keys.js';

const unquote = (v) => v.replace(/^(['"])(.*)\1$/, '$2');

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
function absoluteList(value, dir) {
	return bibliographyList(value).map((item) => (isUrl(item) || path.isAbsolute(item) ? item : path.resolve(dir, item)));
}

/** As one header line: the engine reads a comma list as well as a YAML one. */
const absolutise = (value, dir) => absoluteList(value, dir).join(', ');

/**
 * @param {string} noteText - the note's source
 * @param {string} noteDir - absolute: the note's folder
 * @returns {string} `---\n<key>: <value>\n…---\n`, or '' when there is nothing to carry
 */
export function citationHeader(noteText, noteDir) {
	const lines = citationLines(noteText).map(({ key, name, value }) => {
		const file = key === 'bibliography' || (key === 'bibliography style' && /\.csl['"]?$/i.test(value));
		return `${name}: ${file ? absolutise(value, noteDir) : unquote(value)}`;
	});
	return lines.length ? `---\n${lines.join('\n')}\n---\n` : '';
}

/**
 * The citation header a BOOK's citations render under (docs/dev/book-mode.md
 * §4; jmarkdown bibliographies.js#namedFiles, book.js#chapterSettings): every
 * setting is the MASTER's — a chapter's own `Bibliography style` and the rest
 * are warned and not applied — except `Bibliography`, which each chapter may
 * add to: the book has ONE list, the master's files then each chapter's in
 * book order, each against its own folder. A master that says `Bibliography
 * mode: replace` but names no file of its own keeps the configured files
 * (the engine's rule), so the mode is not carried then: the chapters' files
 * would otherwise replace them.
 *
 * @param {{ text: string, dir: string }} master - dir absolute
 * @param {Array<{ text: string, dir: string }>} chapters - in book order
 * @returns {string} as citationHeader
 */
export function bookCitationHeader(master, chapters) {
	const lines = citationLines(master.text);
	const named = lines.find((line) => line.key === 'bibliography');
	const files = [
		...(named ? absoluteList(named.value, master.dir) : []),
		...chapters.flatMap((chapter) => {
			const own = citationLines(chapter.text).find((line) => line.key === 'bibliography');
			return own ? absoluteList(own.value, chapter.dir) : [];
		}),
	].filter((file, i, all) => all.indexOf(file) === i);
	const out = [];
	for (const { key, name, value } of lines) {
		if (key === 'bibliography') {
			if (files.length) out.push(`${name}: ${files.join(', ')}`);
			continue;
		}
		if (key === 'bibliography mode' && !named && value.trim().toLowerCase() === 'replace') continue;
		const file = key === 'bibliography style' && /\.csl['"]?$/i.test(value);
		out.push(`${name}: ${file ? absolutise(value, master.dir) : unquote(value)}`);
	}
	if (!named && files.length) out.push(`Bibliography: ${files.join(', ')}`);
	return out.length ? `---\n${out.join('\n')}\n---\n` : '';
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
