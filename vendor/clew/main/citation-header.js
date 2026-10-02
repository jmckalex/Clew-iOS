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

/** Each comma-separated file made absolute against `dir` (URLs and absolute paths kept). */
function absolutise(value, dir) {
	return value.split(',').map((part) => {
		const item = unquote(part.trim());
		if (!item || /^[a-z][a-z0-9+.-]*:/i.test(item) || path.isAbsolute(item)) return item;
		return path.resolve(dir, item);
	}).join(', ');
}

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
 * old entry until the note itself changed): its header's `Bibliography`
 * (each comma-separated file, against the note's folder) when it names one,
 * else the vault's bibliography when the note cites anything at all.
 *
 * @param {string} noteText
 * @param {string} noteDir - absolute: the note's folder
 * @param {string} [vaultBib] - absolute: the vault's bibliography, or ''
 * @param {{ pandoc?: boolean }} [options] - pandoc citations on in this vault
 * @returns {string[]} absolute paths (URLs left out)
 */
export function noteBibFiles(noteText, noteDir, vaultBib = '', { pandoc = false } = {}) {
	const named = citationLines(noteText).find((line) => line.key === 'bibliography');
	if (named) {
		return absolutise(named.value, noteDir).split(',').map((p) => p.trim()).filter((p) => path.isAbsolute(p));
	}
	if (!vaultBib) return [];
	return CITES.test(noteText) || (pandoc && PANDOC.test(noteText)) ? [vaultBib] : [];
}
