// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The tiny inline renderer (plan §5.3) for text live edit draws OUTSIDE the
// document flow — table cells, the TOC. It is NOT a markdown renderer and
// must stay this size: it re-uses the constructs the model already found
// in a range (live/model.js) and emits a handful of elements; anything it
// does not know comes out as its source text. The engine renders markdown;
// this only dresses what the editor has already parsed.
//
// Two halves: `inlineTokens` (pure, unit-tested — a token tree) and
// `tokensToDom` (trivial DOM building).
import { numberDocument, refDisplay } from './numbering.js';

/** Styled constructs: which element each becomes. */
const TAGS = {
	strong: 'strong', intense: 'strong', italic: 'em', underline: 'u',
	highlight: 'mark', strike: 'del', sub: 'sub', sup: 'sup', code: 'code',
};

/**
 * The token tree for `[from, to)` of the document.
 *
 * @param {import('@codemirror/state').Text} doc
 * @param {number} from
 * @param {number} to
 * @param {object[]} model - liveModel(state)
 * @returns {object[]} tokens: {type:'text',text} | {type:<kind>, children?, …}
 */
export function inlineTokens(doc, from, to, model) {
	const inside = model.filter((c) => c.level === 'inline' && c.tier !== 'C' && c.from >= from && c.to <= to);
	// References and labels (§5.13) resolve against the note's numbering.
	let numbering = null;
	const numbers = () => (numbering ??= numberDocument(doc));
	return walk(from, to);

	/** Text, with each literal `<br>` a break (the engine renders it so; a
	 *  table cell writes its line breaks this way — table-cell-model.js). */
	function pushText(out, text) {
		const parts = text.split(/<br\s*\/?>/i);
		parts.forEach((part, i) => {
			if (i > 0) out.push({ type: 'break' });
			if (part) out.push({ type: 'text', text: part });
		});
	}

	function walk(a, b) {
		const out = [];
		let at = a;
		// Top-level constructs in [a, b): sorted outer-first, skip contained.
		let last = -1;
		for (const c of inside) {
			if (c.from < at || c.to > b || c.from < last) continue;
			if (c.from > at) pushText(out, doc.sliceString(at, c.from));
			out.push(token(c));
			at = c.to;
			last = c.to;
		}
		if (at < b) pushText(out, doc.sliceString(at, b));
		return out;
	}

	function token(c) {
		const source = doc.sliceString(c.from, c.to);
		if (TAGS[c.kind]) {
			const inner = c.hidden.length >= 2
				? { from: c.hidden[0].to, to: c.hidden[c.hidden.length - 1].from }
				: { from: c.hidden[0]?.to ?? c.from, to: c.to };
			return c.kind === 'code'
				? { type: 'code', text: doc.sliceString(inner.from, inner.to) }
				: { type: c.kind, children: walk(inner.from, inner.to) };
		}
		switch (c.kind) {
			case 'math':
				return { type: 'math', tex: doc.sliceString(c.body.from, c.body.to), display: c.display, source };
			case 'link':
				return { type: 'link', href: c.url, children: walk(c.label.from, c.label.to) };
			case 'autolink':
				return { type: 'link', href: c.url, children: [{ type: 'text', text: c.url }] };
			case 'wikilink': {
				const target = c.target + (c.heading ? `#${c.heading}` : '') + (c.blockId ? `#^${c.blockId}` : '');
				const shown = doc.sliceString(c.hidden[0].to, c.hidden[c.hidden.length - 1].from);
				return { type: 'wikilink', target, children: [{ type: 'text', text: shown }] };
			}
			case 'tag':
				return { type: 'tag', name: c.name, text: source };
			case 'escape':
				return { type: 'text', text: source.slice(1) };
			case 'directiveInline':
			case 'directiveAt': {
				const key = c.content ? doc.sliceString(c.content.from, c.content.to).trim() : '';
				if (key && ['ref', 'cref', 'Cref'].includes(c.name)) {
					const shown = refDisplay(numbers(), key, c.name);
					return { type: 'ref', key, text: shown.text, state: shown.state, title: shown.tip };
				}
				if (key && c.name === 'label') return { type: 'label', key, text: `⚓ ${key}` };
				return { type: 'text', text: source };
			}
			default:
				return { type: 'text', text: source };
		}
	}
}

/**
 * Build DOM for a token tree. Math goes through `renderMath(tex, display,
 * source)`, which the caller supplies (live edit's MathJax), so this stays
 * free of MathJax.
 *
 * @param {object[]} tokens
 * @param {(tex: string, display: boolean, source: string) => Node} renderMath
 * @returns {DocumentFragment}
 */
export function tokensToDom(tokens, renderMath) {
	const frag = document.createDocumentFragment();
	for (const t of tokens) frag.append(nodeFor(t, renderMath));
	return frag;
}

function nodeFor(t, renderMath) {
	if (t.type === 'text') return document.createTextNode(t.text);
	if (t.type === 'break') return document.createElement('br');
	if (t.type === 'code') {
		const el = document.createElement('code');
		el.className = 'le-code';
		el.textContent = t.text;
		return el;
	}
	if (t.type === 'math') return renderMath(t.tex, t.display, t.source);
	if (t.type === 'ref' || t.type === 'label') {
		const el = document.createElement('span');
		el.className = t.type === 'ref' ? `le-chip le-ref le-ref-${t.state}` : 'le-chip le-label';
		if (t.type === 'ref') el.dataset.leRef = t.key;
		if (t.title) el.title = t.title;
		el.textContent = t.text;
		return el;
	}
	if (t.type === 'tag') {
		const el = document.createElement('span');
		el.className = 'jmd-tag le-tag';
		el.dataset.leTag = t.name;
		el.textContent = t.text;
		return el;
	}
	let el;
	if (t.type === 'link') {
		el = document.createElement('a');
		el.className = 'le-link';
		el.dataset.leHref = t.href;
		el.title = t.href;
	} else if (t.type === 'wikilink') {
		el = document.createElement('a');
		el.className = 'le-wikilink';
		el.dataset.leTarget = t.target;
		el.title = t.target;
	} else {
		el = document.createElement(TAGS[t.type] ?? 'span');
		el.className = `le-${t.type}`;
	}
	el.append(tokensToDom(t.children ?? [], renderMath));
	return el;
}
