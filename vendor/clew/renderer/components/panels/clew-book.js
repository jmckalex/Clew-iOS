// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The Book panel (docs/dev/book-mode.md §2, D8 and D13): a book's chapters in
// order — title, words, status — with the book's totals; drag a row's grip
// (or Alt+↑/↓ on a focused row) to reorder, remove a chapter, add the active
// note, set a chapter's status. Every change is a write to a NOTE — the
// master's `chapters:` or a chapter's `status:` — through editor/note-edit.js,
// so an open editor takes it as an edit (undo, dirty dot, auto-save) and a
// conflict holds it like any other. A master whose front matter is beyond
// the editable subset, or whose chapter list has entries the reader could
// not take, is shown but never rewritten.
import { ClewElement } from '../base/clew-element.js';
import { vaultStore } from '../../state/vault-store.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { debounce } from '../../lib/debounce.js';
import { emptyNote } from './clew-backlinks.js';
import { notice } from '../../plugins.js';
import { showMenu } from '../chrome/menu.js';
import { editNote } from '../../editor/note-edit.js';
import { parseProperties, applyProperties } from '../../../shared/frontmatter.js';
import { BOOK_STATUSES, readMaster, laterNotice, moveChapter, withChapters, chapterLink } from '../../../shared/book.js';
import { masterEntry, shownBook, bookTitle, noteFacts, bookBuilds, buildBook, showBookWarnings } from '../../books.js';

const baseName = (rel) => rel.split('/').pop().replace(/\.(md|jmd)$/i, '');
const formatCount = (n) => n.toLocaleString('en-US');

export class ClewBook extends ClewElement {
	#refresh = debounce(() => this.render(), 120);
	/** A book the user picked from the list, while the same note is active. */
	#picked = null;
	/** The order just written, shown until the index catches up with it. */
	#pending = null;
	/** The shown master's chapter links AS WRITTEN (aliases and all), from
	 *  its text: what a rewrite of the list puts back. */
	#written = [];
	#generation = 0;

	subscribe() {
		this.listen(workspaceStore, 'active-changed', () => this.#refresh());
		this.listen(workspaceStore, 'layout-changed', () => this.#refresh());
		this.listen(workspaceStore, 'book-changed', () => this.#refresh());
		this.listen(bookBuilds, 'changed', () => this.#refresh());
		this.listen(vaultStore, 'index-changed', (path) => {
			if (this.#pending && (!path || path === this.#pending.master)) this.#pending = null;
			this.#refresh();
		});
	}

	#master(active) {
		if (this.#picked && this.#picked.forPath === active && masterEntry(this.#picked.master)) return this.#picked.master;
		this.#picked = null;
		return shownBook(active);
	}

	async render() {
		const generation = ++this.#generation;
		this.classList.add('panel-scroll', 'clew-book');
		const active = workspaceStore.activeTab()?.path ?? null;
		const master = this.#master(active);
		if (!master) {
			this.replaceChildren(emptyNote('No book in this vault — a book is a note whose front matter says “book: true” and lists its chapters.'));
			return;
		}
		const entry = masterEntry(master);
		const resolved = entry.chapters.map((c) => c.resolved ?? null);
		const order = this.#pending?.master === master ? this.#pending.order : resolved.map((_, i) => i);
		const [masterFacts, ...chapterFacts] = await Promise.all([
			noteFacts(master),
			...order.map((i) => (resolved[i] ? noteFacts(resolved[i]) : null)),
		]);
		if (generation !== this.#generation) return;   // a newer render is under way
		const book = masterFacts?.master;
		const editable = Boolean(book?.clean) && !book.problems.some((p) => p.startsWith('chapters:'))
			&& book.chapters.length === entry.chapters.length;
		this.#written = editable ? book.chapters.map((c) => c.link) : [];

		const frag = document.createDocumentFragment();
		frag.append(this.#header(master, active, book));
		for (const line of [laterNotice(book?.later), ...(book?.problems ?? [])].filter(Boolean)) {
			frag.append(this.#note(line, 'is-warning'));
		}
		if (book && !book.clean) frag.append(this.#note('Its front matter is beyond what Clew edits, so the list is shown but not changed here.', 'is-warning'));

		const list = document.createElement('div');
		list.className = 'book-chapters';
		let words = 0;
		const tally = new Map(BOOK_STATUSES.map((s) => [s, 0]));
		let unset = 0;
		order.forEach((at, row) => {
			const chapter = entry.chapters[at];
			const path = resolved[at];
			const facts = chapterFacts[row];
			if (facts) {
				words += facts.words;
				if (facts.status) tally.set(facts.status, tally.get(facts.status) + 1);
				else unset++;
			}
			list.append(this.#row({ master, row, at, chapter, path, facts, active, editable, order }));
		});
		if (!order.length) list.append(emptyNote('No chapters yet — add a note below, or list them under “chapters:” in the master.'));
		frag.append(list);

		const totals = document.createElement('div');
		totals.className = 'book-totals';
		const parts = [`${order.length} chapter${order.length === 1 ? '' : 's'}`, `${formatCount(words)} words`];
		const statusParts = BOOK_STATUSES.filter((s) => tally.get(s)).map((s) => `${tally.get(s)} ${s}`);
		if (unset && statusParts.length) statusParts.push(`${unset} without a status`);
		totals.textContent = [...parts, ...statusParts].join(' · ');
		totals.title = 'Words of prose: front matter, code, maths and comments are not counted.';
		frag.append(totals);
		frag.append(this.#addButton(master, active, entry, editable, order));
		frag.append(this.#build(master, resolved));
		this.replaceChildren(frag);
	}

	#header(master, active, book) {
		const head = document.createElement('div');
		head.className = 'book-head';
		const masters = vaultStore.masters();
		if (masters.length > 1) {
			const pick = document.createElement('select');
			pick.className = 'book-pick';
			pick.title = 'Show another book';
			for (const m of masters) {
				const option = document.createElement('option');
				option.value = m;
				option.textContent = bookTitle(m);
				option.selected = m === master;
				pick.append(option);
			}
			pick.addEventListener('change', () => {
				this.#picked = { master: pick.value, forPath: active };
				workspaceStore.setRecentBook(pick.value);
				this.render();
			});
			head.append(pick);
		} else {
			const title = document.createElement('div');
			title.className = 'book-title';
			title.textContent = bookTitle(master);
			head.append(title);
		}
		const meta = document.createElement('div');
		meta.className = 'book-meta';
		const open = document.createElement('a');
		open.className = 'book-open-master';
		open.textContent = baseName(master);
		open.title = `Open the master note, ${master}`;
		open.addEventListener('click', () => workspaceStore.openNote(master));
		meta.append('Master: ', open);
		if (book) meta.append(` · numbered ${book.numbering === 'continuous' ? 'continuously' : 'per chapter'}`);
		head.append(meta);
		return head;
	}

	#note(text, className = '') {
		const el = document.createElement('div');
		el.className = `book-note ${className}`.trim();
		el.textContent = text;
		return el;
	}

	#row({ master, row, at, chapter, path, facts, active, editable, order }) {
		const el = document.createElement('div');
		el.className = 'book-row';
		el.dataset.row = String(row);
		el.tabIndex = 0;
		if (path && path === active) el.classList.add('is-active');
		if (editable) {
			const grip = document.createElement('span');
			grip.className = 'book-grip';
			grip.title = 'Drag to reorder (or Alt+↑/↓)';
			grip.textContent = '⠿';
			grip.addEventListener('pointerdown', (e) => this.#drag(e, master, row, order));
			el.append(grip);
			el.addEventListener('keydown', (e) => {
				if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
				e.preventDefault();
				const to = row + (e.key === 'ArrowUp' ? -1 : 1);
				if (to >= 0 && to < order.length) this.#reorder(master, order, row, to, true);
			});
		}
		const number = document.createElement('span');
		number.className = 'book-num';
		number.textContent = String(row + 1);
		const title = document.createElement('span');
		title.className = 'book-chapter-title';
		el.append(number, title);
		if (!path) {
			el.classList.add('is-dangling');
			title.textContent = `[[${chapter.target}]] — no such note`;
			title.title = 'This chapter links to no note in the vault; a build stops here.';
		} else {
			title.textContent = facts?.title ?? baseName(path);
			title.title = path;
			title.addEventListener('click', () => workspaceStore.openNote(path));
			const words = document.createElement('span');
			words.className = 'book-words';
			words.textContent = facts ? formatCount(facts.words) : '';
			const status = document.createElement('button');
			status.className = 'book-status';
			status.textContent = facts?.status ?? '—';
			status.title = 'This chapter’s status (its own front matter): click to change';
			if (facts?.status) status.dataset.status = facts.status;
			const flagged = (bookBuilds.get(master)?.warnings ?? []).filter((w) => w.path === path).length;
			if (flagged) {
				const warn = document.createElement('button');
				warn.className = 'book-warn';
				warn.textContent = `⚠ ${flagged}`;
				warn.title = 'The last build’s warnings in this chapter — click to list them';
				warn.addEventListener('click', () => showBookWarnings(master, path));
				words.before(warn);
			}
			status.addEventListener('click', () => {
				const r = status.getBoundingClientRect();
				const mark = (value) => ((facts?.status ?? '') === value ? '✓ ' : '\u2003');
				showMenu(r.left, r.bottom + 2, [
					...BOOK_STATUSES.map((value) => ({ label: `${mark(value)}${value}`, click: () => this.#setStatus(path, value) })),
					{ separator: true },
					{ label: `${mark('')}no status`, click: () => this.#setStatus(path, '') },
				]);
			});
			el.append(words, status);
		}
		if (editable) {
			const remove = document.createElement('button');
			remove.className = 'book-remove';
			remove.title = 'Remove from the book (the note itself stays)';
			remove.textContent = '×';
			remove.addEventListener('click', () => this.#remove(master, order, row));
			el.append(remove);
		}
		return el;
	}

	/** Build (book-mode.md §5) and what the last build said. */
	#build(master, resolved) {
		const box = document.createElement('div');
		box.className = 'book-build';
		const row = document.createElement('div');
		row.className = 'book-build-row';
		row.append('Build: ');
		const dangling = resolved.some((p) => !p);
		for (const [format, label] of [['pdf', 'PDF'], ['latex', 'LaTeX'], ['html', 'HTML']]) {
			const button = document.createElement('button');
			button.className = 'book-build-button';
			button.dataset.format = format;
			button.textContent = label;
			button.disabled = dangling || !resolved.length;
			button.title = dangling ? 'A chapter links to no note — fix the list first'
				: `Build the book as ${label} into build/ beside its master`;
			button.addEventListener('click', () => buildBook(master, format));
			row.append(button);
		}
		box.append(row);
		const last = bookBuilds.get(master);
		if (last) {
			const said = document.createElement('div');
			said.className = 'book-build-last';
			if (last.error) {
				said.classList.add('is-error');
				said.textContent = `Last build failed: ${last.error}`;
			} else {
				said.append(`Last build: ${last.output}`);
				if (last.warnings.length) {
					const warn = document.createElement('button');
					warn.className = 'book-warn';
					warn.textContent = `⚠ ${last.warnings.length}`;
					warn.title = 'Click to list them — each opens its chapter at its line';
					warn.addEventListener('click', () => showBookWarnings(master));
					said.append(' · ', warn);
				}
			}
			box.append(said);
		}
		return box;
	}

	#addButton(master, active, entry, editable, order) {
		const button = document.createElement('button');
		button.className = 'book-add';
		const isNote = active && /\.(md|jmd)$/i.test(active) && !masterEntry(active);
		const inBook = entry.chapters.some((c) => c.resolved === active);
		button.textContent = isNote && !inBook ? `Add “${baseName(active)}” to this book` : 'Add the active note to this book';
		button.disabled = !editable || !isNote || inBook;
		if (inBook) button.title = 'The active note is already a chapter';
		else if (!editable) button.title = 'The chapter list cannot be changed here';
		button.addEventListener('click', () => {
			const unambiguous = vaultStore.resolveNoteName(baseName(active)) === active;
			this.#write(master, [...this.#links(order), chapterLink(active, unambiguous)]);
		});
		return button;
	}

	/** The chapter links as written in the master, in `order`. */
	#links(order) {
		return order.map((i) => this.#written[i]);
	}

	#remove(master, order, row) {
		const next = order.filter((_, i) => i !== row);
		this.#write(master, this.#links(next));
	}

	#reorder(master, order, from, to, refocus = false) {
		const next = moveChapter(order, from, to);
		this.#pending = { master, order: next };
		this.render().then(() => { if (refocus) this.querySelector(`.book-row[data-row="${to}"]`)?.focus(); });
		this.#write(master, this.#links(next));
	}

	async #write(master, links) {
		const written = this.#written;
		const result = await editNote(master, (text) => {
			// Built from the list as the panel last read it: if the text has
			// moved on since (an unsaved edit of the list), refuse, never clobber.
			const now = readMaster(text)?.chapters.map((c) => c.link) ?? [];
			if (now.length !== written.length || now.some((link, i) => link !== written[i])) {
				throw new Error('its chapter list changed while you were moving it — try again');
			}
			const next = withChapters(text, links);
			if (next === null) throw new Error('its front matter is beyond what Clew edits');
			return next;
		}, { userEvent: 'input.book' }).catch((err) => ({ ok: false, error: { message: err.message } }));
		if (!result.ok) {
			this.#pending = null;
			notice(`Couldn't change the chapters of ${baseName(master)}: ${result.error.message}`, 5000);
			this.render();
		}
	}

	async #setStatus(path, value) {
		const result = await editNote(path, (text) => {
			const { entries, clean, present } = parseProperties(text);
			if (present && !clean) throw new Error('its front matter is beyond what Clew edits');
			const at = entries.findIndex((e) => e.key.toLowerCase() === 'status');
			if (!value) { if (at !== -1) entries.splice(at, 1); }
			else if (at !== -1) entries[at].value = value;
			else entries.push({ key: 'status', value });
			return applyProperties(text, entries);
		}, { userEvent: 'input.book' }).catch((err) => ({ ok: false, error: { message: err.message } }));
		if (!result.ok) {
			notice(`Couldn't set the status of ${baseName(path)}: ${result.error.message}`, 5000);
			this.render();
		}
	}

	/** Reorder by the grip: the row follows the pointer; the drop writes. */
	#drag(event, master, from, order) {
		if (event.button !== 0) return;
		event.preventDefault();
		const grip = event.currentTarget;
		grip.setPointerCapture?.(event.pointerId);
		const rows = [...this.querySelectorAll('.book-row')];
		rows[from]?.classList.add('is-dragging');
		let to = from;
		const mark = () => rows.forEach((r, i) => {
			r.classList.toggle('is-drop-before', i === to && to < from);
			r.classList.toggle('is-drop-after', i === to && to > from);
		});
		const move = (e) => {
			const y = e.clientY;
			to = rows.findIndex((r) => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
			if (to === -1) to = rows.length - 1;
			else if (to > from) to -= 1;
			mark();
		};
		const end = () => {
			grip.removeEventListener('pointermove', move);
			grip.removeEventListener('pointerup', end);
			grip.removeEventListener('pointercancel', cancel);
			rows.forEach((r) => r.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after'));
			if (to !== from) this.#reorder(master, order, from, to);
		};
		const cancel = () => { to = from; end(); };
		grip.addEventListener('pointermove', move);
		grip.addEventListener('pointerup', end);
		grip.addEventListener('pointercancel', cancel);
	}
}

customElements.define('clew-book', ClewBook);
