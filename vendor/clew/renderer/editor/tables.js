// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Markdown tables you can actually type into.
//
// Hand-aligning pipes is miserable, and it is the reason Obsidian users install
// Advanced Tables. Nothing about it is a compatibility problem — the output is
// plain GFM, which Clew has always rendered — so this is not a shim but the
// ergonomics themselves: Tab walks the cells, Enter walks the rows, and the
// table reflows so the columns line up as you go.
//
// The parsing and formatting below are pure functions over strings, which is
// why they can be unit-tested; only the keymap at the bottom touches
// CodeMirror.
import { EditorSelection, Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';

// A table line is anything whose first non-space character is a pipe. Requiring
// a trailing pipe too would refuse the half-typed rows this exists to help.
const isTableLine = (line) => /^\s*\|/.test(line);

// | --- | :--: | ---: |
const isDelimiterLine = (line) => /^\s*\|?(?:\s*:?-{1,}:?\s*\|)+\s*:?-*:?\s*\|?\s*$/.test(line)
	&& /-/.test(line);

/** Split a row into cells, honouring \| escapes. */
export function splitRow(line) {
	const trimmed = line.trim();
	const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
	const cells = [];
	let cell = '';
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (ch === '\\' && inner[i + 1] === '|') { cell += '\\|'; i++; continue; }
		if (ch === '|') { cells.push(cell.trim()); cell = ''; continue; }
		cell += ch;
	}
	cells.push(cell.trim());
	return cells;
}

/** ':--', '--:', ':-:' → 'left' | 'right' | 'center' | null */
function alignmentOf(spec) {
	const s = spec.trim();
	const left = s.startsWith(':');
	const right = s.endsWith(':');
	if (left && right) return 'center';
	if (right) return 'right';
	if (left) return 'left';
	return null;
}

/**
 * The table surrounding line `lineNo` (0-based) in `lines`, or null.
 * Returns { from, to, rows, align, delimiterRow } with row/cell structure.
 */
export function tableAround(lines, lineNo) {
	if (lineNo < 0 || lineNo >= lines.length || !isTableLine(lines[lineNo])) return null;
	let from = lineNo;
	let to = lineNo;
	while (from > 0 && isTableLine(lines[from - 1])) from--;
	while (to < lines.length - 1 && isTableLine(lines[to + 1])) to++;

	const body = lines.slice(from, to + 1);
	const delimiterRow = body.findIndex(isDelimiterLine);
	const rows = body.map(splitRow);
	const align = delimiterRow >= 0 ? rows[delimiterRow].map(alignmentOf) : [];
	return { from, to, rows, align, delimiterRow };
}

/** Visible width, counting a CJK/emoji character as two columns. */
export function displayWidth(text) {
	let width = 0;
	for (const ch of [...text]) {
		const code = ch.codePointAt(0);
		const wide = (code >= 0x1100 && code <= 0x115f)
			|| (code >= 0x2e80 && code <= 0xa4cf)
			|| (code >= 0xac00 && code <= 0xd7a3)
			|| (code >= 0xf900 && code <= 0xfaff)
			|| (code >= 0xfe30 && code <= 0xfe6f)
			|| (code >= 0xff00 && code <= 0xff60)
			|| (code >= 0xffe0 && code <= 0xffe6)
			|| (code >= 0x1f300 && code <= 0x1faff);
		width += wide ? 2 : 1;
	}
	return width;
}

const pad = (text, width, align) => {
	const slack = Math.max(0, width - displayWidth(text));
	if (align === 'right') return ' '.repeat(slack) + text;
	if (align === 'center') {
		const left = Math.floor(slack / 2);
		return ' '.repeat(left) + text + ' '.repeat(slack - left);
	}
	return text + ' '.repeat(slack);
};

/**
 * Reflow a table so its pipes line up. Ragged rows are squared off — a row
 * with too few cells is padded, one with too many widens the table — because
 * the alternative is refusing to format the table someone is midway through
 * typing, which is exactly when they want the help.
 */
export function formatTable(table) {
	const columns = Math.max(...table.rows.map((r) => r.length));
	const widths = [];
	for (let c = 0; c < columns; c++) {
		let width = 3;   // '---' is the narrowest legal delimiter
		table.rows.forEach((row, r) => {
			if (r === table.delimiterRow) return;
			width = Math.max(width, displayWidth(row[c] ?? ''));
		});
		widths.push(width);
	}
	return table.rows.map((row, r) => {
		if (r === table.delimiterRow) {
			const cells = widths.map((width, c) => {
				const align = table.align[c];
				if (align === 'center') return `:${'-'.repeat(Math.max(1, width - 2))}:`;
				if (align === 'right') return `${'-'.repeat(Math.max(1, width - 1))}:`;
				if (align === 'left') return `:${'-'.repeat(Math.max(1, width - 1))}`;
				return '-'.repeat(width);
			});
			return `| ${cells.join(' | ')} |`;
		}
		const cells = widths.map((width, c) => pad(row[c] ?? '', width, table.align[c]));
		return `| ${cells.join(' | ')} |`;
	});
}

/** A blank row matching the table's shape. */
export function blankRow(columnCount) {
	return `|${' '.repeat(1)}${Array.from({ length: columnCount }, () => '   ').join(' | ')} |`
		.replace(/\s+\|/g, ' |');
}

// ---- CodeMirror integration ------------------------------------------------

const linesOf = (state) => state.doc.toString().split('\n');

/** The table at the cursor, plus where the cursor sits inside it. */
function context(state) {
	const pos = state.selection.main.head;
	const line = state.doc.lineAt(pos);
	const lines = linesOf(state);
	const table = tableAround(lines, line.number - 1);
	if (!table || table.delimiterRow < 0) return null;
	const row = line.number - 1 - table.from;
	// Which cell is the cursor in? Count unescaped pipes before it.
	const before = line.text.slice(0, pos - line.from);
	let cell = -1;
	for (let i = 0; i < before.length; i++) {
		if (before[i] === '\\') { i++; continue; }
		if (before[i] === '|') cell++;
	}
	return { table, row, cell: Math.max(0, cell), line, lines };
}

/**
 * Rewrite the table, then put the cursor in cell (row, cell) of the result.
 * Working on the formatted text rather than the original is what makes Tab
 * land in the right place: the columns have just moved.
 */
function applyTable(view, ctx, { row, cell, extraRow = null }) {
	const table = ctx.table;
	if (extraRow !== null) {
		table.rows.splice(extraRow, 0, Array.from({ length: table.rows[0].length }, () => ''));
	}
	const formatted = formatTable(table);
	const doc = view.state.doc;
	const fromLine = doc.line(table.from + 1);
	const toLine = doc.line(table.to + 1 + (extraRow !== null ? 0 : 0));
	const targetRow = Math.min(Math.max(row, 0), formatted.length - 1);
	const text = formatted.join('\n');

	// Cursor: start of the requested cell in the formatted row.
	const targetLine = formatted[targetRow];
	const cells = splitRow(targetLine);
	const wanted = Math.min(Math.max(cell, 0), cells.length - 1);
	let offset = 0;
	let seen = -1;
	for (let i = 0; i < targetLine.length; i++) {
		if (targetLine[i] === '\\') { i++; continue; }
		if (targetLine[i] === '|') {
			seen++;
			if (seen === wanted) { offset = i + 2; break; }
		}
	}
	const lineStart = fromLine.from + formatted.slice(0, targetRow).reduce((n, l) => n + l.length + 1, 0);

	view.dispatch({
		changes: { from: fromLine.from, to: toLine.to, insert: text },
		selection: EditorSelection.cursor(lineStart + Math.min(offset, targetLine.length)),
		scrollIntoView: true,
		userEvent: 'input.table',
	});
	return true;
}

/** Tab / Shift-Tab across cells, wrapping into the next or previous row. */
function moveCell(view, delta) {
	const ctx = context(view.state);
	if (!ctx) return false;
	const { table } = ctx;
	const columns = Math.max(...table.rows.map((r) => r.length));
	let row = ctx.row;
	let cell = ctx.cell + delta;

	if (cell >= columns) {
		cell = 0;
		row++;
		// Tab off the last row adds one, which is how a table gets typed.
		if (row >= table.rows.length) {
			return applyTable(view, ctx, { row, cell: 0, extraRow: table.rows.length });
		}
	} else if (cell < 0) {
		row--;
		if (row < 0) return applyTable(view, ctx, { row: 0, cell: 0 });
		cell = columns - 1;
	}
	// Skip the delimiter row: it is punctuation, not a cell anyone edits.
	if (row === table.delimiterRow) row += delta > 0 ? 1 : -1;
	if (row < 0) return applyTable(view, ctx, { row: 0, cell: 0 });
	if (row >= table.rows.length) {
		return applyTable(view, ctx, { row, cell, extraRow: table.rows.length });
	}
	return applyTable(view, ctx, { row, cell });
}

/** Enter moves down a row, adding one at the bottom. */
function nextRow(view) {
	const ctx = context(view.state);
	if (!ctx) return false;
	let row = ctx.row + 1;
	if (row === ctx.table.delimiterRow) row++;
	if (row >= ctx.table.rows.length) {
		return applyTable(view, ctx, { row, cell: ctx.cell, extraRow: ctx.table.rows.length });
	}
	return applyTable(view, ctx, { row, cell: ctx.cell });
}

/** Reflow without moving — the explicit command. */
export function formatTableAtCursor(view) {
	const ctx = context(view.state);
	if (!ctx) return false;
	return applyTable(view, ctx, { row: ctx.row, cell: ctx.cell });
}

/**
 * The keymap. High precedence so Tab reaches a table before indentWithTab,
 * but every handler returns false when the cursor is not in one, which hands
 * the key straight back to the normal bindings.
 */
export function tableKeymap() {
	return Prec.high(keymap.of([
		{ key: 'Tab', run: (view) => moveCell(view, 1) },
		{ key: 'Shift-Tab', run: (view) => moveCell(view, -1) },
		{ key: 'Enter', run: nextRow },
		{ key: 'Mod-Shift-f', run: formatTableAtCursor },
	]));
}
