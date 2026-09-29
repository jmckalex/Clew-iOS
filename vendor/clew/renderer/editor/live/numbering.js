// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The numbers the engine will print, computed while you write
// (docs/dev/live-edit.md §5.13). A MIRROR of the engine's HTML
// post-processor (vendor/jmarkdown/src/post-processor.js), which numbers in
// document order after rendering:
//
//   - headings h1–h6, hierarchically ("1.", "1.2.") — only under the metadata
//     header's `Headings: numeric` (add_labels_to_headers), every heading
//     counted, h1 included;
//   - figures (subfigures "1a", "1b"), tables, listings: a counter each;
//   - theorem, lemma, corollary, proposition, definition, example, remark:
//     ONE shared counter (number_theorems; proof is unnumbered);
//   - `@begin(equation)` only — `$$…$$` and `\[…\]` are unnumbered;
//   - environments a plugin declares numbered: a counter per group;
//   - a label: `{#key}` / `{id=key}` on a numbered opener takes its number;
//     `@label[key]` takes the innermost numbered construct's, else its
//     heading's (numeric headings only), else NONE — and a reference to it
//     prints `??`. A label in a FOOTNOTE gets none either: the
//     post-processor's footnote branch looks for `[id^="footnote-"]`, but the
//     engine's endnotes carry `id="fn-…"`, so the branch never runs and such
//     a reference prints `??` (measured 2026-09-27; an engine bug, reported
//     upstream, mirrored here until it is fixed there).
//
// Pure over the note's TEXT, so live edit, source-mode completion and the
// hover preview share one pass; keyed by LINE (an environment's opener, a
// heading, an equation's opener), which is what every consumer has in hand.
// Parity with the engine is ASSERTED by smoke/crossref-scenario.js, never
// assumed. Numbering is per note in v1: the export of a jmarkdownProject
// vault numbers the whole project.
//
// The engine is reached BY NAME — `#jmarkdown/…`, package.json's "imports"
// map onto vendor/jmarkdown/src — not by a relative path, which counted on
// the app living at <repo>/src; the iOS port mirrors it one level deeper and
// maps the same name onto its own vendor/jmarkdown.
import { typedRefText as engineTypedRefText } from '#jmarkdown/crossref.js';
import { attrLabel, THEOREM_KINDS } from '../../../shared/note-metadata.js';

/** The engine's sectioning ladder (sectioning.js — asserted equal by
 *  tests/numbering.test.js, which reads the vendored file). */
export const SECTIONING = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'];
export const CHAPTER_CLASSES = ['book', 'report', 'memoir', 'scrbook', 'scrreprt', 'extbook', 'extreport'];

const THEOREMS = new Set(THEOREM_KINDS);
const FLOATS = new Set(['figure', 'table', 'listing']);
const VERBATIM = new Set(['equation', 'TeX', 'HTML', 'comment', 'mermaid', 'TiKZ', 'tikz', 'tikzpicture', 'metapost']);
const ENV_OPEN_RE = /^[ \t]*(?:@begin\(([\w*-]+)\)|(:{3,})[ \t]*([\w*-]+))(?:\[([^\]\n]*)\])?(?:\{([^}\n]*)\})?/;
const ENV_CLOSE_RE = /^[ \t]*(?:@end\(([\w*-]+)\)|(:{3,})[ \t]*$)/;
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const LABEL_RE = /(^|[^\w@:\\])[@:]label\[([^\]\n]+)\]/g;
const FOOTNOTE_RE = /\[(?:fn:|\^[^\]\s:]+:)/g;

/** Anything this pass could number: when none of it is there, skip it — a
 *  note full of diagrams (@begin(TiKZ)) costs a keystroke nothing. Plugin-
 *  declared environments bypass the check. */
const NUMBERED_NAMES = 'theorem|lemma|corollary|proposition|definition|example|remark|equation|figure|subfigure|table|listing';
const WORTH = new RegExp(`[@:](?:label|c?ref|Cref)\\[|Headings:|@begin\\((?:${NUMBERED_NAMES})\\)|:::+[ \\t]*(?:${NUMBERED_NAMES})\\b`);

/** "section 3", "Theorem 2", "equation (1)" — the engine's own words, with its
 *  `&#160;` as a real no-break space for the DOM. */
export function typedRefText(type, number, capitalized = false) {
	return engineTypedRefText(type, number, capitalized).replace(/&#160;/g, ' ');
}

/** The type word for a heading of `depth` (sectioning.js#commandForDepth). */
export function commandForDepth(depth, meta = {}) {
	const explicit = String(meta.headingBase ?? '').trim().toLowerCase();
	const cls = String(meta.documentClass ?? '').trim().toLowerCase() || 'article';
	const base = explicit && SECTIONING.includes(explicit)
		? SECTIONING.indexOf(explicit)
		: SECTIONING.indexOf(CHAPTER_CLASSES.includes(cls) ? 'chapter' : 'section');
	return SECTIONING[Math.min(base + (depth - 1), SECTIONING.length - 1)];
}

/** The frontmatter keys numbering reads (the engine's metadata header). */
function headerMeta(lines) {
	const meta = { headingsNumeric: false, headingBase: '', documentClass: '', end: 0 };
	if (!/^---[ \t]*$/.test(lines[0] ?? '')) return meta;
	for (let i = 1; i < lines.length; i += 1) {
		if (/^---[ \t]*$/.test(lines[i])) { meta.end = i + 1; break; }
		const m = /^([A-Za-z][\w -]*?)[ \t]*:[ \t]*(.*)$/.exec(lines[i]);
		if (!m) continue;
		const key = m[1].trim().toLowerCase();
		const value = m[2].trim().replace(/^["']|["']$/g, '');
		if (key === 'headings') meta.headingsNumeric = value.split(/[,\s]+/)[0] === 'numeric';
		if (key === 'heading base') meta.headingBase = value;
		if (key === 'document class') meta.documentClass = value;
	}
	return meta;
}

/** Code fences, inline code and `$…$` blanked, offsets kept. */
function masked(text) {
	const blank = (m) => m.replace(/[^\n]/g, ' ');
	return text
		.replace(/^(```|~~~).*$[\s\S]*?^\1[ \t]*$/gm, blank)
		.replace(/\$\$[\s\S]*?\$\$/g, blank)
		.replace(/`[^`\n]*`/g, blank)
		.replace(/\$[^$\n]+\$/g, blank);
}

const EMPTY = Object.freeze({ lines: new Map(), labels: new Map(), headingsNumeric: false });
const cache = new WeakMap();

/**
 * @param {string|import('@codemirror/state').Text} doc
 * @param {{ numbered?: Map<string, {counter: string, type: string, title: string}> }} [options]
 *   environments plugins declare numbered (§5.13 §6)
 * @returns {{
 *   headingsNumeric: boolean,
 *   lines: Map<number, {number: string, type: string, kind: string, title: string}>,
 *   labels: Map<string, {number: string, type: string|undefined, line: number,
 *     host: {from: number, to: number}, title: string, kind: string,
 *     status: 'ok'|'numberless'|'uncounted', count: number}>,
 * }}
 *   `lines`: 1-based line → what the engine prints there (an opener, a
 *   heading). `labels`: key → its target; `count` > 1 when defined twice (the
 *   LAST wins, as in the engine); `uncounted`: an environment Clew cannot
 *   number (a plugin's, undeclared) — refused by name, never guessed.
 */
export function numberDocument(doc, { numbered = new Map() } = {}) {
	const isText = typeof doc !== 'string';
	if (isText && numbered.size === 0 && cache.has(doc)) return cache.get(doc);
	const text = isText ? doc.toString() : doc;
	const result = numbered.size || WORTH.test(text) ? compute(text, numbered) : EMPTY;
	if (isText && numbered.size === 0) cache.set(doc, result);
	return result;
}

function compute(text, numbered) {
	const raw = text.split('\n');
	const lines = masked(text).split('\n');
	const meta = headerMeta(raw);
	const out = { headingsNumeric: meta.headingsNumeric, lines: new Map(), labels: new Map() };
	const h = [0, 0, 0, 0, 0, 0];
	const counters = { figure: 0, table: 0, listing: 0, theorem: 0, equation: 0 };
	const custom = {};
	let footnotes = 0;
	/** Open environments: {name, colons, line, number, type, numbered, title, sub}. */
	const envs = [];

	const record = (key, info) => {
		const prev = out.labels.get(key);
		out.labels.set(key, { ...info, count: (prev?.count ?? 0) + 1 });
	};

	for (let i = meta.end; i < raw.length; i += 1) {
		const lineNo = i + 1;
		const rawLine = raw[i];
		const line = lines[i];
		const top = envs[envs.length - 1];
		const verbatim = top && VERBATIM.has(top.name);
		// A fenced line is masked blank: it can open nothing.
		const close = line.trim() ? ENV_CLOSE_RE.exec(rawLine) : null;
		if (close && envs.length) {
			let at = envs.length - 1;
			if (close[1]) while (at >= 0 && envs[at].name !== close[1]) at -= 1;
			else while (at >= 0 && !envs[at].colons) at -= 1;
			if (at >= 0) {
				for (const env of envs.splice(at)) {
					for (const key of env.pending) {
						const info = out.labels.get(key);
						if (info) info.host.to = lineNo;
					}
				}
				continue;
			}
		}
		const open = !verbatim && line.trim() ? ENV_OPEN_RE.exec(rawLine) : null;
		if (open) {
			const name = open[1] ?? open[3];
			const env = { name, colons: Boolean(open[2]), line: lineNo, title: (open[4] ?? '').trim(), numbered: false, pending: [] };
			if (name === 'subfigure') {
				const parent = [...envs].reverse().find((e) => e.name === 'figure');
				if (parent) {
					parent.sub = (parent.sub ?? 0) + 1;
					Object.assign(env, { numbered: true, type: 'figure', number: `${parent.number}${String.fromCharCode(96 + parent.sub)}` });
				}
			} else if (FLOATS.has(name) || name === 'equation') {
				counters[name] += 1;
				Object.assign(env, { numbered: true, type: name, number: `${counters[name]}` });
			} else if (THEOREMS.has(name)) {
				counters.theorem += 1;
				Object.assign(env, { numbered: true, type: name, number: `${counters.theorem}` });
			} else if (numbered.has(name)) {
				const spec = numbered.get(name);
				custom[spec.counter] = (custom[spec.counter] ?? 0) + 1;
				Object.assign(env, { numbered: true, type: spec.type, number: `${custom[spec.counter]}`, customTitle: spec.title });
			} else {
				env.uncounted = !['proof', 'TeX', 'HTML', 'comment', 'center', 'abstract'].includes(name);
			}
			if (env.numbered) out.lines.set(lineNo, { number: env.number, type: env.type, kind: name, title: env.title, customTitle: env.customTitle });
			envs.push(env);
			const key = attrLabel(open[5]);
			if (key) {
				const host = { from: lineNo, to: lineNo };
				if (env.numbered) record(key, { number: env.number, type: env.type, line: lineNo, host, title: env.title, kind: name, status: 'ok' });
				else record(key, { number: '', type: undefined, line: lineNo, host, title: env.title, kind: name, status: env.uncounted ? 'uncounted' : 'numberless' });
				env.pending.push(key);
			}
			continue;
		}
		if (verbatim) continue;

		// Headings (outside any verbatim body).
		const heading = HEADING_RE.exec(line) ? HEADING_RE.exec(rawLine) : null;
		let headingNumber = '';
		let headingType;
		if (heading) {
			const depth = heading[1].length;
			if (meta.headingsNumeric) {
				h[depth - 1] += 1;
				for (let d = depth; d < 6; d += 1) h[d] = 0;
				headingNumber = h.slice(0, depth).join('.');
				out.lines.set(lineNo, { number: headingNumber, type: commandForDepth(depth, meta), kind: 'heading', title: heading[2] });
			}
			headingType = commandForDepth(depth, meta);
		}

		// Footnotes in document order, for a label inside one.
		const notes = [];
		FOOTNOTE_RE.lastIndex = 0;
		for (let m; (m = FOOTNOTE_RE.exec(line));) notes.push({ at: m.index, number: ++footnotes });

		LABEL_RE.lastIndex = 0;
		for (let m; (m = LABEL_RE.exec(line));) {
			const col = m.index + m[1].length;
			const key = m[2].trim();
			const note = notes.filter((n) => n.at < col && !line.slice(n.at, col).includes(']')).pop();
			const hostEnv = [...envs].reverse().find((e) => e.numbered);
			let info;
			// The engine's own behaviour, not its intent: no number (see above).
			if (note) info = { number: '', type: 'footnote', kind: 'footnote', title: '', status: 'numberless' };
			else if (hostEnv) info = { number: hostEnv.number, type: hostEnv.type, kind: hostEnv.name, title: hostEnv.title, status: 'ok' };
			else if (heading) info = { number: headingNumber, type: headingType, kind: 'heading', title: heading[2].replace(/[@:]label\[[^\]]*\]/g, '').trim(), status: headingNumber ? 'ok' : 'numberless' };
			else info = { number: '', type: undefined, kind: 'plain', title: '', status: 'numberless' };
			const host = hostEnv && !note ? { from: hostEnv.line, to: hostEnv.line } : { from: lineNo, to: lineNo };
			record(key, { ...info, line: lineNo, host });
			if (hostEnv && !note) hostEnv.pending.push(key);
		}
	}
	return out;
}

/**
 * What a reference chip shows for `key`.
 *
 * @param {ReturnType<typeof numberDocument>} numbering
 * @param {'ref'|'cref'|'Cref'} form
 * @returns {{ text: string, state: 'ok'|'numberless'|'missing'|'uncounted', tip: string,
 *   target: object|null }}
 */
export function refDisplay(numbering, key, form) {
	const target = numbering.labels.get(key) ?? null;
	// The engine prints `??` for an unknown key too; the key is in the tip.
	if (!target) return { text: '??', state: 'missing', tip: `No label “${key}” in this note (a reference to another note's label is not resolved in v1)`, target };
	if (target.status === 'uncounted') {
		return { text: '?', state: 'uncounted', tip: `Clew cannot number “${target.kind}”; the export will`, target };
	}
	if (target.status !== 'ok' || !target.number) {
		const tip = target.kind === 'heading'
			? `“${key}” labels a heading, and headings are numbered only under “Headings: numeric”`
			: target.kind === 'footnote'
				? `“${key}” is inside a footnote, and the engine does not number footnote labels (it prints ??)`
				: `“${key}” labels something with no number — the engine prints ??`;
		return { text: '??', state: 'numberless', tip, target };
	}
	const text = form === 'ref' ? target.number : typedRefText(target.type, target.number, form === 'Cref');
	const twice = target.count > 1 ? ' (defined twice — the last one wins)' : '';
	return { text, state: 'ok', tip: `${form}[${key}] → ${typedRefText(target.type, target.number, true)}${target.title ? ` — ${target.title}` : ''}${twice}. Numbered within this note.`, target };
}

/** The heading an environment's head widget shows: "Theorem 2", "Figure 1". */
export function headText(entry) {
	const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
	if (entry.customTitle) return `${entry.customTitle} ${entry.number}`;
	if (entry.kind === 'subfigure') return `(${entry.number.replace(/^\d+/, '')})`;
	return `${cap(entry.kind === 'equation' ? 'equation' : entry.type)} ${entry.number}`;
}

/** Hides the numbers a lone fragment would print — the engine numbers a
 *  previewed theorem "1" in isolation; the popover's header carries the
 *  real one. */
const HIDE_FRAGMENT_NUMBERS = '<style>.theorem-label, .env-label, .eqn-number, .figure-label, .table-label, .listing-label, .header-label { display: none; }</style>';

/**
 * What hovering a reference previews: the source of the construct its label
 * belongs to, rendered through the block endpoint, and a header naming it
 * with the number this note gives it. A heading host previews its section.
 *
 * @param {import('@codemirror/state').Text} doc
 * @param {string} key
 * @param {string|null} notePath
 * @returns {{ text: string, label: string } | null}
 */
export function labelPreview(doc, key, notePath) {
	const target = numberDocument(doc).labels.get(key);
	if (!target) return null;
	const shown = refDisplay(numberDocument(doc), key, 'Cref');
	const label = (shown.state === 'ok' ? shown.text : key) + (target.title ? ` — ${target.title}` : '');
	if (target.kind === 'heading' && notePath) {
		const heading = doc.line(target.line).text.replace(/^#{1,6}[ \t]+/, '').replace(/[@:]label\[[^\]]*\]/g, '').trim();
		return { text: `![[${notePath.replace(/\.(md|jmd)$/i, '')}#${heading}|bare]]`, label };
	}
	const from = doc.line(Math.min(target.host.from, doc.lines)).from;
	const to = doc.line(Math.min(target.host.to, doc.lines)).to;
	return { text: `${HIDE_FRAGMENT_NUMBERS}\n\n${doc.sliceString(from, to)}`, label };
}
