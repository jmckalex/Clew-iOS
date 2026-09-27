// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// A markdown table drawn as a real <table> (plan §5.5a, Tier B), editable in
// place (§5.5c): alignment from the delimiter row, each cell's inline
// markdown through the inline subset renderer (live/inline-dom.js).
//
// The widget only DRAWS. Which cell is being edited is the note's state
// (live/active-cell.js); that cell's <td> is marked `data-le-active` and left
// empty for the cell editor (live/table-cell-editor.js), which mounts itself
// there and which this widget never touches. Every keystroke in a cell
// changes the table's text, so CodeMirror hands this widget a new one per
// keystroke: `updateDOM` patches the cells whose content changed, in place,
// and the cell being edited — its editor, its focus, an IME composition —
// survives untouched.
//
// Cells carry their offset from the table's first line (for "edit as source"
// clicks) and their logical row/column (for editing in place).
import { WidgetType } from '@codemirror/view';
import { tokensToDom } from '../inline-dom.js';
import { mathElement } from './math.js';

export class TableWidget extends WidgetType {
	/**
	 * @param {string} source - the table's text (the identity)
	 * @param {{header: boolean, cells: {tokens: object[], offset: number}[]}[]} rows
	 * @param {(string|null)[]} align - per column
	 * @param {{ editable?: boolean, reason?: string, active?: {row: number, col: number}|null }} [options]
	 */
	constructor(source, rows, align, { editable = true, reason = '', active = null } = {}) {
		super();
		this.source = source;
		this.rows = rows;
		this.align = align;
		this.cellsEditable = editable;
		this.reason = reason;
		this.active = active;
		this.activeKey = active ? `${active.row}:${active.col}` : '';
	}

	eq(other) {
		return other instanceof TableWidget && other.source === this.source
			&& other.activeKey === this.activeKey && other.cellsEditable === this.cellsEditable;
	}

	toDOM() {
		const wrap = document.createElement('div');
		wrap.className = 'le-table-wrap';
		this.#fill(wrap);
		return wrap;
	}

	/** Patch in place; the active cell (and its editor) is never touched. */
	updateDOM(dom) {
		const table = dom.querySelector(':scope > table');
		const shape = this.rows.map((r) => r.cells.length).join(',');
		if (!table || dom.dataset.shape !== shape || dom.dataset.editable !== String(this.cellsEditable)) {
			this.#fill(dom);
			return true;
		}
		const keys = dom.__leCellKeys ?? [];
		const next = [];
		const cells = table.querySelectorAll('th, td');
		let i = 0;
		this.rows.forEach((row, r) => row.cells.forEach((cell, c) => {
			const td = cells[i];
			const key = JSON.stringify(cell.tokens);
			next.push(key);
			td.dataset.leCell = String(cell.offset);
			td.style.textAlign = this.align[c] ?? '';
			const isActive = this.active && this.active.row === r && this.active.col === c;
			if (isActive) {
				td.dataset.leActive = '1';
			} else if (td.dataset.leActive || keys[i] !== key) {
				delete td.dataset.leActive;
				this.#cellContent(td, cell);
			}
			i += 1;
		}));
		dom.__leCellKeys = next;
		return true;
	}

	#fill(wrap) {
		const table = document.createElement('table');
		table.className = 'le-table';
		const head = document.createElement('thead');
		const body = document.createElement('tbody');
		const keys = [];
		this.rows.forEach((row, r) => {
			const tr = document.createElement('tr');
			row.cells.forEach((cell, c) => {
				const td = document.createElement(row.header ? 'th' : 'td');
				if (this.align[c]) td.style.textAlign = this.align[c];
				td.dataset.leCell = String(cell.offset);
				td.dataset.leRow = String(r);
				td.dataset.leCol = String(c);
				keys.push(JSON.stringify(cell.tokens));
				if (this.active && this.active.row === r && this.active.col === c) td.dataset.leActive = '1';
				else this.#cellContent(td, cell);
				tr.append(td);
			});
			(row.header ? head : body).append(tr);
		});
		table.append(head, body);
		const parts = [table];
		if (!this.cellsEditable && this.reason) {
			const strip = document.createElement('div');
			strip.className = 'le-table-note le-reveal-on-click';
			strip.textContent = this.reason;
			parts.unshift(strip);
		}
		wrap.replaceChildren(...parts);
		wrap.dataset.shape = this.rows.map((r) => r.cells.length).join(',');
		wrap.dataset.editable = String(this.cellsEditable);
		wrap.__leCellKeys = keys;
	}

	#cellContent(td, cell) {
		td.replaceChildren(tokensToDom(cell.tokens, mathElement));
	}

	/** The cell editor is the pool's, not ours: park it, never destroy it. */
	destroy(dom) {
		dom.querySelector('.le-cell-editor')?.remove();
	}

	get estimatedHeight() { return 32 * this.rows.length + 8; }

	ignoreEvent(event) {
		// The cell editor's own keys, clicks and composition are its own.
		if (event.target?.closest?.('.le-cell-editor')) return true;
		return event.type !== 'mousedown' && event.type !== 'contextmenu';
	}
}
