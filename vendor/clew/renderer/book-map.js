// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The book map in the window (docs/dev/book-mode.md §3, phase 2): a chapter
// shows the numbers the BOOK gives it — the book it shows (D10, books.js) —
// computed by editor/live/book-numbering.js over the master and every
// chapter in order. The texts are an open editor's (unsaved edits too), else
// the file's, read once and again only when the index says it changed. Until
// they are in, a chapter shows its own numbers; when they arrive, or another
// chapter changes what this one starts from, the live editors are rebuilt.
// Installed into editor/live/numbering-source.js, which every consumer asks.
import { vaultStore } from './state/vault-store.js';
import { vaultSettingsStore } from './state/vault-settings-store.js';
import { workspaceStore } from './state/workspace-store.js';
import { editorPool } from './editor/pool.js';
import { ipc, CH } from './ipc.js';
import { numberBook } from './editor/live/book-numbering.js';
import { setBookNumbering } from './editor/live/numbering-source.js';
import { readMaster, chapterTitle } from '../shared/book.js';
import { citationLines } from '../shared/citation-keys.js';
import { bookOfNote, masterEntry, bookTitle } from './books.js';

const books = new Map();   // master → { cache, texts: Map(path → {mtimeMs, text}), loading, generation }
const results = new WeakMap();   // doc → { key, result }: one count per keystroke, whoever asks

/** The book whose numbers `path` shows: its own when it is a master. */
function bookFor(path) {
	if (masterEntry(path)) return path;
	return bookOfNote(path)?.master ?? null;
}

const chaptersOf = (master) => (masterEntry(master)?.chapters ?? []).map((c) => c.resolved).filter(Boolean);

/** The text an open editor holds for `path`, unsaved edits and all. */
function editorText(path) {
	for (const id of editorPool.tabsFor(path)) {
		const view = editorPool.get(id)?.view;
		if (view) return view.state.doc.toString();
	}
	return null;
}

function state(master) {
	let b = books.get(master);
	if (!b) books.set(master, (b = { cache: new Map(), texts: new Map(), loading: null, generation: 0, signature: signature(master) }));
	return b;
}

/** What, outside the editors, the book's numbers depend on: its chapter list
 *  and the files of the pieces no editor holds (an open one is read from its
 *  editor, so saving it changes nothing here). */
function signature(master) {
	const pieces = [master, ...chaptersOf(master)];
	return JSON.stringify([pieces, pieces.map((p) => (editorPool.tabsFor(p).length ? 'open' : vaultStore.index[p]?.mtimeMs ?? null))]);
}

/**
 * Are the book's texts in? Starts reading any missing or changed file; a
 * book is usable once every piece has SOME text (a changed one is shown as it
 * was until its new text arrives, then the editors are rebuilt).
 */
function loaded(master) {
	const b = state(master);
	const paths = [master, ...chaptersOf(master)];
	const mtime = (p) => vaultStore.index[p]?.mtimeMs ?? null;
	const stale = paths.filter((p) => b.texts.get(p)?.mtimeMs !== mtime(p) && editorText(p) === null);
	if (stale.length && !b.loading) {
		b.loading = Promise.all(stale.map(async (p) => {
			const mtimeMs = mtime(p);
			const text = await ipc.invoke(CH.NOTE_READ, { path: p }).then((t) => String(t ?? ''), () => '');
			b.texts.set(p, { mtimeMs, text });
		})).then(() => {
			b.loading = null;
			changed(master);
		});
	}
	return paths.every((p) => b.texts.has(p) || editorText(p) !== null);
}

/** Something the book's numbers depend on moved: count again, redraw. */
function changed(master) {
	const b = books.get(master);
	if (!b) return;
	b.generation += 1;
	editorPool.rebuildLive();
}

function numbering(doc, notePath, options) {
	const master = bookFor(notePath);
	if (!master || !loaded(master)) return null;
	const b = state(master);
	const key = `${master}\u0000${b.generation}\u0000${notePath}\u0000${options?.numbered?.size ?? 0}`;
	const hit = results.get(doc);
	if (hit?.key === key) return hit.result;
	const text = (p) => (p === notePath ? doc.toString() : editorText(p) ?? b.texts.get(p)?.text ?? '');
	const masterText = text(master);
	const book = numberBook({
		master: { path: master, text: masterText },
		chapters: chaptersOf(master).map((p) => ({ path: p, text: text(p) })),
		numbering: readMaster(masterText).numbering,
		numbered: options?.numbered ?? new Map(),
	}, b.cache);
	const piece = book.pieces.get(notePath);
	if (!piece) return null;
	const result = {
		headingsNumeric: piece.headingsNumeric,
		lines: piece.lines,
		labels: book.labels,
		book: { master, title: bookTitle(master), perChapter: book.perChapter, path: notePath },
	};
	results.set(doc, { key, result });
	return result;
}

function pieceText(path) {
	const open = editorText(path);
	if (open !== null) return open;
	for (const b of books.values()) if (b.texts.has(path)) return b.texts.get(path).text;
	return null;
}

function describe(path) {
	const master = bookFor(path);
	if (!master) return null;
	const text = pieceText(path);
	return { book: bookTitle(master), chapter: path === master ? bookTitle(master) : chapterTitle(text ?? '', path) };
}

const contexts = new Map();   // notePath → { sig, context }

/**
 * What a chapter's citation pills render among (cite-text.js; book-mode.md
 * §4): the engine builds a book as ONE document, so a numeric style numbers
 * a citation by its first in the BOOK, and author-date letters (2000a) count
 * every work the book cites. `before`/`after`: the other pieces' citations in
 * book order, each key once, as the index read them from disk
 * (`\command{key}`; a pandoc form as `\cite{key}`, and only where the vault
 * turns them on); `book`: the
 * master then its chapters, whose header main renders them under. `key`
 * changes whenever any of that does — a piece's citations, the master's
 * citation settings, a chapter's own Bibliography.
 */
function citeContext(notePath) {
	const master = bookFor(notePath);
	if (!master) return null;
	const pieces = [master, ...chaptersOf(master)];
	const at = pieces.indexOf(notePath);
	if (at < 0) return null;
	const pandoc = vaultSettingsStore.get('pandocCitations') === true;
	const sig = JSON.stringify([notePath, pieces, pieces.map((p) => vaultStore.index[p]?.mtimeMs ?? null), pandoc, books.get(master)?.generation ?? 0]);
	const known = contexts.get(notePath);
	if (known?.sig === sig) return known.context;
	// Each KEY once, at its first citation: all that numbering by first
	// citation and author-date letters read — and it keeps a big book's
	// context to a few KB of the render body's 100 KB.
	const cites = (list) => {
		const seen = new Set();
		return list.filter((c) => (pandoc || !c.pandoc) && !seen.has(c.key) && seen.add(c.key))
			.map((c) => (c.pandoc ? `\\cite{${c.key}}` : `\\${c.command}{${c.key}}`));
	};
	const citationsOf = (p) => vaultStore.index[p]?.citations ?? [];
	const before = cites(pieces.slice(0, at).flatMap(citationsOf));
	const after = cites(pieces.slice(at + 1).flatMap(citationsOf));
	const headers = pieces.map((p) => citationLines((pieceText(p) ?? '').slice(0, 4096)));
	const context = { book: pieces, before, after, key: JSON.stringify([pieces, before, after, headers]) };
	contexts.set(notePath, { sig, context });
	return context;
}

export function installBookMap() {
	setBookNumbering({ numbering, text: pieceText, describe, citeContext });
	// Another piece edited in an editor: the chapters after it may number
	// differently (continuous numbering, a chapter added) — once typing pauses.
	let pending = new Set();
	let timer = null;
	editorPool.on('view-update', ({ tabId, update }) => {
		if (!update.docChanged) return;
		const path = editorPool.get(tabId)?.path;
		for (const master of books.keys()) {
			if (path === master || chaptersOf(master).includes(path)) pending.add(master);
		}
		if (!pending.size) return;
		clearTimeout(timer);
		timer = setTimeout(() => {
			for (const master of pending) changed(master);
			pending = new Set();
		}, 300);
	});
	// The list, or a file no editor holds (index-changed fires on every save
	// in the vault: only a book whose own signature moved is recounted).
	vaultStore.on('index-changed', () => {
		for (const [master, b] of books) {
			const now = signature(master);
			if (now !== b.signature) { b.signature = now; changed(master); }
		}
	});
	workspaceStore.on('book-changed', () => editorPool.rebuildLive());
	vaultStore.on('vault-changed', () => { books.clear(); contexts.clear(); });
}
