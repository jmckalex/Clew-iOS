// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// References panel, in the right sidebar, with two modes:
//
// "This note" — the active note's formatted bibliography. The engine renders
// every note with a hidden all-citations bibliography (the
// .clew-bib-panel-source aside in clew-template.html); this mode fetches the
// note's rendered HTML on demand and lifts that list out. It renders the
// note, so it stays behind the vault's `bibliographyPanel` setting.
//
// "Library" (docs/dev/live-edit.md §5.14) — every entry in the vault's .bib
// files, searchable, filterable by cited/uncited, each with the notes that
// cite it (the index's citedBy) and its actions: insert a citation at the
// caret, copy the key, open its PDF (the `file` field), open its DOI/URL.
// A citation chip's click in live edit opens this mode at its entry
// (`showEntry`).
import { ClewElement } from '../base/clew-element.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { vaultStore } from '../../state/vault-store.js';
import { vaultSettingsStore } from '../../state/vault-settings-store.js';
import { ipc, CH } from '../../ipc.js';
import { debounce } from '../../lib/debounce.js';
import { fuzzyScore } from '../../lib/fuzzy.js';
import { allBibEntries } from '../../editor/complete/citations.js';
import { openNoteAtLine } from '../../commands/actions.js';
import { activeEditorView } from '../../commands/format.js';
import { notice } from '../../plugins.js';
import { openEntryPdf } from '../../bib-pdf.js';

const NOTE_FILE = /\.(md|jmd)$/i;

// The extracted markup is citeproc output built from .bib fields — author
// content. Keep only the formatting it legitimately produces.
const KEEP_TAGS = new Set(['DIV', 'SPAN', 'P', 'EM', 'I', 'B', 'STRONG', 'SMALL', 'SUP', 'SUB', 'BR', 'A']);

function sanitize(node, out) {
	for (const child of node.childNodes) {
		if (child.nodeType === Node.TEXT_NODE) {
			out.append(child.textContent);
			continue;
		}
		if (child.nodeType !== Node.ELEMENT_NODE) continue;
		if (!KEEP_TAGS.has(child.tagName)) {
			sanitize(child, out); // unwrap: keep the text, drop the tag
			continue;
		}
		const el = document.createElement(child.tagName.toLowerCase());
		const cls = child.getAttribute('class');
		if (cls) el.className = cls;
		if (child.tagName === 'A') {
			const href = child.getAttribute('href') ?? '';
			if (/^https?:/i.test(href)) {
				el.setAttribute('href', href);
				el.setAttribute('target', '_blank');
			}
		}
		sanitize(child, el);
		out.append(el);
	}
}

/** "Alexander 2023" — the author-year label a chip shows. */
export const entryLabel = (e) => [e.authors, e.year].filter(Boolean).join(' ') || e.key;

const pandocOn = () => vaultSettingsStore.get('pandocCitations') === true;

export class ClewBibliography extends ClewElement {
	#refresh = debounce(() => this.render(), 200);
	#renderToken = 0;
	#mode = null;          // 'note' | 'library'
	#query = '';
	#filter = 'all';       // 'all' | 'cited' | 'uncited'
	#focusKey = null;      // an entry to scroll to and highlight
	#open = new Set();     // entries whose "cited in" list is disclosed

	subscribe() {
		this.listen(workspaceStore, 'active-changed', () => this.#refresh());
		this.listen(workspaceStore, 'layout-changed', () => { if (this.#currentMode() === 'note') this.#refresh(); });
		this.listen({ on: ipc.on }, CH.EV_RENDER_DONE, ({ path }) => {
			if (this.#currentMode() === 'note' && path === workspaceStore.activeTab()?.path) this.#refresh();
		});
		this.listen(vaultStore, 'index-changed', () => { if (this.#currentMode() === 'library') this.#refresh(); });
	}

	/** Open the Library at `key`, highlighted (a citation chip's click). */
	showEntry(key) {
		this.#mode = 'library';
		this.#focusKey = key;
		this.#query = '';
		this.#filter = 'all';
		this.render();
	}

	/** "This note" needs the vault's bibliographyPanel (it renders the note). */
	#noteModeAllowed() { return vaultSettingsStore.get('bibliographyPanel') === true; }

	#currentMode() {
		return this.#mode ?? (this.#noteModeAllowed() ? 'note' : 'library');
	}

	async render() {
		this.classList.add('panel-scroll');
		const token = ++this.#renderToken;
		const body = this.#currentMode() === 'library' ? await this.#library(token) : await this.#note(token);
		if (token !== this.#renderToken || !body) return;
		this.replaceChildren(this.#modeSwitch(), body);
		if (this.#focusKey) {
			const row = this.querySelector(`.bib-row[data-key="${CSS.escape(this.#focusKey)}"]`);
			row?.classList.add('is-focused');
			row?.scrollIntoView({ block: 'center' });
			this.#focusKey = null;
		}
	}

	#modeSwitch() {
		const bar = document.createElement('div');
		bar.className = 'bib-modes';
		for (const [mode, label] of [['note', 'This note'], ['library', 'Library']]) {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'bib-mode';
			b.textContent = label;
			b.setAttribute('aria-pressed', String(this.#currentMode() === mode));
			b.addEventListener('click', () => { this.#mode = mode; this.render(); });
			bar.append(b);
		}
		return bar;
	}

	async #note(token) {
		if (!this.#noteModeAllowed()) {
			return this.#empty('The note’s formatted bibliography is off for this vault (Settings → this vault → References panel). The Library works regardless.');
		}
		const path = workspaceStore.activeTab()?.path;
		if (!path || !NOTE_FILE.test(path)) return this.#empty('No active note');
		let html;
		try {
			html = await ipc.invoke(CH.RENDER_HTML, { path });
		} catch {
			return this.#empty('Could not render this note');
		}
		if (token !== this.#renderToken || workspaceStore.activeTab()?.path !== path) return null;
		const doc = new DOMParser().parseFromString(html, 'text/html');
		const source = doc.querySelector('.clew-bib-panel-source');
		const entries = source?.querySelectorAll('.csl-entry') ?? [];
		if (!source || entries.length === 0) return this.#empty('No citations in this note');
		const frag = document.createDocumentFragment();
		const title = document.createElement('div');
		title.className = 'link-group-title is-static panel-section-title';
		title.textContent = `References (${entries.length})`;
		frag.append(title);
		const list = document.createElement('div');
		list.className = 'bibliography-entries';
		sanitize(source, list);
		frag.append(list);
		return frag;
	}

	async #library(token) {
		const entries = await allBibEntries();
		if (token !== this.#renderToken) return null;
		const frag = document.createDocumentFragment();
		if (!entries.length) {
			frag.append(this.#empty('No .bib files in this vault'));
			return frag;
		}
		const tools = document.createElement('div');
		tools.className = 'bib-tools';
		const search = document.createElement('input');
		search.type = 'search';
		search.className = 'bib-search';
		search.placeholder = 'Search key, author, title…';
		search.value = this.#query;
		search.addEventListener('input', () => {
			this.#query = search.value;
			this.#fillRows(list, entries);
		});
		const filter = document.createElement('select');
		filter.className = 'bib-filter';
		for (const [value, label] of [['all', 'All'], ['cited', 'Cited'], ['uncited', 'Uncited']]) {
			const o = document.createElement('option');
			o.value = value;
			o.textContent = label;
			filter.append(o);
		}
		filter.value = this.#filter;
		filter.addEventListener('change', () => { this.#filter = filter.value; this.#fillRows(list, entries); });
		tools.append(search, filter);
		const list = document.createElement('div');
		list.className = 'bib-library';
		this.#fillRows(list, entries);
		frag.append(tools, list);
		return frag;
	}

	#fillRows(list, entries) {
		const pandoc = pandocOn();
		const q = this.#query.trim();
		const rows = [];
		for (const e of entries) {
			const citers = vaultStore.citedBy(e.key, { pandoc });
			if (this.#filter === 'cited' && !citers.length) continue;
			if (this.#filter === 'uncited' && citers.length) continue;
			// Every term a substring of key/authors/title/year — a fuzzy
			// subsequence is too loose for a library ("alex" would find the
			// letters of "LaTeX" in Lamport's title); the key ranks first.
			const hay = `${e.key} ${e.authors} ${e.title} ${e.year}`.toLowerCase();
			const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
			if (!terms.every((t) => hay.includes(t))) continue;
			const score = terms.length ? (fuzzyScore(q, e.key) ?? 0) + (e.key.toLowerCase().startsWith(terms[0]) ? 100 : 0) : 0;
			rows.push({ e, citers, score });
		}
		if (q) rows.sort((a, b) => b.score - a.score);
		list.replaceChildren(...rows.map(({ e, citers }) => this.#row(e, citers)));
		list.dataset.count = String(rows.length);
	}

	#row(e, citers) {
		const row = document.createElement('div');
		row.className = 'bib-row';
		row.dataset.key = e.key;
		const head = document.createElement('div');
		head.className = 'bib-head';
		const label = document.createElement('span');
		label.className = 'bib-label';
		label.textContent = entryLabel(e);
		const key = document.createElement('span');
		key.className = 'bib-key';
		key.textContent = e.key;
		head.append(label, key);
		const title = document.createElement('div');
		title.className = 'bib-title';
		title.textContent = e.title;
		const cited = document.createElement('button');
		cited.type = 'button';
		cited.className = 'bib-cited';
		cited.dataset.count = String(citers.length);
		cited.textContent = citers.length ? `Cited in ${citers.length} note${citers.length === 1 ? '' : 's'}` : 'Not cited';
		cited.disabled = !citers.length;
		const notes = document.createElement('div');
		notes.className = 'bib-citers';
		notes.hidden = !this.#open.has(e.key);
		for (const c of citers) {
			const a = document.createElement('button');
			a.type = 'button';
			a.className = 'bib-citer';
			a.textContent = c.path.replace(/\.(md|jmd)$/i, '');
			a.title = `${c.path}, line ${c.line}`;
			a.addEventListener('click', () => openNoteAtLine(c.path, c.line));
			notes.append(a);
		}
		cited.addEventListener('click', () => {
			notes.hidden = !notes.hidden;
			if (notes.hidden) this.#open.delete(e.key); else this.#open.add(e.key);
		});
		const actions = document.createElement('div');
		actions.className = 'bib-actions';
		const act = (text, cls, fn, enabled = true, tip = '') => {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = `bib-action ${cls}`;
			b.textContent = text;
			b.disabled = !enabled;
			if (tip) b.title = tip;
			b.addEventListener('pointerdown', (ev) => ev.preventDefault()); // keep the editor's caret
			b.addEventListener('click', fn);
			actions.append(b);
		};
		act('Insert', 'bib-insert', () => this.#insert(e.key), true, pandocOn() ? `Insert [@${e.key}]` : `Insert \\cite{${e.key}}`);
		act('Copy key', 'bib-copy', () => navigator.clipboard.writeText(e.key).catch(() => {}));
		const pdf = e.pdf;
		act('PDF', 'bib-pdf', () => this.#openPdf(e), Boolean(pdf),
			!pdf ? 'No file field' : pdf.exists ? pdf.path : `Missing: ${pdf.path}`);
		const link = e.doi ? `https://doi.org/${e.doi}` : e.url;
		act(e.doi ? 'DOI' : 'URL', 'bib-link', () => ipc.invoke(CH.SHELL_OPEN_EXTERNAL, { url: link }).catch(() => {}), Boolean(link), link || 'No DOI or URL');
		row.append(head, title, cited, notes, actions);
		return row;
	}

	#insert(key) {
		const view = activeEditorView();
		if (!view) { notice('No note is being edited'); return; }
		const text = pandocOn() ? `[@${key}]` : `\\cite{${key}}`;
		const { from, to } = view.state.selection.main;
		view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
		view.focus();
	}

	#openPdf(e) {
		openEntryPdf(e);
	}

	#empty(text) {
		const el = document.createElement('p');
		el.className = 'panel-empty';
		el.textContent = text;
		return el;
	}
}

customElements.define('clew-bibliography', ClewBibliography);
