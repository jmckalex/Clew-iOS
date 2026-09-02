// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Emacs' M-q for markdown: hard-wrap the paragraph at the cursor (or every
// paragraph in the selection) to a fill column, so prose lives as real lines
// and diffs stay word-sized. Rendering is unaffected — the engine keeps
// marked's default where a single newline inside a paragraph is a space.
//
// Markdown makes this more than string-chopping, in both directions:
// - JOINING must stop at structure: fenced code, frontmatter, $$ math,
//   tables, headings, rules, ::: containers, @directives, callout headers,
//   a `^block-id` on its own line — and at every list item or change of
//   quote depth.
// - BREAKING must not invent structure: a wikilink, inline code, inline
//   math, or \cite{…} is one unbreakable word (a newline inside would
//   unlink it), and a word like `-` or `2.` never starts a line (it would
//   be reparsed as a list marker).
// - PREFIXES follow Emacs' adaptive fill: blockquotes rewrap carrying their
//   `> `, list items refill with hanging indent under the marker.
//
// The parsing and filling below are pure functions over arrays of lines,
// which is why they can be unit-tested; only fillAtCursor and the
// auto-fill input handler at the bottom touch CodeMirror.
import { EditorView } from '@codemirror/view';

const TAB_WIDTH = 4;

// ---- line classification ---------------------------------------------------

const FENCE_OPEN = /^\s*(```+|~~~+)/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const TABLE = /^\s*\|/;
// - - -, ***, ___ (also plain --- : a rule here, a setext underline after
// prose — either way a line that must never be joined into a paragraph).
const HR = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const SETEXT_EQ = /^\s{0,3}=+\s*$/;
const MATH_DELIM = /^\s*\$\$\s*$/;
// jmarkdown containers and @-directives live at their own line starts.
const DIRECTIVE = /^\s*:::|^@[A-Za-z]/;
const CALLOUT_HEADER = /^\s*(?:>\s*)+\[![^\]]*\]/;
const BLOCK_ID_ONLY = /^\s*\^[A-Za-z0-9-]+\s*$/;

const QUOTE_PREFIX = /^(\s*(?:>\s?)+)/;
const LIST_MARKER = /^(\s*)((?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX/-]\]\s+)?)/;
// jmarkdown centered text (syntax-enhancements centerAlign): every line of
// the block is `>> content <<`. It opens with the quote sigil, so it must
// be told apart from a depth-2 blockquote — and a filled line must keep
// BOTH delimiters, because the engine's per-line rule rejects a line
// without its closing `<<` and the whole block stops being centered.
const CENTERED = /^>> .*<<\s*$/;

const isBlank = (line) => /^\s*(?:>\s*)*$/.test(line);

function isStructural(line) {
	return HEADING.test(line) || TABLE.test(line) || FENCE_OPEN.test(line)
		|| HR.test(line) || SETEXT_EQ.test(line) || MATH_DELIM.test(line)
		|| DIRECTIVE.test(line) || CALLOUT_HEADER.test(line)
		|| BLOCK_ID_ONLY.test(line);
}

const quoteDepth = (line) =>
	(QUOTE_PREFIX.exec(line)?.[1].match(/>/g) ?? []).length;

const stripQuote = (line) => line.replace(QUOTE_PREFIX, '');

function displayWidth(s) {
	let w = 0;
	for (const ch of s) w += ch === '\t' ? TAB_WIDTH : 1;
	return w;
}

/**
 * Which lines are inside fenced code, the frontmatter block, or $$ math —
 * regions the paragraph finder must neither start in nor extend into.
 * Computed once per fill over the whole document.
 */
export function inertMap(lines) {
	const inert = new Array(lines.length).fill(false);
	let i = 0;
	if (lines[0] === '---') {
		const end = lines.findIndex((l, j) => j > 0 && /^(?:---|\.\.\.)\s*$/.test(l));
		if (end !== -1) {
			for (let j = 0; j <= end; j++) inert[j] = true;
			i = end + 1;
		}
	}
	let fence = null;
	let math = false;
	for (; i < lines.length; i++) {
		if (fence) {
			inert[i] = true;
			if (new RegExp(`^\\s*${fence}`).test(lines[i])) fence = null;
			continue;
		}
		if (math) {
			inert[i] = true;
			if (MATH_DELIM.test(lines[i])) math = false;
			continue;
		}
		const open = FENCE_OPEN.exec(lines[i]);
		if (open) { inert[i] = true; fence = open[1].slice(0, 3); continue; }
		if (MATH_DELIM.test(lines[i])) { inert[i] = true; math = true; }
	}
	return inert;
}

// ---- words -----------------------------------------------------------------

// Spans a line break must never fall inside, matched as single words even
// across their internal spaces. Math and code require non-space content at
// both edges so a stray `$` or backtick cannot swallow half the paragraph.
const ATOM = new RegExp(
	'!?\\[\\[[^\\]]*\\]\\]'                            // [[wikilink]] / ![[embed]]
	+ '|\\[[^\\]]*\\]\\([^)\\s]*\\)'                   // [text](url)
	+ '|`\\S(?:[^`]*?\\S)?`'                           // `inline code`
	+ '|\\$\\S(?:[^$]*?\\S)?\\$'                       // $inline math$
	+ '|\\\\[A-Za-z]+(?:\\[[^\\]]*\\])?(?:\\{[^{}]*\\})+', // \citep[p. 1]{key}
	'y');

/** Split paragraph text into words, keeping atomic spans whole. */
export function tokenize(text) {
	const words = [];
	let i = 0;
	while (i < text.length) {
		if (/\s/.test(text[i])) { i++; continue; }
		let word = '';
		while (i < text.length && !/\s/.test(text[i])) {
			ATOM.lastIndex = i;
			const m = ATOM.exec(text);
			if (m) { word += m[0]; i += m[0].length; }
			else { word += text[i]; i += 1; }
		}
		words.push(word);
	}
	return words;
}

// A word that markdown would reparse as block syntax if it began a line.
// Such a word is kept on the current line even past the fill column.
const DANGEROUS_AT_LINE_START = /^(?:[-*+]|\d{1,9}[.)]|>+|#{1,6}|:::|\$\$)$|^@[A-Za-z]/;

/** Greedy fill: words → lines within `column`, prefix-aware. */
export function fillWords(words, column, prefixFirst, prefixRest) {
	const out = [];
	let line = prefixFirst;
	let w = displayWidth(prefixFirst);
	let bare = true;
	for (const word of words) {
		const wl = displayWidth(word);
		if (!bare && w + 1 + wl > column && !DANGEROUS_AT_LINE_START.test(word)) {
			out.push(line);
			line = prefixRest;
			w = displayWidth(prefixRest);
			bare = true;
		}
		line += (bare ? '' : ' ') + word;
		w += (bare ? 0 : 1) + wl;
		bare = false;
	}
	if (!bare || out.length === 0) out.push(line);
	return out;
}

/** Atomic spans within `text`, as [start, end) index pairs. */
function atomSpans(text) {
	const spans = [];
	let i = 0;
	while (i < text.length) {
		if (/\s/.test(text[i])) { i++; continue; }
		ATOM.lastIndex = i;
		const m = ATOM.exec(text);
		if (m) { spans.push([i, i + m[0].length]); i += m[0].length; }
		else i++;
	}
	return spans;
}

/**
 * The last whitespace run in `text` where a break keeps the head within
 * `column` — never inside an atom, never at or before `minIndex` (the
 * line's own prefix), never before a word that would be reparsed as block
 * syntax, and never the trailing run (nothing to move). Returns the run's
 * [start, end) or null.
 */
function breakPointIn(text, column, minIndex) {
	const atoms = atomSpans(text);
	const trimmed = text.replace(/\s+$/, '').length;
	let best = null;
	const re = /\s+/g;
	let m;
	while ((m = re.exec(text))) {
		const start = m.index;
		const end = start + m[0].length;
		if (end > trimmed) break;                       // the trailing run
		if (displayWidth(text.slice(0, start)) > column) break;   // runs are ordered
		if (start <= minIndex) continue;
		if (atoms.some(([a, b]) => start > a && start < b)) continue;
		const nextWord = /^\S+/.exec(text.slice(end))?.[0] ?? '';
		if (DANGEROUS_AT_LINE_START.test(nextWord)) continue;
		best = [start, end];
	}
	return best;
}

/**
 * Emacs' do-auto-fill for one line: break `text` (a single line including
 * its own prefix) at whitespace until every piece fits `column`, later
 * pieces opening with `prefixRest`. Spacing between words is preserved —
 * only the runs chosen as break points become newlines. Returns the
 * resulting lines; length 1 means no valid break existed.
 */
export function autoBreakLine(text, column, prefixRest, minIndex = 0) {
	const out = [];
	let current = text;
	let min = minIndex;
	for (let guard = 0; guard < 50; guard++) {
		if (displayWidth(current.replace(/\s+$/, '')) <= column) break;
		const bp = breakPointIn(current, column, min);
		if (!bp) break;
		out.push(current.slice(0, bp[0]));
		current = prefixRest + current.slice(bp[1]);
		min = prefixRest.length;
	}
	out.push(current);
	return out;
}

// ---- paragraphs ------------------------------------------------------------

function startsParagraph(lines, inert, j) {
	if (j === 0) return true;
	const prev = lines[j - 1];
	if (inert[j - 1] || isBlank(prev) || isStructural(prev)) return true;
	if (CENTERED.test(lines[j]) !== CENTERED.test(prev)) return true;
	if (LIST_MARKER.test(stripQuote(lines[j]))) return true;
	return quoteDepth(lines[j]) !== quoteDepth(prev);
}

/**
 * The fillable paragraph containing line `i`, or null when `i` is blank,
 * structural, inert, or indented code. Returns { from, to, prefixFirst,
 * prefixRest, words } over 0-based line indices, inclusive.
 */
export function paragraphAt(lines, inert, i) {
	if (i < 0 || i >= lines.length) return null;
	if (inert[i] || isBlank(lines[i]) || isStructural(lines[i])) return null;

	let from = i;
	while (from > 0 && !startsParagraph(lines, inert, from)) from--;
	const depth = quoteDepth(lines[from]);
	const centered = CENTERED.test(lines[from]);
	let to = from;
	while (to + 1 < lines.length) {
		const next = lines[to + 1];
		if (inert[to + 1] || isBlank(next) || isStructural(next)) break;
		if (CENTERED.test(next) !== centered) break;
		if (LIST_MARKER.test(stripQuote(next))) break;
		if (quoteDepth(next) !== depth) break;
		to++;
	}

	if (centered) {
		const words = tokenize(lines.slice(from, to + 1)
			.map((l) => l.replace(/^>> ?/, '').replace(/<<\s*$/, '').trim())
			.join(' '));
		return { from, to, prefixFirst: '>> ', prefixRest: '>> ', suffix: ' <<', words };
	}

	const quotePre = QUOTE_PREFIX.exec(lines[from])?.[1] ?? '';
	const rest0 = lines[from].slice(quotePre.length);
	const list = LIST_MARKER.exec(rest0);
	let prefixFirst, prefixRest;
	if (list) {
		prefixFirst = quotePre + list[1] + list[2];
		prefixRest = quotePre + (list[1] + list[2]).replace(/\S/g, ' ');
	} else if (quotePre) {
		prefixFirst = prefixRest = quotePre;
	} else {
		const ws = /^\s*/.exec(lines[from])[0];
		// A paragraph opening at 4+ columns of indent is an indented code
		// block; a fill that joined or rewrapped it would corrupt it.
		if (displayWidth(ws) >= 4) return null;
		prefixFirst = prefixRest = ws;
	}

	const parts = [];
	for (let j = from; j <= to; j++) {
		let s = stripQuote(lines[j]);
		if (j === from && list) s = s.slice(list[0].length);
		parts.push(s.trim());
	}
	return { from, to, prefixFirst, prefixRest, suffix: '', words: tokenize(parts.join(' ')) };
}

/**
 * Fill every paragraph intersecting [fromLine, toLine]. Returns a list of
 * { from, to, lines } replacements (0-based, inclusive), skipping paragraphs
 * the fill would leave unchanged.
 */
export function fillLineRange(lines, fromLine, toLine, column) {
	const inert = inertMap(lines);
	const out = [];
	let i = Math.max(0, fromLine);
	const stop = Math.min(lines.length - 1, toLine);
	while (i <= stop) {
		const para = paragraphAt(lines, inert, i);
		if (!para) { i++; continue; }
		// A suffix (centered text's ` <<`) costs width on every line.
		const filled = fillWords(para.words, column - displayWidth(para.suffix),
			para.prefixFirst, para.prefixRest)
			.map((l) => l + para.suffix);
		const original = lines.slice(para.from, para.to + 1);
		if (filled.length !== original.length || filled.some((l, k) => l !== original[k])) {
			out.push({ from: para.from, to: para.to, lines: filled });
		}
		i = para.to + 1;
	}
	return out;
}

// ---- the command (the only part that touches CodeMirror) -------------------

/**
 * Fill the paragraph at the cursor, or every paragraph the selection
 * touches. Returns false when there was nothing to do.
 */
export function fillAtCursor(view, column) {
	const { doc } = view.state;
	const lines = [];
	for (let n = 1; n <= doc.lines; n++) lines.push(doc.line(n).text);
	const sel = view.state.selection.main;
	const fromLine = doc.lineAt(sel.from).number - 1;
	const toLine = doc.lineAt(sel.to).number - 1;
	const repls = fillLineRange(lines, fromLine, toLine, column);
	if (repls.length === 0) return false;
	view.dispatch({
		changes: repls.map((r) => ({
			from: doc.line(r.from + 1).from,
			to: doc.line(r.to + 1).to,
			insert: r.lines.join('\n'),
		})),
		userEvent: 'format.fill',
	});
	return true;
}

/**
 * Auto-fill mode: wrap while typing, Emacs-style. Fires only when a SPACE
 * is typed with the cursor past the fill column — then the text behind the
 * cursor is broken at the last fitting point(s) and the cursor rides onto
 * the new line. Everything else (Enter included) types normally, paste is
 * never touched (it does not pass through inputHandler), and the same
 * paragraph analysis as fill-paragraph guards fences, math, frontmatter,
 * tables and headings. `getOptions` is read per keystroke so the settings
 * toggle applies live with no editor reconfiguration.
 */
export function autoFillHandler(getOptions) {
	return EditorView.inputHandler.of((view, from, to, text) => {
		if (text !== ' ' || from !== to || view.composing) return false;
		const { enabled, column } = getOptions();
		if (!enabled) return false;
		const { state } = view;
		if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
		const line = state.doc.lineAt(from);
		const cut = from - line.from;
		// Emacs' trigger: the CURSOR is past the column (typing into the
		// middle of a long line at column 20 does not reflow it).
		if (displayWidth(line.text.slice(0, cut)) + 1 <= column) return false;
		const lines = [];
		for (let n = 1; n <= state.doc.lines; n++) lines.push(state.doc.line(n).text);
		const para = paragraphAt(lines, inertMap(lines), line.number - 1);
		if (!para) return false;
		// The line's own prefix bounds the earliest legal break.
		const quote = QUOTE_PREFIX.exec(line.text)?.[1] ?? '';
		const marker = LIST_MARKER.exec(line.text.slice(quote.length));
		const minIndex = quote.length
			+ (marker ? marker[0].length : /^\s*/.exec(line.text.slice(quote.length))[0].length);
		const head = line.text.slice(0, cut) + ' ';
		const tail = line.text.slice(cut);
		const broken = autoBreakLine(head, column - displayWidth(para.suffix),
			para.prefixRest, minIndex);
		if (broken.length === 1) return false;
		// Completed lines take the suffix (centered text's ` <<`); the last
		// piece is still being typed and the tail carries the original one.
		for (let k = 0; k < broken.length - 1; k++) broken[k] += para.suffix;
		const insert = broken.join('\n') + tail;
		view.dispatch({
			changes: { from: line.from, to: line.to, insert },
			selection: { anchor: line.from + insert.length - tail.length },
			userEvent: 'input.type',
			scrollIntoView: true,
		});
		return true;
	});
}
