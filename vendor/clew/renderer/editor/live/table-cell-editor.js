// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// In-place table editing (docs/dev/live-edit.md §5.5c). A table stays drawn
// while you type in it: the cell being edited holds a small nested
// CodeMirror view whose document is a PROJECTION of that cell's text in the
// note. Every keystroke becomes a change to the note's own document — the
// pooled EditorView stays the only model, with the only undo history.
//
//   - ONE cell editor per note editor, made on first use and moved from cell
//     to cell (reparenting an EditorView's DOM is lossless). Its state is
//     rebuilt on each mount (it has no history of its own to keep).
//   - The forwarder: the cell view's changes and selection go to the note,
//     offset by where the cell starts, annotated `cellEdit` (no echo back).
//   - The re-sync: any OTHER change to the note that touches the cell (undo,
//     a write from elsewhere) is projected back into the cell, annotated
//     `cellSync` (not forwarded again).
//   - Escaping on the way in: a bare `|` becomes `\|`, a newline `<br>`
//     (table-cell-model.js#escapeCellText), in the cell and the note alike.
//   - Leaving the table (Escape, a click elsewhere, arrowing out) reflows its
//     pipes ONCE, as one undo step — never per keystroke, so the file does
//     not churn and a one-cell edit is a one-row diff until you leave.
//
// The widget (widgets/table.js) only draws and marks the active <td>; the
// mounter below (a ViewPlugin in the note's live bundle) puts the cell
// editor there after every layout.
import { EditorState, EditorSelection, ChangeSet, Transaction, Prec } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap } from '@codemirror/view';
import { defaultKeymap, undo, redo, isolateHistory } from '@codemirror/commands';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { noteMarkdown } from '../jmd/markdown-config.js';
import { clewHighlighting } from '../theme.js';
import { jmdOverlay } from '../jmd/overlay.js';
import { wikilinkCompletions } from '../complete/wikilinks.js';
import { slashCellCompletions } from '../complete/slash-commands.js';
import { crossrefCompletions } from '../complete/crossrefs.js';
import { tagCompletions } from '../complete/tags.js';
import { citationCompletions } from '../complete/citations.js';
import { liveConfigFacet } from './config.js';
import { liveStateField } from './reveal-field.js';
import { inlineLayer } from './inline-layer.js';
import {
	activeCellField, activeCellOf, setActiveCell, clearActiveCell, cellEdit, cellSync,
} from './active-cell.js';
import {
	cellRanges, cellAt, neighbour, escapeCellText, forwardChanges, isExtendedTable,
} from './table-cell-model.js';
import { tableAround, isRenderedTable, formatTable, insertRow as insertRowAt } from '../tables.js';

/** @type {WeakMap<EditorView, EditorView>} note editor → its cell editor */
const editors = new WeakMap();

/** The cell editor of a note editor, when a cell is being edited. */
export function activeCellView(main) {
	return main && activeCellOf(main.state) ? editors.get(main) ?? null : null;
}

/** Drop a note editor's cell editor (its tab closed). */
export function destroyCellEditor(main) {
	editors.get(main)?.destroy();
	editors.delete(main);
}

function cellEditorFor(main) {
	let cell = editors.get(main);
	if (!cell) {
		cell = new EditorView({ state: cellState(main, '', 0) });
		editors.set(main, cell);
	}
	return cell;
}

// ---- the cell editor's state ------------------------------------------------

const cellTheme = EditorView.theme({
	'&': { background: 'transparent' },
	'&.cm-focused': { outline: 'none' },
	'.cm-content': { padding: '0', maxWidth: 'none', caretColor: 'var(--clew-accent)' },
	'.cm-line': { padding: '0' },
	'.cm-scroller': { overflow: 'visible', fontFamily: 'inherit', lineHeight: 'inherit' },
});

/** Escape what the cell's text cannot hold, in the transaction itself. */
const escapeFilter = EditorState.transactionFilter.of((tr) => {
	if (!tr.docChanged || tr.annotation(cellSync)) return tr;
	const specs = [];
	let changed = false;
	tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
		const text = inserted.toString();
		const before = tr.startState.doc.sliceString(Math.max(0, fromA - 1), fromA);
		const escaped = escapeCellText(text, before);
		if (escaped !== text) changed = true;
		specs.push({ from: fromA, to: toA, insert: escaped });
	});
	if (!changed) return tr;
	const changes = ChangeSet.of(specs, tr.startState.doc.length);
	return {
		changes,
		selection: EditorSelection.cursor(changes.mapPos(tr.startState.selection.main.head, 1)),
		userEvent: tr.annotation(Transaction.userEvent) ?? 'input',
	};
});

function cellState(main, text, head) {
	const config = main.state.facet(liveConfigFacet);
	return EditorState.create({
		doc: text,
		selection: { anchor: Math.min(head, text.length) },
		extensions: [
			noteMarkdown({ normalSyntax: config.normalSyntax }),
			clewHighlighting,
			jmdOverlay(),
			// The live INLINE layer: `*strong*` conceals in a cell as it does in
			// prose, revealed where this editor's own cursor is.
			liveConfigFacet.of(config),
			liveStateField,
			inlineLayer,
			autocompletion({ override: [wikilinkCompletions, tagCompletions, citationCompletions, crossrefCompletions, slashCellCompletions] }),
			closeBrackets(),
			escapeFilter,
			Prec.highest(keymap.of(cellKeys(main))),
			keymap.of([...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap]),
			EditorView.lineWrapping,
			EditorView.editorAttributes.of({ class: 'le-cell-editor cm-live' }),
			cellTheme,
			EditorView.updateListener.of((update) => forward(main, update)),
		],
	});
}

/** The cell's changes and selection → the note. */
function forward(main, update) {
	if (!update.docChanged && !update.selectionSet) return;
	if (update.transactions.some((tr) => tr.annotation(cellSync))) return;
	const cell = activeCellOf(main.state);
	if (!cell) return;
	const spec = { annotations: [cellEdit.of(true)] };
	if (update.docChanged) {
		spec.changes = forwardChanges(cell.from, update.changes);
		const event = update.transactions.map((tr) => tr.annotation(Transaction.userEvent)).find(Boolean);
		if (event) spec.userEvent = event;
	}
	const sel = update.state.selection.main;
	spec.selection = EditorSelection.range(cell.from + sel.anchor, cell.from + sel.head);
	main.dispatch(spec);
	if (update.docChanged) main.requestMeasure();
}

// ---- the table under a cell or a cursor --------------------------------------

/**
 * The table a command acts on: the active cell's, or the one under the
 * note's cursor. `{ first, last, ranges, row, col, active }` (1-based lines,
 * logical rows), or null outside a table.
 */
export function tableTarget(main) {
	const { state } = main;
	const cell = activeCellOf(state);
	const pos = cell ? cell.from : state.selection.main.head;
	const lineNo = state.doc.lineAt(pos).number;
	const lines = state.doc.toString().split('\n');
	const table = tableAround(lines, lineNo - 1);
	if (!isRenderedTable(table, lines)) return null;
	const first = table.from + 1;
	const last = table.to + 1;
	const ranges = cellRanges(state.doc, first, last);
	let at = cell ? { row: cell.row, col: cell.col } : cellAt(ranges, pos);
	if (!at) {
		// Between cells (a pipe, the padding): the row of the line, column 0.
		const logical = lineNo - first - (ranges.delimiterLine && lineNo > ranges.delimiterLine ? 1 : 0);
		at = { row: Math.max(0, Math.min(logical, ranges.rows.length - 1)), col: 0 };
	}
	return { first, last, ranges, row: at.row, col: at.col, active: Boolean(cell), table, lines: lines.slice(first - 1, last) };
}

/** Make cell (row, col) of the table at `first` the active one. */
export function activateCell(main, first, last, row, col, where = 'end') {
	const ranges = cellRanges(main.state.doc, first, last);
	const r = Math.max(0, Math.min(row, ranges.rows.length - 1));
	const c = Math.max(0, Math.min(col, ranges.rows[r].length - 1));
	const cell = ranges.rows[r][c];
	const head = where === 'start' ? cell.from
		: where === 'end' ? cell.to
		: Math.min(cell.from + where, cell.to);
	main.dispatch({
		effects: setActiveCell.of({ row: r, col: c, from: cell.from, to: cell.to, tableFrom: main.state.doc.line(first).from }),
		selection: EditorSelection.cursor(head),
		scrollIntoView: true,
	});
}

/** The reflow that leaving a table does: its lines, pipes aligned. */
function reflowChange(state, cell) {
	const lineNo = state.doc.lineAt(cell.from).number;
	const lines = state.doc.toString().split('\n');
	const table = tableAround(lines, lineNo - 1);
	if (!isRenderedTable(table, lines)) return null;
	const own = lines.slice(table.from, table.to + 1);
	if (isExtendedTable(own)) return null;
	const formatted = formatTable(table).join('\n');
	if (formatted === own.join('\n')) return null;
	return { from: state.doc.line(table.from + 1).from, to: state.doc.line(table.to + 1).to, insert: formatted };
}

/**
 * Stop editing in place: the table's pipes reflow (one undo step of its
 * own), and the table stays drawn unless the note's cursor is inside it
 * (`reveal`: Escape, "edit as source" — the source at the cell's caret).
 */
export function leaveCell(main, { focus = true } = {}) {
	const cell = activeCellOf(main.state);
	if (!cell) return;
	const change = reflowChange(main.state, cell);
	// Where the caret sits in the cell, if it is there (Escape, "edit as
	// source"): the reflow rewrites the table's lines wholesale, which would
	// map it to their edge — so it is put back into the same cell after.
	const head = main.state.selection.main.head;
	const inCell = head >= cell.from && head <= cell.to ? head - cell.from : null;
	const first = main.state.doc.lineAt(cell.tableFrom).number;
	main.dispatch({
		effects: clearActiveCell.of(null),
		...(change ? { changes: change, userEvent: 'format.table', annotations: isolateHistory.of('full') } : {}),
	});
	if (change && inCell !== null) {
		const lines = main.state.doc.toString().split('\n');
		const table = tableAround(lines, first - 1);
		if (table) {
			const ranges = cellRanges(main.state.doc, table.from + 1, table.to + 1);
			const target = ranges.rows[cell.row]?.[cell.col];
			if (target) main.dispatch({ selection: EditorSelection.cursor(Math.min(target.from + inCell, target.to)) });
		}
	}
	if (focus) main.focus();
}

/** Leave the table at an edge: the cursor goes just outside it. */
function leaveAt(main, first, last, edge) {
	leaveCell(main, { focus: false });
	const doc = main.state.doc;
	// The reflow keeps the table's line count, so its lines still bound it.
	let pos;
	if (edge === 'above' || edge === 'start') pos = first > 1 ? doc.line(first - 1).to : doc.line(first).from;
	else pos = last < doc.lines ? doc.line(last + 1).from : doc.line(last).to;
	main.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true });
	main.focus();
}

// ---- structure ---------------------------------------------------------------

/** Logical row ↔ index into table.rows (the delimiter row counted). */
export const rowIndex = (table, row) => (table.delimiterRow >= 0 && row >= table.delimiterRow ? row + 1 : row);

/**
 * Rewrite the table through a structural op (tables.js) and land in cell
 * `to(target)` — editing it in place when a cell was active, else with the
 * note's cursor at its start.
 */
export function applyStructure(main, op, to) {
	const t = tableTarget(main);
	if (!t) return false;
	if (isExtendedTable(t.lines)) return false;
	const next = op(t.table, t);
	if (next === t.table) return false;
	const formatted = formatTable(next);
	const doc = main.state.doc;
	main.dispatch({
		changes: { from: doc.line(t.first).from, to: doc.line(t.last).to, insert: formatted.join('\n') },
		effects: t.active ? clearActiveCell.of(null) : [],
		userEvent: 'input.table',
		annotations: isolateHistory.of('full'),
	});
	const last = t.first + formatted.length - 1;
	const target = to(t, next);
	if (t.active) {
		activateCell(main, t.first, last, target.row, target.col, 'end');
	} else {
		const ranges = cellRanges(main.state.doc, t.first, last);
		const row = ranges.rows[Math.min(target.row, ranges.rows.length - 1)];
		const cell = row[Math.min(target.col, row.length - 1)];
		main.dispatch({ selection: EditorSelection.cursor(cell.from) });
		main.focus();
	}
	return true;
}

// ---- keys --------------------------------------------------------------------

/** Move to a neighbouring cell; past the table's end, append a row. */
function move(main, dir, { append = false, where = 'end', offset = null } = {}) {
	const t = tableTarget(main);
	if (!t) return false;
	const n = neighbour(t.ranges, t.row, t.col, dir);
	if (n.edge) {
		if (append && (n.edge === 'end' || n.edge === 'below')) {
			const lastRow = t.ranges.rows.length;
			return applyStructure(main, (table) => insertRowAt(table, table.rows.length),
				() => ({ row: lastRow, col: n.edge === 'end' ? 0 : t.col }));
		}
		leaveAt(main, t.first, t.last, n.edge);
		return true;
	}
	activateCell(main, t.first, t.last, n.row, n.col, offset ?? where);
	return true;
}

function onFirstVisualLine(view) {
	const head = view.state.selection.main.head;
	const a = view.coordsAtPos(head);
	const b = view.coordsAtPos(0);
	return !a || !b || Math.abs(a.top - b.top) < 2;
}

function onLastVisualLine(view) {
	const head = view.state.selection.main.head;
	const a = view.coordsAtPos(head);
	const b = view.coordsAtPos(view.state.doc.length);
	return !a || !b || Math.abs(a.top - b.top) < 2;
}

function cellKeys(main) {
	const cellView = () => editors.get(main);
	return [
		{ key: 'Tab', run: () => move(main, 'right', { append: true, where: 'end' }) },
		{ key: 'Shift-Tab', run: () => move(main, 'left', { where: 'end' }) },
		{ key: 'Enter', run: () => move(main, 'down', { append: true, where: 'end' }) },
		{
			key: 'Shift-Enter',
			run: (view) => {
				const { from, to } = view.state.selection.main;
				view.dispatch({ changes: { from, to, insert: '<br>' }, selection: { anchor: from + 4 }, userEvent: 'input.type' });
				return true;
			},
		},
		{ key: 'Escape', run: () => { leaveCell(main); return true; } },
		{
			key: 'ArrowLeft',
			run: (view) => {
				const s = view.state.selection.main;
				return s.empty && s.head === 0 ? move(main, 'left', { where: 'end' }) : false;
			},
		},
		{
			key: 'ArrowRight',
			run: (view) => {
				const s = view.state.selection.main;
				return s.empty && s.head === view.state.doc.length ? move(main, 'right', { where: 'start' }) : false;
			},
		},
		{
			key: 'ArrowUp',
			run: (view) => (onFirstVisualLine(view)
				? move(main, 'up', { offset: view.state.selection.main.head }) : false),
		},
		{
			key: 'ArrowDown',
			run: (view) => (onLastVisualLine(view)
				? move(main, 'down', { offset: view.state.selection.main.head }) : false),
		},
		// One history — the note's.
		{ key: 'Mod-z', run: () => { undo(main); cellView()?.focus(); return true; } },
		{ key: 'Mod-Shift-z', run: () => { redo(main); cellView()?.focus(); return true; } },
		{ key: 'Mod-y', run: () => { redo(main); cellView()?.focus(); return true; } },
	];
}

// ---- the mounter (in the note's live bundle) ---------------------------------

class CellMounter {
	constructor(view) {
		this.view = view;
		this.resync = false;
		this.schedule();
	}

	update(update) {
		const cell = activeCellOf(update.state);
		if (cell) {
			const fromCell = update.transactions.some((tr) => tr.annotation(cellEdit));
			if (update.docChanged && !fromCell) this.resync = true;
			// The note's selection left the cell by some other route (a click
			// elsewhere in the note, a search): the edit is over.
			const activated = update.transactions.some((tr) => tr.effects.some((e) => e.is(setActiveCell)));
			if (update.selectionSet && !fromCell && !activated) {
				const s = update.state.selection.main;
				if (s.from < cell.from || s.to > cell.to) {
					setTimeout(() => { if (activeCellOf(this.view.state)) leaveCell(this.view, { focus: false }); });
				}
			}
		}
		this.schedule();
	}

	schedule() {
		this.view.requestMeasure({ key: this, read: () => null, write: () => this.apply() });
	}

	apply() {
		const main = this.view;
		const cell = activeCellOf(main.state);
		const existing = editors.get(main);
		if (!cell) {
			if (existing?.dom.isConnected) existing.dom.remove();
			return;
		}
		const td = main.contentDOM.querySelector('.le-table-wrap [data-le-active]');
		if (!td) return;
		const editor = cellEditorFor(main);
		const text = main.state.doc.sliceString(cell.from, cell.to);
		const s = main.state.selection.main;
		const head = Math.max(0, Math.min(s.head - cell.from, text.length));
		if (editor.dom.parentNode !== td) {
			// Newly mounted (or the widget rebuilt): a fresh state, focus.
			editor.setState(cellState(main, text, head));
			td.replaceChildren(editor.dom);
			this.resync = false;
			editor.focus();
			return;
		}
		if (this.resync) {
			this.resync = false;
			if (editor.state.doc.toString() !== text) {
				editor.dispatch({
					changes: { from: 0, to: editor.state.doc.length, insert: text },
					selection: { anchor: head },
					annotations: cellSync.of(true),
				});
			}
		}
	}

	destroy() {
		editors.get(this.view)?.dom.remove();
	}
}

export const cellMounter = ViewPlugin.fromClass(CellMounter);

/** The pieces the note's live bundle carries for editing tables in place. */
export const tableEditing = [activeCellField, cellMounter];
