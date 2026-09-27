// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// In-place table editing's arithmetic (docs/dev/live-edit.md §5.5c), pure so
// it is tested without a view: where each cell's text sits in the document,
// which cell a position is in, a cell's neighbours, how typed text is escaped
// for a GFM cell, and how the cell editor's changes become changes to the
// note's document.
//
// Cells are found from the TEXT of the table's lines (unescaped pipes), not
// from lezer's TableCell nodes: lezer emits no node for an empty cell, and a
// cell editor must be able to sit in one. A cell's range is its content with
// the padding spaces trimmed; an empty cell is the empty range just after the
// first space (or just after the pipe when there is no space).
//
// Rows here are LOGICAL: the delimiter line is skipped, so a GFM table's
// header is row 0 and its body follows; a headerless table (the engine's
// separator-first or pure-pipe form, tables.js#headerlessTables) is all body.

/** Tables above these sizes are edited as source (a rendering bound). */
export const CELL_EDIT_LIMITS = { rows: 200, cols: 40 };

/** Offsets of the unescaped pipes in a line of text. */
export function pipePositions(text) {
	const out = [];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\\') { i++; continue; }
		if (text[i] === '|') out.push(i);
	}
	return out;
}

const isDelimiter = (text) => /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$/.test(text) && /-/.test(text);

/** The cells of one line: [{from, to}] as offsets into the line. */
function lineCells(text) {
	const pipes = pipePositions(text);
	const lead = /^\s*\|/.test(text);
	const bounds = [];
	let start = lead ? pipes[0] + 1 : 0;
	for (const p of pipes) {
		if (lead && p === pipes[0]) continue;
		bounds.push([start, p]);
		start = p + 1;
	}
	if (text.slice(start).trim() !== '') bounds.push([start, text.length]);
	return bounds.map(([a, b]) => {
		const raw = text.slice(a, b);
		const left = raw.length - raw.trimStart().length;
		const content = raw.trim();
		if (content === '') {
			const at = a + (raw.startsWith(' ') ? 1 : 0);
			return { from: at, to: at };
		}
		return { from: a + left, to: a + left + content.length };
	});
}

/**
 * The cell ranges of the table on lines [firstLine, lastLine] (1-based) of
 * `doc` (a CodeMirror Text): `rows[row][col] = {from, to}` in document
 * offsets, the delimiter line skipped. `headerRows` is how many rows sit
 * above it — 0 for a headerless table, whose separator (if any) is its first
 * line. A first line that merely LOOKS like a separator is a header when the
 * real delimiter follows it.
 */
export function cellRanges(doc, firstLine, lastLine) {
	const rows = [];
	let delimiterLine = null;
	for (let n = firstLine; n <= lastLine; n += 1) {
		const line = doc.line(n);
		const opener = n === firstLine && n < lastLine && !isDelimiter(doc.line(n + 1).text);
		if (delimiterLine === null && (n > firstLine || opener) && isDelimiter(line.text)) {
			delimiterLine = n;
			continue;
		}
		rows.push(lineCells(line.text).map((c) => ({ from: line.from + c.from, to: line.from + c.to })));
	}
	const headerRows = delimiterLine === null ? 0 : delimiterLine - firstLine;
	return { rows, delimiterLine, headerRows };
}

/** The cell holding `pos` (boundaries inclusive), or null. */
export function cellAt(ranges, pos) {
	for (let r = 0; r < ranges.rows.length; r += 1) {
		const row = ranges.rows[r];
		for (let c = 0; c < row.length; c += 1) {
			if (pos >= row[c].from && pos <= row[c].to) return { row: r, col: c };
		}
	}
	return null;
}

/**
 * A cell's neighbour: `{row, col}`, or `{edge}` when the move leaves the
 * table — 'start' / 'end' (left of the first cell, right of the last) and
 * 'above' / 'below' (up from the header, down from the last row). Left and
 * right wrap across rows; up and down keep the column, clamped to the row.
 */
export function neighbour(ranges, row, col, dir) {
	const rows = ranges.rows;
	if (dir === 'left') {
		if (col > 0) return { row, col: col - 1 };
		if (row > 0) return { row: row - 1, col: rows[row - 1].length - 1 };
		return { edge: 'start' };
	}
	if (dir === 'right') {
		if (col < rows[row].length - 1) return { row, col: col + 1 };
		if (row < rows.length - 1) return { row: row + 1, col: 0 };
		return { edge: 'end' };
	}
	if (dir === 'up') {
		if (row > 0) return { row: row - 1, col: Math.min(col, rows[row - 1].length - 1) };
		return { edge: 'above' };
	}
	if (dir === 'down') {
		if (row < rows.length - 1) return { row: row + 1, col: Math.min(col, rows[row + 1].length - 1) };
		return { edge: 'below' };
	}
	throw new Error(`unknown direction ${dir}`);
}

/**
 * Text as a GFM cell may hold it: an unescaped `|` becomes `\|` (a bare one
 * would split the cell), a newline becomes `<br>` (a cell is one line).
 * `before` is the character preceding the insertion in the cell, so a `|`
 * typed right after a backslash is left alone — the author escaped it.
 */
export function escapeCellText(text, before = '') {
	let out = '';
	let prev = before;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '\r' && text[i + 1] === '\n') continue;
		if (ch === '\n' || ch === '\r') { out += '<br>'; prev = '>'; continue; }
		if (ch === '|' && prev !== '\\') { out += '\\|'; prev = '|'; continue; }
		// An escaped character is consumed with its backslash.
		if (ch === '\\' && prev === '\\') { out += ch; prev = ''; continue; }
		out += ch;
		prev = ch;
	}
	return out;
}

/** Does text need escaping as a cell (given the preceding character)? */
export function needsCellEscape(text, before = '') {
	return escapeCellText(text, before) !== text;
}

/**
 * The cell editor's changes (a ChangeSet over the cell's text) as change
 * specs over the note, the cell starting at `cellFrom`.
 */
export function forwardChanges(cellFrom, changes) {
	const out = [];
	changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
		out.push({ from: cellFrom + fromA, to: cellFrom + toA, insert: inserted.toString() });
	});
	return out;
}

/**
 * An EXTENDED table (the engine's colspan `||`, rowspan `^|`, or column
 * widths `|---30%---|`): rendered, but never reflowed or edited in place —
 * formatTable would square its merges away.
 */
export function isExtendedTable(lines) {
	return lines.some((text) => {
		if (/\d+%/.test(text) && isDelimiter(text.replace(/\d+%/g, ''))) return true;
		const pipes = pipePositions(text.trimEnd());
		for (let i = 1; i < pipes.length; i += 1) {
			// Adjacent pipes AFTER some content: a colspan (a leading `||` is
			// not one — it is an empty first cell).
			if (pipes[i] === pipes[i - 1] + 1 && i > 1) return true;
		}
		return lineCells(text).some((c) => text.slice(c.from, c.to).endsWith('^'));
	});
}
