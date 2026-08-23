/*
	Inline footnotes / endnotes extension for JMarkdown.

	Syntax forms:

	  [fn: body]                 — anonymous (auto-numbered label), default group
	  [^label: body]             — explicitly labelled, default group
	  [fn(group): body]          — anonymous, assigned to endnote group `group`
	  [^label(group): body]      — labelled, assigned to endnote group `group`

	The body can span multiple lines and paragraphs (continuation indicated
	by indentation), and may contain block-level content such as lists and
	definition lists.  Brackets inside math ($...$, $$...$$), code spans,
	and escaped characters are not counted.

	Endnote GROUPING and PLACEMENT (all additive; ungrouped notes behave as before):

	  @endnoteGroup(name)        — on its own line: every following note joins
	                               group `name` until the next @endnoteGroup.
	                               @endnoteGroup() resets to the default group.
	                               A per-note (group) always overrides the ambient one.
	  @endnotes(name)            — render group `name`'s endnote list here.
	  @endnotes                  — render every group not claimed by a specific
	                               @endnotes(name) here.
	  @endnotes(name){title="…"} — with an optional heading (no heading otherwise).

	Numbering is PER GROUP, restarting at 1 for each group.

	Output:
	  HTML  — superscript reference + one or more collected endnote lists,
	          placed at @endnotes markers (or, with no markers, an "Endnotes"
	          section appended at the end — the historical behaviour).
	  LaTeX — if the document uses NO grouping/placement at all, each note is a
	          plain inline \footnote{…} (historical behaviour).  As soon as any
	          grouping or @endnotes placement is used, notes become endnotes:
	          a \textsuperscript{n} mark inline + built endnote lists at the
	          placement markers.

	Exports:
	  - preprocessFootnotes(src)    — call before marked.parse() (resolves ambient
	                                  groups, extracts multi-paragraph bodies)
	  - inlineFootnote              — the marked inline extension object
	  - endnotesPlacement           — the marked block extension for @endnotes
	  - fillEndnotes(content, fmt)  — replace @endnotes placeholders + append any
	                                  unplaced notes; call after marked.parse()
	  - resetFootnotes()            — reset state before processing a new file
	  - getFootnotesHTML()          — DEPRECATED shim (kept for callers): returns ''
*/

import attributesParser from 'attributes-parser';
import { addWarning } from './warnings.js';

// ========================================================================
//  Context-aware bracket scanner
// ========================================================================

/**
 * Find the closing ] that matches an opening [ at position (start - 1).
 * Brackets inside math, code spans, and escaped characters are ignored.
 *
 * @param {string} src   — the full source text
 * @param {number} start — index immediately after the opening [
 * @returns {number} index one past the closing ], or -1 if unmatched
 */
function findClosingBracket(src, start) {
	let depth = 1;
	let i = start;

	while (i < src.length && depth > 0) {
		const ch = src[i];

		// Escaped character — skip the next character unconditionally
		if (ch === '\\' && i + 1 < src.length) {
			i += 2;
			continue;
		}

		// Display math $$...$$
		if (ch === '$' && i + 1 < src.length && src[i + 1] === '$') {
			i += 2;
			while (i < src.length - 1) {
				if (src[i] === '\\') { i += 2; continue; }
				if (src[i] === '$' && src[i + 1] === '$') { i += 2; break; }
				i++;
			}
			continue;
		}

		// Inline math $...$
		if (ch === '$') {
			i++;
			while (i < src.length) {
				if (src[i] === '\\') { i += 2; continue; }
				if (src[i] === '$') { i++; break; }
				i++;
			}
			continue;
		}

		// Code span — count opening backticks, then find matching close
		if (ch === '`') {
			let count = 0;
			let pos = i;
			while (pos < src.length && src[pos] === '`') { count++; pos++; }
			const closer = '`'.repeat(count);
			const closeIdx = src.indexOf(closer, pos);
			i = closeIdx !== -1 ? closeIdx + count : pos;
			continue;
		}

		// Normal bracket counting
		if (ch === '[') depth++;
		else if (ch === ']') depth--;

		i++;
	}

	return depth === 0 ? i : -1;
}

// ========================================================================
//  State
// ========================================================================

// The default (unnamed) endnote group.  A named group can never be '' because
// @endnoteGroup()/[fn():…] trim to empty and fall back to this.
const DEFAULT_GROUP = '';
// Sentinel group for a bare `@endnotes` (all groups). A noncharacter so it can
// never collide with a real group name.
const ALL_GROUPS = '\uFDD2ALL';

let autoLabelCounter = 0;                // for anonymous [fn: ...] footnotes
const footnoteEntries = [];              // collected notes: { group, n, label, content }
const footnoteStore = new Map();         // label → { body, indent, group }
const groupCounters = new Map();         // group → running per-group number
const groupOrder = [];                   // groups in first-appearance (numbering) order
const placements = [];                   // @endnotes markers in document order: { id, group, title }
let placementIdCounter = 0;
// True once the document uses ANY grouping or placement — this is the switch that
// turns LaTeX from inline \footnote into built endnote lists.
let endnotesMode = false;

// Marker used to replace extracted multi-paragraph footnotes.
// Uses Unicode noncharacters that will never appear in real content.
const FN_MARKER_PREFIX = '\uFDD0FN:';
const FN_MARKER_SUFFIX = '\uFDD1';

function makeFnMarker(label) {
	return FN_MARKER_PREFIX + label + FN_MARKER_SUFFIX;
}

function escapeForRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const FN_MARKER_REGEX = new RegExp('^' + escapeForRegExp(FN_MARKER_PREFIX) + '([^' + escapeForRegExp(FN_MARKER_SUFFIX) + ']+)' + escapeForRegExp(FN_MARKER_SUFFIX));

/**
 * Reset all footnote/endnote state.  Call before processing each file.
 */
export function resetFootnotes() {
	autoLabelCounter = 0;
	footnoteEntries.length = 0;
	footnoteStore.clear();
	groupCounters.clear();
	groupOrder.length = 0;
	placements.length = 0;
	placementIdCounter = 0;
	endnotesMode = false;
}

// Resolve a raw group capture into a group key: trimmed, or DEFAULT_GROUP if empty.
function normaliseGroup(raw) {
	if (raw == null) return DEFAULT_GROUP;
	const t = String(raw).trim();
	return t === '' ? DEFAULT_GROUP : t;
}

// Assign the next per-group number and record the group's first-appearance order.
function nextNumber(group) {
	if (!groupCounters.has(group)) { groupCounters.set(group, 0); groupOrder.push(group); }
	const n = groupCounters.get(group) + 1;
	groupCounters.set(group, n);
	return n;
}

// ========================================================================
//  Preprocessing
// ========================================================================

// A note opener carries an optional (group) between the marker and the colon:
//   [fn: …]  ·  [fn(g): …]  ·  [^label: …]  ·  [^label(g): …]
const OPEN_ANON  = /^\[fn(?:\(([^)]*)\))?:\s*/;
const OPEN_LABEL = /^\[\^([^\]\s:(]+)(?:\(([^)]*)\))?:\s*/;

/**
 * Pass A — resolve ambient groups and mark endnotes-mode, line by line.
 *
 * `@endnoteGroup(name)` on its own line sets the ambient group for every
 * following note until the next such line; the directive line is blanked (its
 * newline kept, so inverse-search line numbers do not shift).  A note opener on
 * an ordinary line that has no explicit (group) gets the ambient group injected,
 * so Pass B and the inline extension only ever see explicit groups and stay
 * stateless.  Fenced code blocks are skipped so `@endnoteGroup` / `[fn:` inside
 * a code sample are left literal.  Rewriting happens ONLY under an active ambient
 * group, so a document that never uses @endnoteGroup is returned untouched.
 */
function resolveAmbientGroups(src) {
	const lines = src.split('\n');
	let ambient = DEFAULT_GROUP;
	let inFence = false;
	let fenceMarker = '';

	for (let li = 0; li < lines.length; li++) {
		const line = lines[li];

		// Fence tracking (``` or ~~~). The delimiter line itself is left as-is.
		const fence = /^(\s*)(`{3,}|~{3,})/.exec(line);
		if (fence) {
			if (!inFence) { inFence = true; fenceMarker = fence[2][0]; }
			else if (fence[2][0] === fenceMarker) { inFence = false; fenceMarker = ''; }
			continue;
		}
		if (inFence) continue;

		// @endnoteGroup(name) — a whole-line ambient-group directive.
		const grp = /^[ \t]*@endnoteGroup\(([^)]*)\)[ \t]*$/.exec(line);
		if (grp) {
			ambient = normaliseGroup(grp[1]);
			endnotesMode = true;
			lines[li] = '';            // blank, but the line (newline) survives
			continue;
		}

		// Rewrite note openers on this line: inject the ambient group where a note
		// has none; note explicit groups (they also switch on endnotes-mode).
		lines[li] = line.replace(/\[fn(\([^)]*\))?:/g, (m, g) => {
			if (g != null) { endnotesMode = true; return m; }             // explicit group
			if (ambient === DEFAULT_GROUP) return m;                      // nothing to inject
			endnotesMode = true;
			return `[fn(${ambient}):`;
		}).replace(/\[\^([^\]\s:(]+)(\([^)]*\))?:/g, (m, label, g) => {
			if (g != null) { endnotesMode = true; return m; }
			if (ambient === DEFAULT_GROUP) return m;
			endnotesMode = true;
			return `[^${label}(${ambient}):`;
		});
	}

	return lines.join('\n');
}

/**
 * Preprocess the source to resolve ambient endnote groups and to extract
 * multi-paragraph inline footnotes.
 *
 * Multi-paragraph footnotes (those whose body contains blank lines) are
 * extracted, dedented, and stored in footnoteStore (with their resolved group).
 * The original construct is replaced with a short marker so that the surrounding
 * paragraph remains intact for marked's block tokenizer.  Single-paragraph
 * footnotes are left in place — the inline extension handles them directly.
 */
export function preprocessFootnotes(src) {
	// Pass A: ambient groups → explicit groups; blank @endnoteGroup lines.
	src = resolveAmbientGroups(src);

	// Pass B: extract multi-paragraph bodies (unchanged in spirit; now group-aware).
	const result = [];
	let i = 0;

	while (i < src.length) {
		// Find the earliest of the two trigger sequences
		const idxCaret = src.indexOf('[^', i);
		const idxFn    = src.indexOf('[fn', i);

		// Pick the earlier match; if neither, flush and break
		let idx;
		if (idxCaret === -1 && idxFn === -1) {
			result.push(src.slice(i));
			break;
		} else if (idxCaret === -1) {
			idx = idxFn;
		} else if (idxFn === -1) {
			idx = idxCaret;
		} else {
			idx = Math.min(idxCaret, idxFn);
		}

		const afterBracket = src.slice(idx);

		// Try both patterns: [fn(g)?: ...] (anonymous) and [^label(g)?: ...] (labelled)
		const anonMatch  = OPEN_ANON.exec(afterBracket);
		const labelMatch = OPEN_LABEL.exec(afterBracket);

		const match = anonMatch || labelMatch;
		if (!match) {
			// Not a footnote — skip past the trigger characters
			const skip = (idx === idxFn) ? 3 : 2;   // '[fn' or '[^'
			result.push(src.slice(i, idx + skip));
			i = idx + skip;
			continue;
		}

		const label = labelMatch ? labelMatch[1] : '_auto' + (++autoLabelCounter);
		const group = normaliseGroup(labelMatch ? labelMatch[2] : (anonMatch ? anonMatch[1] : null));
		if (group !== DEFAULT_GROUP) endnotesMode = true;

		// Use context-aware scanner to find the closing ]
		const closingPos = findClosingBracket(src, idx + 1);
		if (closingPos === -1) {
			// Unmatched bracket — skip past trigger
			const skip = match[0].length;
			result.push(src.slice(i, idx + skip));
			i = idx + skip;
			continue;
		}

		// Check for blank lines within the footnote
		const footnoteSlice = src.slice(idx, closingPos);
		const hasBlankLines = /\n[ \t]*\n/.test(footnoteSlice);

		if (!hasBlankLines) {
			// Single-paragraph footnote — leave for the inline extension
			result.push(src.slice(i, closingPos));
			i = closingPos;
			continue;
		}

		// ---- Multi-paragraph footnote: extract, dedent, store ----

		// Body is everything between the opening pattern and the final "]"
		const bodyRaw = src.slice(idx + match[0].length, closingPos - 1);

		// Detect indent from the first continuation line in the raw source
		let indent = '';
		const firstNewline = footnoteSlice.indexOf('\n');
		if (firstNewline !== -1) {
			const indentMatch = /^([ \t]+)/.exec(footnoteSlice.slice(firstNewline + 1));
			if (indentMatch) indent = indentMatch[1];
		}

		// Dedent: strip one level of indent from each line so that
		// the body is valid top-level markdown.  Lines indented deeper
		// than the base level keep their extra indentation (important
		// for nested constructs like definition list continuations).
		const indentLen = indent.length;
		const dedented = bodyRaw.split('\n').map(line => {
			// Only strip if the line begins with the detected indent
			// (or is a blank/whitespace-only line)
			if (line.length >= indentLen && line.slice(0, indentLen).trim() === '') {
				return line.slice(indentLen);
			}
			return line.trimStart();
		}).join('\n').trim();

		footnoteStore.set(label, { body: dedented, indent, group });

		// Replace the whole [...] with a marker
		result.push(src.slice(i, idx) + makeFnMarker(label));
		i = closingPos;
	}

	return result.join('');
}

// ========================================================================
//  Inline extension
// ========================================================================

export const inlineFootnote = {
	name: 'inlineFootnote',
	level: 'inline',

	start(src) {
		// Check for preprocessed marker
		const markerIdx = src.indexOf(FN_MARKER_PREFIX);

		// Check for anonymous inline footnote [fn: or [fn(group):
		let fnIdx = -1;
		const fnBracketIdx = src.indexOf('[fn');
		if (fnBracketIdx !== -1 && OPEN_ANON.test(src.slice(fnBracketIdx))) {
			fnIdx = fnBracketIdx;
		}

		// Check for labelled inline footnote [^label: or [^label(group):
		let labelIdx = -1;
		const caretIdx = src.indexOf('[^');
		if (caretIdx !== -1 && OPEN_LABEL.test(src.slice(caretIdx))) {
			labelIdx = caretIdx;
		}

		// Return the earliest match, or undefined if none found
		const candidates = [markerIdx, fnIdx, labelIdx].filter(x => x !== -1);
		return candidates.length > 0 ? Math.min(...candidates) : undefined;
	},

	tokenizer(src) {
		// ---- Case 1: preprocessed marker for a multi-paragraph footnote ----
		const markerMatch = FN_MARKER_REGEX.exec(src);
		if (markerMatch) {
			const label = markerMatch[1];
			const stored = footnoteStore.get(label);
			if (!stored) return;

			const token = {
				type: 'inlineFootnote',
				raw: markerMatch[0],
				label,
				group: stored.group,
				indent: stored.indent,
				isBlock: true,
				tokens: []
			};
			this.lexer.blockTokens(stored.body, token.tokens);
			return token;
		}

		// ---- Case 2: inline single-paragraph footnote ----
		// Matches [fn(g)?: body] (anonymous) or [^label(g)?: body] (labelled)
		const anonOpening  = OPEN_ANON.exec(src);
		const labelOpening = OPEN_LABEL.exec(src);
		const opening = anonOpening || labelOpening;
		if (!opening) return;

		const closingPos = findClosingBracket(src, 1);
		if (closingPos === -1) return;

		const raw = src.slice(0, closingPos);
		const label = labelOpening ? labelOpening[1] : '_auto' + (++autoLabelCounter);
		const group = normaliseGroup(labelOpening ? labelOpening[2] : anonOpening[1]);
		const body = src.slice(opening[0].length, closingPos - 1).trim();

		// Detect indent from first continuation line
		let indent = '';
		const firstNewline = raw.indexOf('\n');
		if (firstNewline !== -1) {
			const indentMatch = /^([ \t]+)/.exec(raw.slice(firstNewline + 1));
			if (indentMatch) indent = indentMatch[1];
		}

		const token = {
			type: 'inlineFootnote',
			raw,
			label,
			group,
			indent,
			isBlock: false,
			tokens: []
		};
		this.lexer.inline(body, token.tokens);
		return token;
	},

	renderer(token) {
		const group = token.group ?? DEFAULT_GROUP;

		// Render the body in the active format.
		const content = token.isBlock
			? this.parser.parse(token.tokens).trim()
			: this.parser.parseInline(token.tokens);

		if (global.isLatex) {
			if (!endnotesMode) {
				// Historical behaviour: a plain inline footnote.
				let body = content;
				if (token.isBlock && token.indent) body = body.replace(/\n/g, '\n' + token.indent);
				return `\\footnote{${body}}`;
			}
			// Endnotes mode: a superscript mark + collect the body for the list.
			const n = nextNumber(group);
			footnoteEntries.push({ group, n, label: token.label, content });
			return `\\textsuperscript{${n}}`;
		}

		// HTML: always a superscript ref + collected entry (placement decided later).
		const n = nextNumber(group);
		const stored = token.isBlock ? content : `<p>${content}</p>`;
		footnoteEntries.push({ group, n, label: token.label, content: stored });
		return `<sup class="footnote-ref"><a href="#fn-${token.label}" id="fnref-${token.label}">${n}</a></sup>`;
	}
};

// ========================================================================
//  @endnotes placement block extension
// ========================================================================

export const endnotesPlacement = {
	name: 'endnotesPlacement',
	level: 'block',

	start(src) {
		const m = src.match(/(?:^|\n)@endnotes(?![A-Za-z0-9])/);
		return m ? m.index + (m[0][0] === '\n' ? 1 : 0) : undefined;
	},

	tokenizer(src) {
		const m = /^@endnotes(?:\(([^)]*)\))?[ \t]*(\{[^}]*\})?[ \t]*(?:\n|$)/.exec(src);
		if (!m) return;

		endnotesMode = true;

		const group = m[1] === undefined ? ALL_GROUPS : normaliseGroup(m[1]);
		let title;
		if (m[2]) {
			try {
				const parsed = attributesParser(m[2].slice(1, -1));
				if (parsed && parsed.title != null) title = String(parsed.title);
			} catch (e) { /* malformed attrs → no title */ }
		}

		const id = ++placementIdCounter;
		placements.push({ id, group, title });

		return { type: 'endnotesPlacement', raw: m[0], id, group, title };
	},

	renderer(token) {
		// A placeholder that fillEndnotes() resolves once every note is collected —
		// so a placement marker may appear before the notes it gathers.
		if (global.isLatex) return `\n${LATEX_PLACEHOLDER(token.id)}\n`;
		return `${htmlPlaceholder(token.id)}\n`;
	}
};

// ========================================================================
//  Assembling the endnote lists (fillEndnotes)
// ========================================================================

const LATEX_PLACEHOLDER = (id) => `%%JMD-ENDNOTES:${id}%%`;
const htmlPlaceholder = (id) => `<div class="jmd-endnotes" data-endnote-id="${id}"></div>`;

// --- HTML list rendering (byte-compatible with the historical section) -----

// One <ol> of endnote entries, each <li> carrying the backref inside its last <p>.
function htmlList(entries) {
	let html = '<ol>\n';
	for (const { label, content } of entries) {
		const backref = ` <a href="#fnref-${label}" class="footnote-backref">\u21a9</a>`;
		const lastP = content.lastIndexOf('</p>');
		const merged = lastP !== -1
			? content.slice(0, lastP) + backref + content.slice(lastP)
			: content + backref;
		html += `<li id="fn-${label}">\n${merged}\n</li>\n`;
	}
	html += '</ol>\n';
	return html;
}

// The historical trailing section: <section class="footnotes"><h1>Endnotes</h1>…
// Kept verbatim so a plain-footnote document's output never changes.
function classicSectionHTML(entries) {
	if (!entries.length) return '';
	return '\n<section class="footnotes">\n<h1 class="endnotes-heading">Endnotes</h1>\n' + htmlList(entries) + '</section>\n';
}

// A placed / grouped HTML section: optional {title} heading, then one <ol> per
// group.  Groups are labelled (an <h2>) when more than one appears or a named
// group is present — per-group numbering repeats "1", so a merged list would be
// ambiguous without labels.
function htmlSection(groups, byGroup, title) {
	const nonEmpty = groups.filter(g => (byGroup.get(g) || []).length);
	if (!nonEmpty.length) return '';                 // nothing to place → emit nothing
	// Label each group (an <h2>) only when the section holds more than one — a
	// single list needs no label, but per-group numbering repeats "1", so a
	// multi-group section (the `@endnotes` all-form) would be ambiguous without.
	const labelGroups = nonEmpty.length > 1;
	const single = groups.length === 1 ? groups[0] : null;
	const attr = single != null ? ` data-endnote-group="${single === DEFAULT_GROUP ? '' : escAttr(single)}"` : '';
	let html = `\n<section class="footnotes"${attr}>\n`;
	if (title) html += `<h1 class="endnotes-heading">${escHtml(title)}</h1>\n`;
	for (const g of groups) {
		const entries = byGroup.get(g) || [];
		if (!entries.length) continue;
		if (labelGroups && g !== DEFAULT_GROUP) {
			html += `<h2 class="endnote-group-heading">${escHtml(g)}</h2>\n`;
		}
		html += htmlList(entries);
	}
	html += '</section>\n';
	return html;
}

// --- LaTeX list rendering ---------------------------------------------------

function latexEscapeGroupName(s) {
	return String(s).replace(/([&#%_$])/g, '\\$1');
}

// A placed / grouped LaTeX section built by JMarkdown (numbering is ours, so we
// do not lean on endnotes/enotez package semantics): an optional bold title, and
// for each group an optional bold group label then \textsuperscript{n}~body lines.
function latexSection(groups, byGroup, title) {
	const nonEmpty = groups.filter(g => (byGroup.get(g) || []).length);
	if (!nonEmpty.length) return '';
	const labelGroups = nonEmpty.length > 1;
	let out = '\n\\bigskip\n';
	if (title) out += `\\noindent{\\large\\bfseries ${latexEscapeGroupName(title)}}\\par\\nobreak\\smallskip\n`;
	out += '\\begingroup\\setlength{\\parindent}{0pt}\n';
	for (const g of groups) {
		const entries = byGroup.get(g) || [];
		if (!entries.length) continue;
		if (labelGroups && g !== DEFAULT_GROUP) {
			out += `\\smallskip\\noindent{\\bfseries ${latexEscapeGroupName(g)}}\\par\\nobreak\\smallskip\n`;
		}
		for (const { n, content } of entries) {
			out += `\\noindent\\textsuperscript{${n}}~${content}\\par\\smallskip\n`;
		}
	}
	out += '\\endgroup\n';
	return out;
}

// --- escaping helpers (HTML text / attribute) ------------------------------

function escHtml(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
	return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// --- the fill pass ----------------------------------------------------------

// Group the collected entries by group name (preserving per-group order).
function entriesByGroup() {
	const byGroup = new Map();
	for (const e of footnoteEntries) {
		if (!byGroup.has(e.group)) byGroup.set(e.group, []);
		byGroup.get(e.group).push(e);
	}
	return byGroup;
}

/**
 * Replace every @endnotes placeholder with its rendered list, and append any
 * endnotes that no placement claimed (or, with no placements at all, the whole
 * historical trailing section).  Call after marked.parse().
 *
 * @param {string} content — the parsed body (HTML or LaTeX)
 * @param {'html'|'latex'} format
 */
export function fillEndnotes(content, format) {
	if (!footnoteEntries.length && !placements.length) return content;

	const byGroup = entriesByGroup();
	const onlyDefault = groupOrder.length <= 1 && (groupOrder.length === 0 || groupOrder[0] === DEFAULT_GROUP);

	// ---- No placement markers: append a trailing section (historical path) ----
	if (placements.length === 0) {
		if (!footnoteEntries.length) return content;      // LaTeX \footnote path: nothing to append
		if (format === 'latex') {
			return content + latexSection(groupOrder, byGroup, null);
		}
		return content + (onlyDefault
			? classicSectionHTML(byGroup.get(DEFAULT_GROUP) || [])
			: htmlSection(groupOrder, byGroup, null));
	}

	// ---- With placement markers ----
	const claimed = new Set(placements.filter(p => p.group !== ALL_GROUPS).map(p => p.group));
	let allEmitted = false;

	for (const p of placements) {
		let fill = '';
		if (p.group === ALL_GROUPS) {
			if (allEmitted) {
				addWarning('Multiple bare `@endnotes` markers — only the first prints the remaining groups');
			} else {
				const groups = groupOrder.filter(g => !claimed.has(g));
				fill = groups.length
					? (format === 'latex' ? latexSection(groups, byGroup, p.title) : htmlSection(groups, byGroup, p.title))
					: '';
				allEmitted = true;
			}
		} else {
			const entries = byGroup.get(p.group) || [];
			if (!entries.length) {
				addWarning(`\`@endnotes(${p.group})\` — no endnotes are in group "${p.group}"`);
			}
			fill = format === 'latex'
				? latexSection([p.group], byGroup, p.title)
				: htmlSection([p.group], byGroup, p.title);
		}
		const needle = format === 'latex' ? LATEX_PLACEHOLDER(p.id) : htmlPlaceholder(p.id);
		content = content.split(needle).join(fill);
	}

	// ---- Anything no placement claimed → append at the end (never drop notes) ----
	const placedByAll = allEmitted ? groupOrder.filter(g => !claimed.has(g)) : [];
	const placedSet = new Set([...claimed, ...placedByAll]);
	const unplaced = groupOrder.filter(g => !placedSet.has(g));
	if (unplaced.length) {
		addWarning(`Endnote group(s) never placed: ${unplaced.map(g => g === DEFAULT_GROUP ? '(default)' : g).join(', ')} — appended at end`);
		content += format === 'latex'
			? latexSection(unplaced, byGroup, null)
			: htmlSection(unplaced, byGroup, null);
	}

	return content;
}

// ========================================================================
//  Deprecated shim
// ========================================================================

/**
 * DEPRECATED: endnote assembly moved to fillEndnotes(), which is placement-aware.
 * Retained as a no-op so any external caller keeps working; index.js now calls
 * fillEndnotes() instead.
 */
export function getFootnotesHTML() {
	return '';
}
