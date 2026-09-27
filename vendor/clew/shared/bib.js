// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Lightweight BibTeX parsing for citation completion: entry keys plus the
// author/editor/title/year fields, no full grammar. Values may be brace- or
// quote-delimited; one level of nested braces is tolerated ({\"o}, {LSE}).

const ENTRY_RE = /@\s*([a-zA-Z]+)\s*\{\s*([^,\s{}]+)\s*,/g;
const FIELD_RE = /(author|editor|title|year|date|file|url|doi)\s*=\s*(?:\{((?:[^{}]|\{[^{}]*\})*)\}|"([^"]*)"|(\d+))/gi;

const stripBraces = (s) => s.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();

/** Family names only, "A, B & C" style, from a BibTeX author field. */
function shortAuthors(field) {
	const names = field.split(/\s+and\s+/i).map((name) => {
		const clean = stripBraces(name).trim();
		if (clean.includes(',')) return clean.split(',')[0].trim();
		const parts = clean.split(/\s+/);
		return parts[parts.length - 1] ?? clean;
	}).filter(Boolean);
	if (names.length === 0) return '';
	if (names.length === 1) return names[0];
	if (names.length === 2) return `${names[0]} & ${names[1]}`;
	return `${names[0]} et al.`;
}

/**
 * @returns {Array<{key, type, authors, title, year, file, url, doi}>}
 *   `file`: the raw BibTeX `file` field (Zotero/JabRef — see bibFilePath)
 */
export function parseBib(text) {
	const entries = [];
	ENTRY_RE.lastIndex = 0;
	let match;
	const starts = [];
	while ((match = ENTRY_RE.exec(text)) !== null) {
		starts.push({ type: match[1].toLowerCase(), key: match[2], index: match.index });
	}
	for (let i = 0; i < starts.length; i++) {
		const { type, key, index } = starts[i];
		if (type === 'comment' || type === 'preamble' || type === 'string') continue;
		const body = text.slice(index, starts[i + 1]?.index ?? text.length);
		const fields = {};
		FIELD_RE.lastIndex = 0;
		let field;
		while ((field = FIELD_RE.exec(body)) !== null) {
			const name = field[1].toLowerCase();
			if (!(name in fields)) fields[name] = field[2] ?? field[3] ?? field[4] ?? '';
		}
		entries.push({
			key,
			type,
			authors: shortAuthors(fields.author ?? fields.editor ?? ''),
			title: stripBraces(fields.title ?? ''),
			year: (fields.year ?? fields.date ?? '').slice(0, 4),
			file: (fields.file ?? '').trim(),
			url: stripBraces(fields.url ?? ''),
			doi: stripBraces(fields.doi ?? '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, ''),
		});
	}
	return entries;
}

/**
 * The path a BibTeX `file` field names. Zotero and JabRef write
 * `Description:path:mime` (`:papers/x.pdf:PDF`), several joined by `;`, with
 * `\:` escaping a colon (Windows drives); a plain path is also common. The
 * first PDF wins, else the first path. Relative paths are the caller's to
 * resolve (against the .bib's folder, then the vault root).
 *
 * @param {string} value
 * @returns {string|null}
 */
export function bibFilePath(value) {
	if (!value) return null;
	const parts = String(value).split(/(?<!\\);/).map((s) => s.trim()).filter(Boolean);
	const paths = parts.map((part) => {
		// Split on UNESCAPED colons: [description, path, mime] when typed.
		const pieces = part.split(/(?<!\\):/);
		const path = pieces.length >= 3 ? pieces.slice(1, -1).join(':') : part;
		return path.replace(/\\:/g, ':').replace(/\\\\/g, '\\').trim();
	}).filter(Boolean);
	return paths.find((p) => /\.pdf$/i.test(p)) ?? paths[0] ?? null;
}
