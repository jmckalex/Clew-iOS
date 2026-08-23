// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Full-text vault search. Scan-based with an mtime-validated in-memory text
// cache — precise line-level matches with no index to maintain. Fast enough
// for multi-thousand-note vaults with the renderer's debounce in front.
//
// Query syntax (Obsidian-ish):
//   plain terms        AND'd, case-insensitive substring
//   "quoted phrase"    exact substring
//   path:Projects      path filter (substring)
//   file:design        filename filter (substring)
//   tag:#demo / tag:demo   notes carrying the tag (via the indexer)
import fs from 'node:fs';
import path from 'node:path';
import { maskSource } from '../shared/note-metadata.js';

const MAX_RESULTS = 200;
const MAX_MATCHES_PER_FILE = 20;

export class SearchService {
	#vaults;
	#indexer;
	#textCache = new Map(); // relPath -> {mtimeMs, text}
	// namesKey -> Map(relPath -> {mtimeMs, matches}); LRU over name sets so
	// flipping between notes doesn't evict each other's scans.
	#mentionMemo = new Map();

	constructor({ vaults, indexer }) {
		this.#vaults = vaults;
		this.#indexer = indexer;
	}

	#textFor(relPath) {
		const abs = path.join(this.#vaults.root, relPath);
		let stat;
		try { stat = fs.statSync(abs); } catch { return null; }
		const cached = this.#textCache.get(relPath);
		if (cached && cached.mtimeMs === stat.mtimeMs) return cached.text;
		let text;
		try { text = fs.readFileSync(abs, 'utf8'); } catch { return null; }
		this.#textCache.set(relPath, { mtimeMs: stat.mtimeMs, text });
		return text;
	}

	search(query) {
		if (!this.#vaults.isOpen || !query.trim()) return [];
		const { terms, phrases, pathFilters, fileFilters, tagFilters } = parseQuery(query);
		const needles = [...terms, ...phrases].map((s) => s.toLowerCase());

		const results = [];
		for (const relPath of this.#indexer.notes.keys()) {
			if (results.length >= MAX_RESULTS) break;
			const lowerPath = relPath.toLowerCase();
			if (pathFilters.some((f) => !lowerPath.includes(f))) continue;
			const fileName = relPath.split('/').pop().toLowerCase();
			if (fileFilters.some((f) => !fileName.includes(f))) continue;
			if (tagFilters.length) {
				const noteTags = (this.#indexer.notes.get(relPath)?.tags ?? []).map((t) => t.tag.toLowerCase());
				if (tagFilters.some((f) => !noteTags.some((t) => t === f || t.startsWith(f + '/')))) continue;
			}

			// Filters only (no content terms): the file itself is the hit.
			if (needles.length === 0) {
				results.push({ path: relPath, matches: [] });
				continue;
			}

			const text = this.#textFor(relPath);
			if (text === null) continue;
			const lower = text.toLowerCase();
			if (!needles.every((n) => lower.includes(n))) continue;

			// Line-level matches for the first needle-bearing lines.
			const lines = text.split('\n');
			const matches = [];
			for (let i = 0; i < lines.length && matches.length < MAX_MATCHES_PER_FILE; i++) {
				const lineLower = lines[i].toLowerCase();
				const needle = needles.find((n) => lineLower.includes(n));
				if (!needle) continue;
				// Column relative to the trimmed snippet the renderer displays.
				const leading = lines[i].length - lines[i].trimStart().length;
				matches.push({
					line: i + 1,
					column: Math.max(0, lineLower.indexOf(needle) - leading),
					length: needle.length,
					snippet: lines[i].trim().slice(0, 240),
				});
			}
			results.push({ path: relPath, matches });
		}
		return results;
	}

	/**
	 * Unlinked mentions of `targetPath`: occurrences of the note's basename or
	 * aliases in other notes, outside any wikilink. Grouped per source file.
	 */
	unlinkedMentions(targetPath) {
		if (!this.#vaults.isOpen) return [];
		const base = targetPath.split('/').pop().replace(/\.(md|jmd)$/i, '');
		const aliases = this.#indexer.notes.get(targetPath)?.aliases ?? [];
		const names = [base, ...aliases];
		const namesKey = names.join('\u0000').toLowerCase();
		let memo = this.#mentionMemo.get(namesKey);
		if (memo) this.#mentionMemo.delete(namesKey); // LRU: re-insert at back
		else memo = new Map();
		this.#mentionMemo.set(namesKey, memo);
		while (this.#mentionMemo.size > 24) {
			this.#mentionMemo.delete(this.#mentionMemo.keys().next().value);
		}

		const results = [];
		let total = 0;
		for (const relPath of this.#indexer.notes.keys()) {
			if (relPath === targetPath || total >= 100) continue;
			const text = this.#textFor(relPath);
			if (text === null) continue;
			// Per-note memo keyed by content mtime: repeat panel refreshes only
			// re-scan notes that actually changed.
			const mtimeMs = this.#textCache.get(relPath)?.mtimeMs;
			const cached = memo.get(relPath);
			let matches;
			if (cached && cached.mtimeMs === mtimeMs) {
				matches = cached.matches;
			} else {
				const lower = text.toLowerCase();
				matches = names.some((n) => lower.includes(n.toLowerCase()))
					? scanMentions(text, names, 10)
					: [];
				memo.set(relPath, { mtimeMs, matches });
			}
			if (matches.length === 0) continue;
			total += matches.length;
			results.push({ path: relPath, base, matches });
		}
		return results;
	}
}

// ---- unlinked mentions -----------------------------------------------------

const WIKILINK_SPAN_RE = /!?\[\[[^\[\]\n]*\]\]/g;
const HTML_BLOCK_RE = /<(script|style)\b[\s\S]*?<\/\1>/gi;
const isWordChar = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

/**
 * Scan one note's text for word-bounded, case-insensitive occurrences of any
 * of `names` that are NOT already inside a [[wikilink]]. Pure — exported for
 * tests. Returns [{ line, column, length, name, snippet }] with `column`
 * 0-based into the raw line.
 */
export function scanMentions(text, names, maxMatches = 20) {
	const lowered = names
		.map((name) => ({ name, lower: name.toLowerCase() }))
		.filter((n) => n.lower.length > 0);
	if (lowered.length === 0) return [];
	const matches = [];
	// Code is not prose: mask fences/inline code/math (like the link
	// extractor) plus script/style blocks, scanning the masked text while
	// showing snippets from the raw lines.
	const blank = (match) => match.replace(/[^\n]/g, ' ');
	const masked = maskSource(text).replace(HTML_BLOCK_RE, blank);
	const rawLines = text.split('\n');
	const lines = masked.split('\n');
	for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
		const line = lines[i];
		const lineLower = line.toLowerCase();
		// Spans already inside wikilinks don't count as mentions.
		const spans = [];
		WIKILINK_SPAN_RE.lastIndex = 0;
		let span;
		while ((span = WIKILINK_SPAN_RE.exec(line)) !== null) {
			spans.push([span.index, span.index + span[0].length]);
		}
		for (const { name, lower } of lowered) {
			let from = 0;
			let at;
			while ((at = lineLower.indexOf(lower, from)) !== -1 && matches.length < maxMatches) {
				from = at + lower.length;
				if (isWordChar(line[at - 1]) || isWordChar(line[at + lower.length])) continue;
				if (line[at - 1] === '#') continue; // it's a tag
				if (spans.some(([s, e]) => at >= s && at < e)) continue;
				matches.push({
					line: i + 1,
					column: at,
					length: lower.length,
					name,
					snippet: (rawLines[i] ?? '').trim().slice(0, 240),
				});
			}
		}
	}
	return matches;
}

export function parseQuery(query) {
	const phrases = [];
	const rest = query.replace(/"([^"]*)"/g, (_, phrase) => {
		if (phrase) phrases.push(phrase);
		return ' ';
	});
	const terms = [];
	const pathFilters = [];
	const fileFilters = [];
	const tagFilters = [];
	for (const token of rest.split(/\s+/).filter(Boolean)) {
		const lower = token.toLowerCase();
		if (lower.startsWith('path:')) pathFilters.push(lower.slice(5));
		else if (lower.startsWith('file:')) fileFilters.push(lower.slice(5));
		else if (lower.startsWith('tag:')) tagFilters.push(lower.slice(4).replace(/^#/, ''));
		else terms.push(token);
	}
	return { terms, phrases, pathFilters, fileFilters, tagFilters };
}
