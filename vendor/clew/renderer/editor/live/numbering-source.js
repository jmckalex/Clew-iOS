// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Where every consumer of the numbers asks (chips, equation tags, heading
// prefixes, env heads, completion, jump, hover — docs/dev/book-mode.md §3):
// a note's own numbers, or — when it is a chapter of a book, or its master —
// the BOOK's (renderer/book-map.js). The book side lives in the window, which
// editor modules cannot import (the pool imports them), so it installs itself
// here. A note in no book gets numberDocument's answer, exactly.
import { numberDocument } from './numbering.js';

let provider = null;

/**
 * Installed by renderer/book-map.js:
 *   numbering(doc, notePath, options) → the book's numbers for that piece,
 *     or null (not a chapter, or the book's texts not read yet);
 *   text(path) → a piece's text as the book map has it, or null;
 *   describe(path) → { book: title, chapter: title } for the tips, or null;
 *   citeContext(path) → what a chapter's citations render among, or null.
 */
export function setBookNumbering(source) {
	provider = source;
}

/** The numbers `doc` gives: its book's when it is a chapter, else its own. */
export function numberingFor(doc, notePath, options) {
	const book = notePath && provider ? provider.numbering(doc, notePath, options) : null;
	return book ?? numberDocument(doc, options);
}

/** Another piece's text, for a hover on a label in another chapter. */
export function bookPieceText(path) {
	return provider?.text(path) ?? null;
}

/** "Conventions, in Signals" — where a label in another chapter is. */
export function bookPlace(path) {
	return provider?.describe(path) ?? null;
}

/** A chapter's citation context (book-map.js#citeContext): the book's other
 *  citations in order and its pieces, or null for a note in no book. */
export function bookCiteContext(path) {
	return (path && provider?.citeContext?.(path)) || null;
}
