// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Which link is at a column of a line, and what hovering it should preview
// (docs/dev/live-edit.md §5.11). Pure: the source-mode ⌘-click handler
// (wikilink-click.js), the hover plugin (link-hover.js) and reading mode's
// host all read links through here, so they cannot disagree about one.
import { IMAGE_EXT } from '../../shared/file-types.js';

const WIKILINK = /(!?)\[\[([^[\]|#\n]*)(?:#([^[\]|\n]+))?(?:\|([^[\]\n]+))?\]\]/g;
/** `[text](url)` and `![alt](url)`: the url with no spaces (or in `<…>`),
 *  an optional quoted title. */
const MDLINK = /(!?)\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^\s()]+(?:\([^\s()]*\))?[^\s()]*))(?:\s+"[^"\n]*")?\s*\)/g;

/** `@ref[key]` and its kin, `@` or `:` (§5.13). */
const XREF = /(^|[^\w@:\\])([@:])(ref|cref|Cref)\[([^\]\n]+)\]/g;

/** `\cite{a, b}` and its family (§5.14). */
const CITE = /\\([a-zA-Z]*cite[a-zA-Z]*)\*?(?:\[[^\]\n]*\]){0,2}\{([^}\n]*)\}/g;

/** The column ranges of the line's code spans (backtick runs of equal
 *  length) — a link inside one is text. */
function codeSpans(text) {
	const out = [];
	const re = /`+/g;
	let m;
	while ((m = re.exec(text))) {
		const run = m[0];
		const close = text.indexOf(run, m.index + run.length);
		// An equal run that is not part of a longer one closes the span.
		let at = close;
		while (at !== -1 && (text[at - 1] === '`' || text[at + run.length] === '`')) at = text.indexOf(run, at + 1);
		if (at === -1) continue;
		out.push([m.index, at + run.length]);
		re.lastIndex = at + run.length;
	}
	return out;
}

const hasExternal = (alias) => (alias ?? '').split('|').some((p) => p.trim().toLowerCase() === 'external');

/**
 * The link at `column` of `lineText` (inclusive of both ends, so a pointer
 * over the last character — which CodeMirror may report as the position
 * after it — still counts).
 *
 * @returns {null | {kind: 'wikilink', embed: boolean, target: string, heading: string,
 *   alias: string, external: boolean, from: number, to: number}
 *   | {kind: 'markdown', embed: boolean, url: string, text: string, from: number, to: number}
 *   | {kind: 'xref', form: 'ref'|'cref'|'Cref', key: string, from: number, to: number}
 *   | {kind: 'cite', command: string, keys: string[], from: number, to: number}}
 */
export function linkAt(lineText, column) {
	const inCode = codeSpans(lineText).some(([a, b]) => column >= a && column < b);
	if (inCode) return null;
	WIKILINK.lastIndex = 0;
	let m;
	while ((m = WIKILINK.exec(lineText))) {
		const from = m.index;
		const to = from + m[0].length;
		if (column < from || column > to) continue;
		return {
			kind: 'wikilink', embed: m[1] === '!', target: m[2].trim(), heading: (m[3] ?? '').trim(),
			alias: m[4] ?? '', external: hasExternal(m[4]), from, to,
		};
	}
	CITE.lastIndex = 0;
	while ((m = CITE.exec(lineText))) {
		const from = m.index;
		const to = from + m[0].length;
		if (column < from || column > to) continue;
		const keys = m[2].split(',').map((k) => k.trim()).filter(Boolean);
		if (keys.length) return { kind: 'cite', command: m[1], keys, from, to };
	}
	XREF.lastIndex = 0;
	while ((m = XREF.exec(lineText))) {
		const from = m.index + m[1].length;
		const to = m.index + m[0].length;
		if (column < from || column > to) continue;
		return { kind: 'xref', form: m[3], key: m[4].trim(), from, to };
	}
	MDLINK.lastIndex = 0;
	while ((m = MDLINK.exec(lineText))) {
		const from = m.index;
		const to = from + m[0].length;
		if (column < from || column > to) continue;
		return { kind: 'markdown', embed: m[1] === '!', url: (m[3] ?? m[4]).trim(), text: m[2], from, to };
	}
	return null;
}

/**
 * A reading-mode link's target (`data-href`: `Note`, `Note#Heading`,
 * `Note#^id`, `#Heading`) as the wikilink linkAt would have returned.
 */
export function parseTarget(target) {
	const hash = target.indexOf('#');
	return {
		kind: 'wikilink', embed: false,
		target: (hash === -1 ? target : target.slice(0, hash)).trim(),
		heading: hash === -1 ? '' : target.slice(hash + 1).trim(),
		alias: '', external: false, from: 0, to: 0,
	};
}

const extOf = (name) => { const m = /\.[A-Za-z0-9]+$/.exec(name); return m ? m[0].toLowerCase() : ''; };
const isNoteName = (name) => ['', '.md', '.jmd'].includes(extOf(name));
const safeDecode = (s) => { try { return decodeURI(s); } catch { return s; } };

/**
 * What hovering a link previews.
 *
 * @param {ReturnType<typeof linkAt>} link
 * @param {{ note: (name: string) => string|null, file: (name: string) => string|null,
 *   current: string|null, label?: (key: string) => ({text: string, label: string}|null),
 *   cite?: (key: string) => ({label: string, title: string}|null), fullcite?: boolean }} resolve
 *   - the vault's resolvers, the note being edited (a same-note `#Heading`
 *   previews that note's section), and — for a reference — what its label's
 *   host renders as (live/numbering.js#labelPreview)
 * @returns {null
 *   | { kind: 'block', path: string, text: string, label: string }
 *   | { kind: 'image', path: string, label: string }
 *   | { kind: 'unresolved', name: string, label: string }}
 *   `block`: render `text` through the block endpoint; null: no popover
 *   (a URL, mailto, an `|external` alias).
 */
export function previewSpec(link, resolve) {
	if (!link) return null;
	if (link.kind === 'cite') {
		// A citation (§5.14): the engine formats `\fullcite{key}` in the
		// vault's style when the vault names a bibliography; without one, the
		// .bib's own fields on a card. An unknown key is refused by name.
		const found = link.keys.map((key) => ({ key, entry: resolve.cite?.(key) ?? null }));
		const known = found.filter((f) => f.entry);
		if (!known.length) {
			return { kind: 'unresolved', name: link.keys[0], label: link.keys.join('; '), message: `No entry “${link.keys[0]}” in the vault’s .bib files`, hint: 'Citation completion lists the keys there are' };
		}
		const label = known.map((f) => f.entry.label).join('; ');
		if (resolve.fullcite) {
			return { kind: 'block', path: resolve.current, text: known.map((f) => `\\fullcite{${f.key}}`).join('\n\n'), label };
		}
		return { kind: 'unresolved', name: link.keys[0], label, message: known.map((f) => `${f.entry.label} — ${f.entry.title}`).join('\n'), hint: 'Name a bibliography in this vault’s settings to see it formatted' };
	}
	if (link.kind === 'xref') {
		const host = resolve.label?.(link.key) ?? null;
		if (!host) return { kind: 'unresolved', name: link.key, label: link.key, message: `No label “${link.key}” in this note` };
		return { kind: 'block', path: resolve.current, text: host.text, label: host.label };
	}
	let target;
	let heading;
	if (link.kind === 'markdown') {
		const url = link.url;
		if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
		const hash = url.indexOf('#');
		target = safeDecode(hash === -1 ? url : url.slice(0, hash));
		heading = hash === -1 ? '' : safeDecode(url.slice(hash + 1));
		if (isNoteName(target)) target = target.replace(/\.(md|jmd)$/i, '');
	} else {
		if (link.external) return null;
		({ target, heading } = link);
	}
	const section = heading ? `#${heading}` : '';
	const note = target ? resolve.note(target) : resolve.current;
	if (note) {
		const name = note.replace(/\.(md|jmd)$/i, '');
		const base = name.split('/').pop();
		return { kind: 'block', path: note, text: `![[${name}${section}|bare]]`, label: base + (heading ? ` › ${heading}` : '') };
	}
	if (!target) return null;
	if (!isNoteName(target)) {
		const file = resolve.file(target);
		const label = (file ?? target).split('/').pop();
		if (!file) return { kind: 'unresolved', name: target, label };
		if (IMAGE_EXT.includes(extOf(file))) return { kind: 'image', path: file, label };
		return { kind: 'block', path: file, text: `![[${file}]]`, label };
	}
	return { kind: 'unresolved', name: target, label: target.split('/').pop() };
}
