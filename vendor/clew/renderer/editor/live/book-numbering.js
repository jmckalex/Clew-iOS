// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The numbers a whole BOOK gives each of its pieces while you write
// (docs/dev/book-mode.md §3, D9 — computed, not built). The engine builds a
// book as ONE document: the master's own text first (with host-given
// chapters, all of it before chapter 1 — book.js#prepareBook), then every
// chapter, its `#` title inserted when it has none, numbered in one pass
// (post-processor.js#numberer): per chapter by default ("Figure 2.3", every
// counter restarting at each numbered level-1 heading), or continuously.
// This runs numbering.js's own pass over each piece in that order, carrying
// the counters on, and gathers the labels of the whole book, each with the
// piece it is in. Parity with the built book is ASSERTED by
// smoke/book-parity-scenario.js, never assumed.
//
// Pure (texts in, numbers out) and incremental: a piece is recounted only
// when its text or the state it starts from changed, so a keystroke in one
// chapter recounts that chapter — and the ones after it only when what it
// hands on changed (continuous numbering, or a chapter added).
import { numberPiece, bookMeta, hasTitleHeading, freshState } from './numbering.js';

/**
 * @param {{
 *   master: { path: string, text: string },
 *   chapters: Array<{ path: string, text: string }>,
 *   numbering?: 'per chapter'|'continuous',
 *   numbered?: Map<string, object>,
 * }} book
 * @param {Map<string, object>} [cache] reused across calls (per book)
 * @returns {{
 *   perChapter: boolean,
 *   order: string[],
 *   pieces: Map<string, ReturnType<typeof numberPiece>>,
 *   labels: Map<string, object>,   // key → the label's info + its `path`
 * }}
 */
export function numberBook({ master, chapters, numbering = 'per chapter', numbered = new Map() }, cache = new Map()) {
	const { meta, perChapter } = bookMeta(master.text, numbering);
	const setup = JSON.stringify([meta, perChapter, [...numbered.keys()]]);
	let state = freshState();
	const pieces = new Map();
	const labels = new Map();
	const run = (piece, isChapter) => {
		const start = JSON.stringify(state);
		const hit = cache.get(piece.path);
		let result;
		if (hit && hit.text === piece.text && hit.start === start && hit.setup === setup) {
			result = hit.result;
		} else {
			const insertTitle = isChapter && !hasTitleHeading(piece.text);
			result = numberPiece(piece.text, { numbered, book: { meta, perChapter, state, insertTitle } });
			cache.set(piece.path, { text: piece.text, start, setup, result });
		}
		pieces.set(piece.path, result);
		// The last definition wins, across the book as within a note.
		for (const [key, info] of result.labels) {
			const prev = labels.get(key);
			labels.set(key, { ...info, path: piece.path, count: (prev?.count ?? 0) + info.count });
		}
		state = result.end;
	};
	run(master, false);
	for (const chapter of chapters) run(chapter, true);
	return { perChapter, order: [master.path, ...chapters.map((c) => c.path)], pieces, labels };
}
