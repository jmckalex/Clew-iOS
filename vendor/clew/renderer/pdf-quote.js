// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Quote-and-cite from a PDF (FEATURE-IDEAS #2): text selected in any PDF
// viewer — a tab, a canvas card, a note's embed — goes into the note being
// written, at its cursor, as a blockquote with a citation and a link back
// to the page. The pure half (the text, the escaping, where it goes) is
// shared/pdf-quote.js; the viewer's half is preview-client/pdf-core.js.
//
// Two ways in, one way out: the "Quote in note" item in the viewer's own
// selection menu sends the quote unasked, and the `pdf:quote-selection`
// command asks the document that last reported a selection for it. Both
// arrive here as one `pdf-quote` message.
import { workspaceStore } from './state/workspace-store.js';
import { vaultStore } from './state/vault-store.js';
import { vaultSettingsStore } from './state/vault-settings-store.js';
import { editorPool } from './editor/pool.js';
import { ipc, CH } from './ipc.js';
import { notice } from './plugins.js';
import { openListModal } from './components/modals/list-modal.js';
import { openInputModal } from './components/modals/input-modal.js';
import { fromPreviewOrigin, postTo, PREVIEW_ORIGIN } from '../shared/message-guard.js';
import { cleanPdfText, quoteBlock, placeQuote, printedPage } from '../shared/pdf-quote.js';

const REQUEST_TIMEOUT_MS = 3000;

/** The document whose viewer holds the newest selection, as the viewers
 *  report it: { source: WindowProxy, origin }. */
let selection = null;
const pending = new Map();
let requestSeq = 0;
/** The note tab most recently active in an editing mode. */
let lastNoteTab = null;

const editing = (tab) => tab?.kind === 'note' && Boolean(tab.path) && tab.view?.mode !== 'reading';

/**
 * The note the quote goes into: the active tab when it is a note being
 * edited; else the note last edited (a PDF opened beside it, or in its
 * place, has taken the focus); else the one note being edited on screen.
 * A note in reading mode has no cursor and is never written into.
 */
function targetNote() {
	const active = workspaceStore.activeTab();
	if (editing(active)) return active;
	const last = lastNoteTab && workspaceStore.findTab(lastNoteTab)?.tab;
	if (editing(last)) return last;
	const shown = workspaceStore.allGroups()
		.map((g) => g.tabs.find((t) => t.id === g.activeTabId))
		.filter(editing);
	return shown.length === 1 ? shown[0] : null;
}

/** The PDF as a wikilink target: its name when no other file in the vault
 *  has that name, else its vault path. */
function linkTarget(path) {
	const name = path.split('/').pop();
	let same = 0;
	const walk = (entries) => {
		for (const e of entries ?? []) {
			if (e.type === 'folder') walk(e.children);
			else if (e.path.split('/').pop() === name) same += 1;
		}
	};
	walk(vaultStore.tree);
	return same > 1 ? path : name;
}

/**
 * The .bib entry this PDF is, in this order (the owner's rules, 2026-10-03):
 *
 * 1. the entry whose `file` field resolves to it — the .bib's own word wins;
 * 2. the entry chosen for it before, remembered IN THE VAULT
 *    (`.clew/pdf-citations.json`, main/pdf-meta.js — never in the .bib,
 *    whose files may be links to one shared master), "no citation" included;
 *    a remembered key that no .bib holds any more asks again;
 * 3. otherwise a picker — several entries naming the PDF, or none while the
 *    vault has a bibliography — whose answer is then remembered.
 *
 * No .bib at all → no citation, and the notice says why. `change`: the
 * picker regardless (the "change the citation" command), the current
 * choice marked.
 * @returns {Promise<{ key: string|null, cancelled?: boolean, why?: string,
 *   remembered?: boolean, fromFile?: boolean }>}
 */
async function citationKey(path, { change = false } = {}) {
	const entries = await ipc.invoke(CH.BIB_ENTRIES).catch(() => []);
	const exact = entries.filter((e) => e.pdf?.inVault && e.pdf.path === path);
	if (exact.length === 1 && !change) return { key: exact[0].key, fromFile: true };
	if (!entries.length) return { key: null, why: 'this vault has no .bib file' };
	const meta = await ipc.invoke(CH.PDF_META_GET, { path }).catch(() => null);
	const remembered = meta && 'key' in meta ? meta.key : undefined;
	let stale = null;
	if (!change && remembered !== undefined) {
		if (remembered === null) return { key: null, remembered: true };
		if (entries.some((e) => e.key === remembered)) return { key: remembered, remembered: true };
		stale = remembered;   // gone from every .bib: ask again
	}
	const picked = await pickEntry(path, entries, exact, { stale, current: change ? remembered : undefined });
	if (!picked.cancelled) await ipc.invoke(CH.PDF_META_SET, { path, patch: { key: picked.key } }).catch(() => {});
	return picked;
}

/** The picker: "no citation", entries naming the PDF (or with its file
 *  name) first, then the rest. Resolves { key } or { cancelled }. */
function pickEntry(path, entries, exact, { stale = null, current = undefined } = {}) {
	const name = path.split('/').pop().toLowerCase();
	// A .bib written on another machine names the file by a path that is not
	// this one; the same file NAME is the next best hint, offered first.
	const named = exact.length ? exact : entries.filter((e) => e.pdf?.path?.split(/[\\/]/).pop().toLowerCase() === name);
	const rest = entries.filter((e) => !named.includes(e));
	let resolveKey;
	const chosen = new Promise((resolve) => { resolveKey = resolve; });
	const mark = (key) => (current !== undefined && current === key ? 'current' : '');
	const row = (e, hint) => ({
		label: e.key,
		detail: [e.authors, e.year, e.title].filter(Boolean).join(' · '),
		hint: mark(e.key) || hint,
		run: () => resolveKey({ key: e.key }),
	});
	if (document.querySelector('.clew-modal')) return Promise.resolve({ key: null, cancelled: true });
	const file = path.split('/').pop();
	openListModal({
		placeholder: stale ? `${stale} is no longer in any .bib — cite ${file} as which entry? (remembered for this PDF)`
			: current !== undefined ? `Cite ${file} as which entry? (remembered for this PDF)`
				: exact.length ? `Several entries name ${file} — cite which? (remembered for this PDF)`
					: `No .bib entry names ${file} in its file field — cite which entry? (remembered for this PDF)`,
		items: [
			{ label: 'Quote without a citation', detail: 'just the text and the page link', hint: mark(null), run: () => resolveKey({ key: null }) },
			...named.map((e) => row(e, exact.length ? 'names this PDF' : 'same file name')),
			...rest.map((e) => row(e)),
		],
	});
	// The modal says nothing when dismissed; notice its removal instead.
	const modal = document.querySelector('.clew-modal');
	if (modal) {
		new MutationObserver((_, obs) => {
			if (!modal.isConnected) { obs.disconnect(); setTimeout(() => resolveKey({ key: null, cancelled: true }), 0); }
		}).observe(document.body, { childList: true });
	}
	return chosen;
}

/** PDFs whose remembered entry has been named in a notice this session. */
const announced = new Set();
/** PDFs quoted with their PDF page as the cited one, said once a session. */
const unprinted = new Set();
/** The PDF last quoted from, for the "change the citation" command. */
let lastQuotedPdf = null;

/**
 * The command "PDF: change the citation for this PDF…": the active PDF
 * tab's, else the PDF last quoted from.
 */
export async function changePdfCitation() {
	const tab = workspaceStore.activeTab();
	const path = tab?.kind === 'file' && /\.pdf$/i.test(tab.path ?? '') ? tab.path : lastQuotedPdf;
	if (!path) { notice('Open the PDF (or quote from it) first.'); return; }
	const entries = await ipc.invoke(CH.BIB_ENTRIES).catch(() => []);
	const exact = entries.filter((e) => e.pdf?.inVault && e.pdf.path === path);
	if (exact.length === 1) {
		notice(`The .bib names ${path.split('/').pop()} in its file field (${exact[0].key}), and that wins — change the .bib to change it.`, 7000);
		return;
	}
	if (!entries.length) { notice('This vault has no .bib file to cite from.'); return; }
	const picked = await citationKey(path, { change: true });
	if (picked.cancelled) return;
	notice(picked.key ? `${path.split('/').pop()} is now cited as ${picked.key}.` : `${path.split('/').pop()} is now quoted without a citation.`, 5000);
}

/** Ask a viewer's document for the page in view: { path, page, label,
 *  textOffset } or null. */
function currentPage(target, origin) {
	const requestId = ++requestSeq;
	return new Promise((resolve) => {
		const timer = setTimeout(() => { pending.delete(requestId); resolve(null); }, REQUEST_TIMEOUT_MS);
		pending.set(requestId, (msg) => { clearTimeout(timer); resolve(msg); });
		postTo(target, { source: 'clew-pdf-host', type: 'pdf-current-page', requestId }, origin);
	});
}

/**
 * The command "PDF: set the printed page number…": what the page in view
 * (the active PDF tab's, else the viewer with the newest selection's) is
 * printed as. Stored as an offset, BY HAND (main/pdf-meta.js), which
 * outranks the PDF's labels and its text; an empty answer forgets it.
 */
export async function setPrintedPage() {
	const tab = workspaceStore.activeTab();
	const frame = tab?.kind === 'file' && /\.pdf$/i.test(tab.path ?? '')
		? [...document.querySelectorAll('clew-file-view:not([data-clew-retiring])')].find((v) => v.path === tab.path)?.querySelector('iframe.pdf-frame')
		: null;
	const target = frame?.contentWindow ?? (selection && !selection.source.closed ? selection.source : null);
	if (!target) { notice('Open the PDF first, at a page whose printed number you know.'); return; }
	const here = await currentPage(target, frame ? PREVIEW_ORIGIN : selection.origin);
	if (!here?.page || !here.path) { notice('The PDF did not say which page is showing — try again once it has loaded.'); return; }
	const { path, page } = here;
	const file = path.split('/').pop();
	const meta = await ipc.invoke(CH.PDF_META_GET, { path }).catch(() => null);
	const now = printedPage({ pdfPage: page, label: here.label, meta, textOffset: here.textOffset });
	const from = { manual: 'set by hand', label: "the PDF's page labels", text: 'the page numbers printed on it', pdf: 'nothing found — the PDF page' }[now.source];
	const answer = await openInputModal({
		placeholder: `PDF page ${page} of ${file} is printed as…`,
		value: now.printed,
		hint: `Now p. ${now.printed} (${from}). Type the number printed on PDF page ${page}; every page follows from it. Empty forgets a number set by hand.`,
	});
	if (answer === null) return;
	const typed = answer.trim();
	if (!typed) {
		if (meta?.offsetSource === 'manual') await ipc.invoke(CH.PDF_META_SET, { path, patch: { offset: undefined, offsetSource: undefined } }).catch(() => {});
		notice(`${file}: no printed page set by hand — quotes cite what the PDF itself says.`, 5000);
		return;
	}
	if (!/^\d{1,5}$/.test(typed)) {
		notice('A page number, in digits — roman front matter comes only from the PDF\'s own page labels.', 6000);
		return;
	}
	const offset = Number(typed) - page;
	await ipc.invoke(CH.PDF_META_SET, { path, patch: { offset, offsetSource: 'manual' } }).catch(() => {});
	notice(`${file}: PDF page ${page} is cited as p. ${typed}, and every page by the same offset (remembered for this PDF).`, 6000);
}

/** Put a viewer's `pdf-quote` into the note being written. */
async function quote(msg) {
	if (msg.empty) { notice('Select some text in a PDF first.'); return; }
	if (msg.error === 'copy-denied') { notice('This PDF does not allow its text to be copied.'); return; }
	if (msg.error) { notice(`Could not read the selection: ${msg.error}`); return; }
	if (msg.remote) {
		notice('This PDF is from the web — save a copy to the vault (Save a copy, above it) and quote from the copy.', 6000);
		return;
	}
	const text = cleanPdfText(msg.text ?? []);
	if (!text) { notice('The selection has no text in it (a scanned page?).'); return; }
	const tab = targetNote();
	if (!tab) {
		notice('No note is being edited — open one in source or live mode and put the cursor where the quote should go.', 6000);
		return;
	}
	const path = String(msg.path);
	const page = Number(msg.page) || 1;
	lastQuotedPdf = path;
	const { key, cancelled, why, remembered } = await citationKey(path);
	if (cancelled) return;
	// The page the article PRINTS, cited in place of the PDF's: a number set
	// by hand, the PDF's /PageLabels, the offset its headers and footers
	// agree on — found now (and remembered: the vault keeps it beside the
	// entry) or before — else the PDF's page.
	const meta = await ipc.invoke(CH.PDF_META_GET, { path }).catch(() => null);
	const textOffset = Number.isFinite(msg.textOffset) ? msg.textOffset : null;
	const { printed, source } = printedPage({ pdfPage: page, label: msg.label, meta, textOffset });
	if (source === 'text' && textOffset !== null && meta?.offsetSource !== 'manual' && meta?.offset !== textOffset) {
		await ipc.invoke(CH.PDF_META_SET, { path, patch: { offset: textOffset, offsetSource: 'text' } }).catch(() => {});
	}
	// Asked again: the picker may have taken a while, and the tab with it.
	const view = editorPool.get(tab.id)?.view;
	if (!view || !workspaceStore.findTab(tab.id)) { notice('The note closed before the quote could go in.'); return; }
	const block = quoteBlock({
		text, page, printed, key, link: linkTarget(path),
		pandoc: vaultSettingsStore.get('pandocCitations') === true,
		normalSyntax: vaultSettingsStore.get('normalSyntax') === true,
	});
	const at = view.state.selection.main.to;
	const place = placeQuote(view.state.doc.toString(), at, block);
	view.dispatch({
		changes: { from: place.from, to: place.to, insert: place.insert },
		selection: { anchor: place.cursor },
		scrollIntoView: true,
		userEvent: 'input.paste',
	});
	// The tab's recorded cursor too: the host restores it when the note is
	// shown again (a mode switch, a split), and a recorded spot from before
	// the insert would now be inside the quote.
	const head = view.state.selection.main.head;
	workspaceStore.updateTabView(tab.id, { cursor: { anchor: head, head }, cursorLine: view.state.doc.lineAt(head).number });
	const name = tab.path.split('/').pop().replace(/\.(md|jmd)$/i, '');
	// A remembered choice is said once (per PDF, per session), so it is
	// never invisible: what was chosen, and how to change it.
	let said = '';
	if (remembered && !announced.has(path)) {
		announced.add(path);
		said = ` — ${key ? `cited as ${key}` : 'without a citation'}, as remembered for this PDF ("PDF: change the citation for this PDF…" to change it)`;
	}
	// The PDF's own page cited, because nothing said what it prints: once.
	if (!said && key && source === 'pdf' && !unprinted.has(path)) {
		unprinted.add(path);
		said = ` — citing the PDF's page: it has no page labels and no page numbers Clew could read ("PDF: set the printed page number…" to set them)`;
	}
	const pages = printed === String(page) ? `p. ${page}` : `p. ${printed} (PDF p. ${page})`;
	notice(why ? `Quoted ${pages} into ${name}, without a citation: ${why}.` : `Quoted ${pages} into ${name}${said}.`, said ? 8000 : 3000);
}

/** The command: ask the document holding the newest selection for it. */
export function quoteSelection() {
	if (!selection || selection.source.closed) { notice('Select some text in a PDF first.'); return Promise.resolve(); }
	const requestId = ++requestSeq;
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			pending.delete(requestId);
			notice('The PDF did not answer — select the text again.');
			resolve();
		}, REQUEST_TIMEOUT_MS);
		pending.set(requestId, (msg) => { clearTimeout(timer); quote(msg).finally(resolve); });
		postTo(selection.source, { source: 'clew-pdf-host', type: 'pdf-quote-request', requestId }, selection.origin);
	});
}

/** True when a viewer has reported a selection (the command's `when`). */
export const hasPdfSelection = () => Boolean(selection && !selection.source.closed);

export function installPdfQuote() {
	const track = () => {
		const tab = workspaceStore.activeTab();
		if (editing(tab)) lastNoteTab = tab.id;
	};
	workspaceStore.on('active-changed', track);
	workspaceStore.on('layout-changed', track);
	window.addEventListener('message', (event) => {
		// A viewer anywhere under this page: a tab's or canvas card's frame, a
		// note's embed, a canvas scene inside a note — all on the preview origin.
		if (!fromPreviewOrigin(event)) return;
		const msg = event.data;
		if (msg?.source !== 'clew-pdf') return;
		if (msg.type === 'pdf-selection') {
			if (msg.has) selection = { source: event.source, origin: event.origin };
			else if (selection?.source === event.source) selection = null;
		} else if (msg.type === 'pdf-current-page') {
			const answer = pending.get(msg.requestId);
			pending.delete(msg.requestId);
			answer?.(msg);
		} else if (msg.type === 'pdf-quote') {
			if (msg.requestId != null) {
				const answer = pending.get(msg.requestId);
				pending.delete(msg.requestId);
				answer?.(msg);
			} else quote(msg);
		}
	});
}
