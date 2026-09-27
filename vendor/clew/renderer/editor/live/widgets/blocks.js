// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// BLOCK stand-ins (plan §5.5): a horizontal rule, a table of contents, the
// note's properties, the kanban-board banner. Block replacements change the
// document's vertical structure, so they come from the block field
// (block-field.js), never from a ViewPlugin.
import { WidgetType } from '@codemirror/view';
import { parseProperties, propertyType } from '../../../../shared/frontmatter.js';
import { applyPropertiesToView } from '../../frontmatter-edit.js';

export class HrWidget extends WidgetType {
	eq(other) { return other instanceof HrWidget; }

	toDOM() {
		const el = document.createElement('div');
		el.className = 'le-hr le-reveal-on-click';
		el.append(document.createElement('hr'));
		return el;
	}

	get estimatedHeight() { return 24; }

	ignoreEvent(event) { return event.type !== 'mousedown'; }
}

export class TocWidget extends WidgetType {
	/** @param {{depth: number, text: string, pos: number}[]} headings */
	constructor(headings) {
		super();
		this.headings = headings;
		this.key = JSON.stringify(headings.map((h) => [h.depth, h.text]));
	}

	eq(other) {
		// Positions move with every edit above a heading; the entries only
		// need them at click time, so they are patched in updateDOM.
		return other instanceof TocWidget && other.key === this.key;
	}

	toDOM() {
		const el = document.createElement('nav');
		el.className = 'le-toc';
		const title = document.createElement('div');
		title.className = 'le-toc-title le-reveal-on-click';
		title.textContent = 'Contents';
		el.append(title);
		const list = document.createElement('ul');
		const top = Math.min(...this.headings.map((h) => h.depth), 6);
		for (const h of this.headings) {
			const li = document.createElement('li');
			li.style.paddingLeft = `${(h.depth - top) * 1.2}em`;
			li.textContent = h.text;
			li.dataset.leGoto = String(h.pos);
			list.append(li);
		}
		el.append(list);
		return el;
	}

	updateDOM(dom) {
		const items = dom.querySelectorAll('li');
		if (items.length !== this.headings.length) return false;
		items.forEach((li, i) => { li.dataset.leGoto = String(this.headings[i].pos); });
		return true;
	}

	ignoreEvent(event) { return event.type !== 'mousedown'; }
}

export class BannerWidget extends WidgetType {
	constructor(text, action) {
		super();
		this.text = text;
		this.action = action;
	}

	eq(other) { return other instanceof BannerWidget && other.text === this.text; }

	toDOM() {
		const el = document.createElement('div');
		el.className = 'le-banner';
		const text = document.createElement('span');
		text.textContent = this.text;
		el.append(text);
		if (this.action) {
			const button = document.createElement('button');
			button.textContent = this.action.label;
			button.dataset.leCommand = this.action.command;
			el.append(button);
		}
		return el;
	}

	ignoreEvent(event) { return event.type !== 'mousedown'; }
}

/**
 * The note's frontmatter as property rows (plan §5.7): text, number, date
 * and checkbox values edit in place, written back through the editor
 * (frontmatter-edit.js) — undoable, auto-saved. Lists show as chips.
 * YAML beyond the editable subset is shown read-only. "Edit as YAML"
 * reveals the source.
 */
export class PropertiesWidget extends WidgetType {
	constructor(text) {
		super();
		this.text = text;
	}

	eq(other) { return other instanceof PropertiesWidget && other.text === this.text; }

	toDOM(view) {
		const { entries, clean } = parseProperties(this.text + (this.text.endsWith('\n') ? '' : '\n'));
		const el = document.createElement('div');
		el.className = 'le-props';
		const commit = () => applyPropertiesToView(view, entries);
		for (const entry of entries) {
			const row = document.createElement('div');
			row.className = 'props-row le-props-row';
			const key = document.createElement('span');
			key.className = 'props-key le-props-key';
			key.textContent = entry.key;
			row.append(key, valueEditor(entry, clean, commit));
			el.append(row);
		}
		const foot = document.createElement('div');
		foot.className = 'le-props-foot';
		if (!clean) {
			const note = document.createElement('span');
			note.textContent = 'YAML beyond the editable subset — shown read-only. ';
			foot.append(note);
		}
		const yaml = document.createElement('span');
		yaml.className = 'le-props-yaml le-reveal-on-click';
		yaml.textContent = 'Edit as YAML';
		foot.append(yaml);
		el.append(foot);
		return el;
	}

	get estimatedHeight() { return 32 * 4; }

	// Inputs keep their own keys and clicks; only the "Edit as YAML" link
	// (a mousedown the editor handles) reaches CodeMirror.
	ignoreEvent(event) {
		return !(event.type === 'mousedown' && event.target.closest?.('.le-reveal-on-click'));
	}
}

function valueEditor(entry, clean, commit) {
	const type = propertyType(entry.value);
	if (type === 'checkbox') {
		const box = document.createElement('input');
		box.type = 'checkbox';
		box.className = 'props-checkbox';
		box.checked = entry.value === true;
		box.disabled = !clean;
		box.addEventListener('change', () => { entry.value = box.checked; commit(); });
		return box;
	}
	if (type === 'list') {
		const wrap = document.createElement('span');
		wrap.className = 'props-list';
		for (const item of entry.value) {
			const chip = document.createElement('span');
			chip.className = 'props-chip';
			chip.textContent = String(item);
			wrap.append(chip);
		}
		return wrap;
	}
	const input = document.createElement('input');
	input.className = 'props-value';
	input.spellcheck = false;
	input.disabled = !clean;
	input.value = entry.value === null ? '' : String(entry.value);
	if (typeof entry.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.value)) input.type = 'date';
	input.addEventListener('change', () => {
		const text = input.value.trim();
		if (text === '') entry.value = null;
		else if (input.type === 'date') entry.value = text;
		else if (text === 'true' || text === 'false') entry.value = text === 'true';
		else if (/^-?\d+(\.\d+)?$/.test(text)) entry.value = Number(text);
		else entry.value = input.value;
		commit();
	});
	input.addEventListener('keydown', (e) => {
		e.stopPropagation();
		if (e.key === 'Enter') input.blur();
	});
	return input;
}
