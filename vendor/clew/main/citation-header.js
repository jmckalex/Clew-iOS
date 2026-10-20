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
// Pure, so tests/citation-header.test.js runs it under node. The files
// themselves — the vault's Biblify, a note's .bib files, BibTeX's folders —
// are shared/citation-files.js, which every host imports.
import { citationLines } from '../shared/citation-keys.js';
import { absoluteList } from '../shared/citation-files.js';

const unquote = (v) => v.replace(/^(['"])(.*)\1$/, '$2');

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
