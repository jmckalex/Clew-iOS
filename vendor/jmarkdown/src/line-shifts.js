/*
	Lines the source loses before marked reads it, so that inverse search can
	put them back.

	Inline footnotes' preprocess (Pass B, inline-footnotes.js) lifts a
	multi-paragraph note out of the source and leaves a one-line marker, so the
	text marked parses is short by the note's lines from there on. Source
	positions (source-positions.js) and a book's chapter lines (book.js) count
	lines in that text, so everything after such a note — data-source-line,
	which jmarkdown's inverse search and Clew's scroll sync read, and a book's
	chapter:line in warnings — landed early by the note's lines. Pass B records
	each lift here; the readers add the lines back. Lines are counted, not
	characters: marked empties whitespace-only lines as it lexes, which moves
	characters but never lines.

	One record per build: resetFootnotes() (index.js, every build) resets it.
*/

// { line: the marker's line in the parsed text (0-based), lines: the line
// breaks the note took with it }.
const shifts = [];

export function resetLineShifts() {
	shifts.length = 0;
}

export function recordLineShift(line, lines) {
	if (lines > 0) shifts.push({ line, lines });
}

/**
 * The lines lifted out above `line` (0-based, in the parsed text) — by the
 * notes whose markers stand on an earlier line, at or after `from` (a book
 * chapter's first line: an earlier chapter's notes are not this one's).
 */
export function linesLiftedBefore(line, from = 0) {
	let n = 0;
	for (const shift of shifts) {
		if (shift.line >= from && shift.line < line) n += shift.lines;
	}
	return n;
}
