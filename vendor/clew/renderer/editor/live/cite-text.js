// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What a citation pill READS in live edit (§5.14): the ENGINE's text for the
// citation as written — `\citep[see][p. 7]{a}` → "(see A and B 2000, p. 7)",
// in the note's bibliography style, exactly what reading mode shows. Until
// 2026-10-01 the pill made up its own label, and \cite{Akerlof/Kranton:2000}
// read "Kranton 2000" where reading mode said "Akerlof and Kranton (2000)"
// (the owner's report).
//
// ONE render per note, never one per pill or per keystroke: every citation
// in the note, in order (a numeric style numbers by first citation), each in
// a paragraph of its own behind a marker, through the block endpoint the
// hover's \fullcite already uses, so the note's citation header and the
// vault's settings apply exactly as in reading mode. The engine wraps each
// citation in one element carrying `data-bibtex` (its class is the style's:
// `biblify-cite-ref` for chicago, `biblify-vancouver`, …); an unknown key
// stays as written and so reads as none. Debounced, one batch in flight per note, re-asked only
// when the note's citations (or their order) change.
//
// Cached per note under its citation header (shared/citation-keys.js) and
// an epoch that a .bib edit or an engine-reconfiguring vault setting bumps.
// The server side holds a citation to the same rule: fragment-deps.js counts
// it dependent, so a .bib edit retires the cached block. Until the text is
// in, or where the engine gives none (no bibliography, an unknown key), the
// pill shows the local label (complete/citations.js#citationLabel).
import { renderPost } from '../../lib/caller-token.js';
import { blockUrl, blockDocumentUrl } from '../../lib/preview-url.js';
import { ipc, CH } from '../../ipc.js';
import { vaultStore } from '../../state/vault-store.js';
import { vaultSettingsStore } from '../../state/vault-settings-store.js';
import { citationLines } from '../../../shared/citation-keys.js';

const DEBOUNCE_MS = 250;
/** Vault settings that reconfigure the engine (frame-layer.js has the same
 *  list); the render service needs a beat to do it before a re-ask. */
const ENGINE_VAULT_KEYS = new Set(['texFragments', 'normalSyntax', 'jmarkdownProject', 'pandocCitations', 'plugins', 'bibliography', 'bibliographyStyle']);
const RECONFIGURE_MS = 400;
// A plain word: the dialect reads ⟦…⟧ as Mathematica and refused (or, in a
// trusted vault, would have RUN) the first marker tried here.
const MARK = (i) => `clewcite${i}`;
const MARK_RE = /\bclewcite(\d+)\b/;

let epoch = 0;
/** notePath → { sig, texts: Map<source, {text, html}|null>, asked, wanted, timer, busy, again } */
const notes = new Map();
const listeners = new Set();

function changed(notePath) {
	for (const listener of listeners) listener(notePath);
}

function bump() {
	epoch++;
	for (const slot of notes.values()) clearTimeout(slot.timer);
	notes.clear();
	changed(null);
}

ipc.on(CH.EV_FILE_CHANGED, ({ path }) => { if (/\.bib$/i.test(path ?? '')) bump(); });
vaultStore.on('vault-changed', bump);
vaultSettingsStore.on('vault-settings-changed', (key) => {
	if (ENGINE_VAULT_KEYS.has(key)) setTimeout(bump, RECONFIGURE_MS);
});

/** What a note's citations render under: its header's citation keys. */
export function citeSignature(doc) {
	return JSON.stringify(citationLines(doc.sliceString(0, Math.min(doc.length, 4096))));
}

/** Call `listener(notePath | null)` when engine texts arrive or are dropped
 *  (null: all of them). Returns the unsubscribe. */
export function onCiteTexts(listener) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * The engine's text for one citation, as far as it is known.
 *
 * @returns {string|null|undefined} the text; null when the engine rendered
 *   none (no bibliography, an unknown key); undefined when not asked yet
 */
export function engineCiteText(notePath, sig, source) {
	const slot = notes.get(notePath);
	if (!slot || slot.sig !== sig) return undefined;
	const entry = slot.texts.get(source);
	return entry === undefined ? undefined : entry?.text ?? null;
}

/**
 * A `\fullcite`'s rendered entry as INLINE HTML — the engine's, italics and
 * all, rebuilt from allowlisted tags with no attributes (inlineHtml below) —
 * or null/undefined as engineCiteText. Only a \fullcite has one: the engine
 * draws it as `span.fullcite` (jmarkdown e823e76); other commands, and a
 * \fullcite a numeric style renders as its number, are text.
 */
export function engineCiteHtml(notePath, sig, source) {
	const slot = notes.get(notePath);
	if (!slot || slot.sig !== sig) return undefined;
	const entry = slot.texts.get(source);
	return entry === undefined ? undefined : entry?.html ?? null;
}

/**
 * Make sure the engine's texts for a note's citations are in hand, or on
 * their way. Cheap to call on every redraw: it asks only when the list of
 * citations differs from the last one asked for.
 *
 * @param {string|null} notePath
 * @param {string} sig - citeSignature of the note
 * @param {string[]} sources - every citation in the note as written, in
 *   order, distinct
 */
export function wantCiteTexts(notePath, sig, sources) {
	if (!notePath || sources.length === 0) return;
	let slot = notes.get(notePath);
	if (!slot || slot.sig !== sig) {
		if (slot) clearTimeout(slot.timer);
		slot = { sig, texts: new Map(), asked: null, wanted: null, timer: null, busy: false, again: false };
		notes.set(notePath, slot);
	}
	const list = sources.join('\n');
	if (list === slot.asked || list === slot.wanted) return;
	slot.wanted = list;
	clearTimeout(slot.timer);
	slot.timer = setTimeout(() => run(notePath, slot), DEBOUNCE_MS);
}

async function run(notePath, slot) {
	if (slot.busy) { slot.again = true; return; }
	const list = slot.wanted;
	if (list === null || list === slot.asked) return;
	slot.busy = true;
	slot.asked = list;
	const sources = list.split('\n');
	const startEpoch = epoch;
	let texts;
	try {
		texts = await renderCites(notePath, sources);
	} catch {
		// No engine to ask (a vault closing, a render error): the local label
		// stands, and a later change asks again.
		texts = sources.map(() => null);
		slot.asked = null;
	}
	slot.busy = false;
	if (notes.get(notePath) !== slot || epoch !== startEpoch) return;
	slot.texts = new Map(sources.map((source, i) => [source, texts[i]]));
	changed(notePath);
	if (slot.again) {
		slot.again = false;
		run(notePath, slot);
	}
}

// What a \fullcite's entry may keep: inline FORMATTING. Rebuilt, not
// filtered — each kept element is a fresh one with no attributes, so no
// link, style, class or handler from the render reaches the editor's DOM; an
// <a> keeps its text as a span (nothing in the editor should navigate).
const INLINE = new Map([['EM', 'em'], ['I', 'i'], ['STRONG', 'strong'], ['B', 'b'], ['SPAN', 'span'], ['A', 'span'], ['SUB', 'sub'], ['SUP', 'sup']]);

/** An element's content as attribute-free inline HTML. */
function inlineHtml(element) {
	const out = document.createElement('span');
	const copy = (from, to) => {
		for (const node of from.childNodes) {
			if (node.nodeType === Node.TEXT_NODE) {
				to.append(node.data);
			} else if (node.nodeType === Node.ELEMENT_NODE) {
				const tag = INLINE.get(node.tagName);
				const into = tag ? document.createElement(tag) : to;
				copy(node, into);
				if (into !== to) to.append(into);
			}
		}
	};
	copy(element, out);
	return out.innerHTML.replace(/\s+/g, ' ').trim();
}

/** One block render of the note's citations; each one's {text, html}, or null. */
async function renderCites(notePath, sources) {
	const text = sources.map((source, i) => `${MARK(i)} ${source}`).join('\n\n');
	const response = await renderPost(blockUrl(), { text, sourcePath: notePath });
	if (!response.ok) throw new Error(String(response.status));
	const { hash } = await response.json();
	const html = await (await fetch(blockDocumentUrl(hash))).text();
	const doc = new DOMParser().parseFromString(html, 'text/html');
	const out = sources.map(() => null);
	for (const p of doc.querySelectorAll('p')) {
		const mark = MARK_RE.exec(p.textContent ?? '');
		if (!mark) continue;
		const cite = p.querySelector('[data-bibtex]');
		// An unknown key: chicago leaves the command as written (no element),
		// vancouver prints "[undefined]" (an engine quirk) — neither is text
		// to show; the pill's local label marks the key missing instead.
		const text = cite?.textContent.replace(/\s+/g, ' ').trim();
		if (text && !/\bundefined\b/.test(text)) {
			out[Number(mark[1])] = { text, html: cite.classList.contains('fullcite') ? inlineHtml(cite) : null };
		}
	}
	return out;
}
