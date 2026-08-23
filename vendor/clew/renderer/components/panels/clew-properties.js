// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Properties panel: view and edit the active note's frontmatter as typed
// key/value rows (text, number, checkbox, list chips). Edits go through the
// live editor when the note has one (so they're undoable and auto-saved);
// otherwise straight to disk. Blocks outside the parseable subset are shown
// read-only — round-trip safety over convenience.
import { ClewElement } from '../base/clew-element.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { editorPool } from '../../editor/pool.js';
import { ipc, CH } from '../../ipc.js';
import { debounce } from '../../lib/debounce.js';
import { parseProperties, serializeProperties, propertyType } from '../../../shared/frontmatter.js';
import { emptyNote } from './clew-backlinks.js';
import { icon } from '../../lib/icons.js';

export class ClewProperties extends ClewElement {
	#path = null;
	#entries = [];
	#clean = true;
	#present = false;
	#refresh = debounce(() => this.refresh(), 150);

	subscribe() {
		this.listen(workspaceStore, 'active-changed', () => this.#refresh());
		this.listen(workspaceStore, 'layout-changed', () => this.#refresh());
		this.listen(editorPool, 'doc-changed', ({ tabId }) => {
			// Another editor's keystrokes may have rewritten the frontmatter.
			if (editorPool.get(tabId)?.path === this.#path) this.#refresh();
		});
	}

	render() {
		this.classList.add('panel-scroll');
		this.refresh();
	}

	/** The live editor entry for a path, if any tab has one open. */
	#liveEntry(path) {
		for (const group of workspaceStore.allGroups()) {
			for (const tab of group.tabs) {
				if (tab.kind !== 'note' || tab.path !== path) continue;
				const entry = editorPool.get(tab.id);
				if (entry?.view) return entry;
			}
		}
		return null;
	}

	async #noteText(path) {
		const entry = this.#liveEntry(path);
		if (entry) return entry.view.state.doc.toString();
		return ipc.invoke(CH.NOTE_READ, { path }).catch(() => null);
	}

	async refresh() {
		// Don't re-render out from under the user's typing.
		if (this.contains(document.activeElement)) return;
		const tab = workspaceStore.activeTab();
		const path = tab?.kind === 'note' ? tab.path : null;
		this.#path = path;
		if (!path) {
			this.replaceChildren(emptyNote('No active note'));
			return;
		}
		const text = await this.#noteText(path);
		if (this.#path !== path) return; // switched away while reading
		if (text === null) {
			this.replaceChildren(emptyNote('Could not read note'));
			return;
		}
		const { present, entries, clean } = parseProperties(text);
		this.#entries = entries;
		this.#clean = clean;
		this.#present = present;
		this.#renderRows();
	}

	#renderRows() {
		const frag = document.createDocumentFragment();

		const header = document.createElement('div');
		header.className = 'props-header';
		const title = document.createElement('span');
		title.textContent = `Properties (${this.#entries.length})`;
		header.append(title);
		if (this.#clean) {
			const add = document.createElement('button');
			add.className = 'props-add';
			add.textContent = '+ Add';
			add.addEventListener('click', () => this.#addProperty());
			header.append(add);
		}
		frag.append(header);

		if (!this.#clean) {
			frag.append(emptyNote('This note’s frontmatter uses YAML beyond the editable subset (nested values, comments, …). Shown read-only to keep it intact.'));
		}
		if (this.#entries.length === 0 && this.#clean) {
			frag.append(emptyNote(this.#present ? 'Empty frontmatter' : 'No properties'));
		}

		for (let i = 0; i < this.#entries.length; i++) {
			frag.append(this.#row(i));
		}
		this.replaceChildren(frag);
	}

	#row(index) {
		const entry = this.#entries[index];
		const row = document.createElement('div');
		row.className = 'props-row';

		const key = document.createElement('input');
		key.className = 'props-key';
		key.value = entry.key;
		key.disabled = !this.#clean;
		key.spellcheck = false;
		key.addEventListener('change', () => {
			const next = key.value.trim();
			if (!next || !/^[A-Za-z0-9_][\w ./-]*$/.test(next)) {
				key.value = entry.key;
				return;
			}
			entry.key = next;
			this.#commit();
		});
		key.addEventListener('keydown', (e) => { if (e.key === 'Enter') key.blur(); });
		row.append(key, this.#valueEditor(entry));

		if (this.#clean) {
			const del = document.createElement('button');
			del.className = 'props-delete';
			del.title = 'Remove property';
			del.append(icon('xmark'));
			del.addEventListener('click', () => {
				this.#entries.splice(index, 1);
				this.#commit();
				this.#renderRows();
			});
			row.append(del);
		}
		return row;
	}

	#valueEditor(entry) {
		const type = propertyType(entry.value);
		if (type === 'checkbox') {
			const box = document.createElement('input');
			box.type = 'checkbox';
			box.className = 'props-checkbox';
			box.checked = entry.value === true;
			box.disabled = !this.#clean;
			box.addEventListener('change', () => {
				entry.value = box.checked;
				this.#commit();
			});
			return box;
		}
		if (type === 'list') {
			return this.#listEditor(entry);
		}
		const input = document.createElement('input');
		input.className = 'props-value';
		input.spellcheck = false;
		input.disabled = !this.#clean;
		input.value = entry.value === null ? '' : String(entry.value);
		// ISO dates get the native date picker.
		if (typeof entry.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.value)) {
			input.type = 'date';
		}
		input.addEventListener('change', () => {
			const text = input.value.trim();
			if (text === '') entry.value = null;
			else if (input.type === 'date') entry.value = text;
			else if (text === 'true') entry.value = true;
			else if (text === 'false') entry.value = false;
			else if (/^-?\d+(\.\d+)?$/.test(text)) entry.value = Number(text);
			else entry.value = input.value;
			this.#commit();
		});
		input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
		return input;
	}

	#listEditor(entry) {
		const wrap = document.createElement('div');
		wrap.className = 'props-list';
		for (let i = 0; i < entry.value.length; i++) {
			const chip = document.createElement('span');
			chip.className = 'props-chip';
			chip.textContent = String(entry.value[i]);
			if (this.#clean) {
				const x = document.createElement('button');
				x.className = 'props-chip-x';
				x.append(icon('xmark'));
				x.addEventListener('click', () => {
					entry.value.splice(i, 1);
					this.#commit();
					this.#renderRows();
				});
				chip.append(x);
			}
			wrap.append(chip);
		}
		if (this.#clean) {
			const input = document.createElement('input');
			input.className = 'props-list-input';
			input.placeholder = '+';
			input.spellcheck = false;
			input.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' && input.value.trim()) {
					entry.value.push(input.value.trim());
					this.#commit();
					this.#renderRows();
				} else if (e.key === 'Backspace' && !input.value && entry.value.length) {
					entry.value.pop();
					this.#commit();
					this.#renderRows();
				}
			});
			wrap.append(input);
		}
		return wrap;
	}

	#addProperty() {
		// A fresh row with a placeholder key; committed once the key is named.
		let n = this.#entries.length + 1;
		let key = `property ${n}`;
		while (this.#entries.some((e) => e.key === key)) key = `property ${++n}`;
		this.#entries.push({ key, value: null });
		this.#commit();
		this.#renderRows();
		this.querySelector('.props-row:last-child .props-key')?.focus();
	}

	/** Write the current entries back into the note. */
	async #commit() {
		const path = this.#path;
		if (!path || !this.#clean) return;
		const entry = this.#liveEntry(path);
		if (entry) {
			const doc = entry.view.state.doc.toString();
			const { end } = parseProperties(doc);
			entry.view.dispatch({
				changes: { from: 0, to: end, insert: serializeProperties(this.#entries) },
			});
			return; // autosave persists; doc-changed refreshes other views
		}
		const text = await ipc.invoke(CH.NOTE_READ, { path }).catch(() => null);
		if (text === null || this.#path !== path) return;
		const { end } = parseProperties(text);
		const next = serializeProperties(this.#entries) + text.slice(end);
		await ipc.invoke(CH.NOTE_WRITE, { path, content: next }).catch((err) => {
			console.error('Property write failed:', err);
		});
	}
}

customElements.define('clew-properties', ClewProperties);
