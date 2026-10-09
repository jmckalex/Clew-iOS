// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * @file Math-segment scanning.
 *
 * Ported from the jmacs project (`packages/renderer/src/math-segments.js`,
 * GPL-3.0-or-later, same author). In Clew this serves the jmarkdown
 * scanner's masking pass (`maskMarkdownCode` + `scanMathSegments`); the
 * jmacs preview helpers and the tree-sitter node-range adapter were
 * dropped in the port (there is no MathJax preview and no tree-sitter
 * here). The scanner itself is unchanged.
 *
 * A *math segment* is a stretch of buffer text that is either delimited
 * by one of the four LaTeX math delimiter pairs or a display-math
 * `\begin{…}…\end{…}` environment:
 *
 *   - `$ … $`   and `\( … \)`  → inline math   (`kind: 'inline'`)
 *   - `$$ … $$` and `\[ … \]`  → display math  (`kind: 'block'`, may span lines)
 *   - `\begin{align}…\end{align}` and friends (equation, gather, multline,
 *     alignat, flalign, eqnarray, displaymath; starred or not) → display
 *     math (`kind: 'block'`, usually spanning lines)
 *
 * Which of those constructs the scanner recognises is controlled by a
 * `config` argument (see `MathConfig`), so the same scanner serves every
 * major mode: `LATEX_MATH_CONFIG` recognises all of them (the LaTeX
 * default), and `MARKDOWN_MATH_CONFIG` likewise recognises the four
 * delimiter pairs **and** `\begin…\end` environments — everything MathJax
 * typesets — for markdown and, later, html/php. (Markdown's only
 * difference is at the provider layer, which masks code first.)
 * `scanMathSegments(text)` with no config defaults to `LATEX_MATH_CONFIG`,
 * so existing LaTeX callers are unchanged.
 *
 * The scanner walks the text once and returns the segments it finds as
 * `{ start, end, kind, body }`:
 *
 *   - `start` is the offset of the opening delimiter's first character;
 *   - `end` is the offset one past the closing delimiter's last character;
 *   - `kind` is `'inline'` or `'block'`;
 *   - `body` is the source *between* the delimiters (delimiters stripped)
 *     — or, for a `\begin…\end` environment, the *full* environment source
 *     (MathJax processes the environment itself). It is the typeset input
 *     and the cache key.
 *
 * This module is pure and DOM-free, so it is tested on its own.
 *
 * Escaping and verbatim/comment regions: the delimiter scanner respects
 * backslash escaping (`\$` is a literal dollar, never a math delimiter)
 * and skips `%` line comments (LaTeX only — see the `comments` config
 * flag). It does *not* understand `\verb` or `verbatim` environments —
 * it is a best-effort raw scanner.
 *
 * ── Segment boundaries are the whole safety story ─────────────────────
 * Everything downstream typesets `body`, so a segment whose `end` lands
 * on the wrong delimiter hands MathJax text that is not math. The user-
 * visible failure is a *runaway*: an edit near one delimiter (typing `_`
 * before a closing `$`, deleting half of a `$$`) makes the scanner pair
 * with some *later* document delimiter, so prose — and the next
 * construct's opening delimiter — are swallowed into one body and
 * typeset. TeX subscripts a captured `$` quite happily; the result is
 * garbage on screen.
 *
 * Two rules keep a body strictly inside its own delimiters:
 *
 *   1. **No delimiter-pair segment crosses a paragraph break** (a blank
 *      line). This is TeX's own rule — a blank line inside `$…$` /
 *      `$$…$$` / `\(…\)` / `\[…\]` is "Missing $ inserted" — and it is
 *      what stops one unbalanced delimiter cascading down the document.
 *      `\begin…\end` environments are exempt: their closer is an
 *      unambiguous literal, so there is nothing to mis-pair.
 *   2. **An unescaped lone `$` inside `$$…$$` aborts the scan.** It
 *      cannot be a close and it cannot legally be content, so consuming
 *      it (the old behaviour) was the one way a raw `$` reached MathJax.
 *
 * A construct that breaks either rule yields *no segment* — it renders
 * as plain source, which is the honest, non-destructive fallback while
 * text is half-typed.
 */

/**
 * @typedef {object} MathSegment
 * @property {number} start - Offset of the opening delimiter's first char.
 * @property {number} end - Offset one past the closing delimiter's last char.
 * @property {'inline'|'block'} kind - Inline (`$…$`, `\(…\)`) or display
 *   (`$$…$$`, `\[…\]`).
 * @property {string} body - The source between the delimiters.
 */

/**
 * Which math constructs `scanMathSegments` recognises. Every flag
 * defaults to *on* when the field is absent, so an empty/partial config
 * still scans everything — pass `false` to turn a construct off.
 *
 * @typedef {object} MathConfig
 * @property {boolean} [inlineDollar] - Recognise `$…$` inline math.
 * @property {boolean} [displayDollar] - Recognise `$$…$$` display math.
 * @property {boolean} [parens] - Recognise `\(…\)` inline math.
 * @property {boolean} [brackets] - Recognise `\[…\]` display math.
 * @property {boolean} [comments] - Treat an unescaped `%` as starting a
 *   line comment, so a `$` inside it is never a delimiter (LaTeX). Off
 *   for Markdown-like modes, where `%` is ordinary text.
 * @property {boolean|string[]} [environments] - Recognise display-math
 *   `\begin{…}…\end{…}` environments. `true`/absent → the built-in set
 *   (equation, align, …); `false` → none; an array → only those base
 *   environment names (the starred form is matched too).
 */

/**
 * The display-math `\begin{…}…\end{…}` environments MathJax typesets at
 * the top level (base names; the starred form is stripped before lookup).
 * Inner environments used *inside* math (matrix, cases, …) are not here —
 * they appear within another segment, not standalone.
 *
 * @type {readonly string[]}
 */
export const MATH_ENVIRONMENT_NAMES = Object.freeze([
	'equation',
	'align',
	'alignat',
	'gather',
	'multline',
	'flalign',
	'eqnarray',
	'displaymath',
]);

/**
 * The TeX MathJax is given for an `@begin(<name>)` math block (live edit's
 * widget, the preview pane). An `equation` is an UNNUMBERED display, as the
 * engine's HTML is (jmarkdown equations.js: `\[…\]`, its "(n)" appended by
 * the post-processor) — the number is Clew's own (live/numbering.js). Given
 * `\begin{equation}`, MathJax (`tags: 'ams'`) numbered it too, from its own
 * running count: "(1)(1)" overlapping at the right. Every other environment
 * is MathJax's to number, in reading view as here, so it goes as written.
 *
 * @param {string} name
 * @param {string} body
 * @returns {string}
 */
export function mathEnvironmentTex(name, body) {
	return name === 'equation' ? body : `\\begin{${name}}\n${body}\n\\end{${name}}`;
}

/**
 * The full LaTeX config: every delimiter pair plus `\begin…\end` math
 * environments. This is the historical (and default) behaviour, used by
 * `latex-mode`.
 *
 * @type {Readonly<MathConfig>}
 */
export const LATEX_MATH_CONFIG = Object.freeze({
	inlineDollar: true,
	displayDollar: true,
	parens: true,
	brackets: true,
	comments: true,
	environments: true,
});

/**
 * The config for Markdown-like prose modes (`markdown-mode`, and, when
 * they land, html/php): every delimiter pair **and** `\begin…\end` math
 * environments — i.e. everything MathJax typesets, since MathJax's
 * default `processEnvironments` handles `\begin{align}` & friends in
 * prose too. (It currently matches `LATEX_MATH_CONFIG`'s notation set;
 * the markdown-specific behaviour — ignoring a `$` inside a code
 * span/fence — lives in the preview provider's code masking, see
 * {@link maskMarkdownCode}, not in this config.)
 *
 * The one flag that differs from LaTeX is `comments`: a `%` is ordinary
 * text in prose (`50% of $x$`), so treating it as a comment start would
 * hide every construct after it on the line.
 *
 * @type {Readonly<MathConfig>}
 */
export const MARKDOWN_MATH_CONFIG = Object.freeze({
	inlineDollar: true,
	displayDollar: true,
	parens: true,
	brackets: true,
	comments: false,
	environments: true,
});

/**
 * True when the character at `index` in `text` is escaped — preceded by
 * an odd number of consecutive backslashes. `\$` is escaped (one
 * backslash), `\\$` is not (two backslashes escape each other, leaving
 * the `$` live).
 *
 * @param {string} text
 * @param {number} index
 * @returns {boolean}
 */
function isEscaped(text, index) {
	let backslashes = 0;
	let i = index - 1;
	while (i >= 0 && text.charCodeAt(i) === 92 /* '\\' */) {
		backslashes += 1;
		i -= 1;
	}
	return (backslashes & 1) === 1;
}

/**
 * Scan LaTeX source for math segments, respecting backslash escaping and
 * `%` line comments. Returns the segments in document order, none
 * overlapping.
 *
 * The scan is delimiter-driven and forgiving: an opening delimiter with
 * no matching close (a half-typed `$`, or a `\[` with no `\]`) is *not*
 * reported — there is no complete segment yet, so nothing is replaced.
 * This is exactly the right behaviour while the user is authoring fresh
 * math.
 *
 * Precedence at a given position, longest delimiter first, so `$$`
 * beats `$`:
 *
 *   1. `$$ … $$`  (display)
 *   2. `\[ … \]`  (display)
 *   3. `\( … \)`  (inline)
 *   4. `$ … $`    (inline)
 *
 * @param {string} text - The buffer text.
 * @param {MathConfig} [config] - Which constructs to recognise. Defaults
 *   to `LATEX_MATH_CONFIG` (everything), so existing LaTeX callers that
 *   pass only `text` are unchanged.
 * @returns {MathSegment[]}
 */
export function scanMathSegments(text, config = LATEX_MATH_CONFIG) {
	if (typeof text !== 'string' || text.length === 0) return [];
	// Resolve the config flags once. An absent flag defaults to *on*, so a
	// bare `{}` (or no config) scans everything.
	const inlineDollar = config.inlineDollar !== false;
	const displayDollar = config.displayDollar !== false;
	const parens = config.parens !== false;
	const brackets = config.brackets !== false;
	const comments = config.comments !== false;
	const environments = config.environments ?? true;
	/** @type {Set<string> | null} */
	const envNames = resolveEnvNames(environments);
	/** @type {MathSegment[]} */
	const segments = [];
	let i = 0;
	const n = text.length;
	// The next paragraph break, memoised. `paragraphLimit` answers "the
	// first blank line at or after HERE", and the scan only ever moves
	// forward, so the cached answer stays exact until we pass it — which
	// keeps the whole scan linear instead of re-walking each paragraph
	// once per opener.
	let paraLimit = -1;
	const limitFrom = (from) => {
		if (from >= paraLimit) paraLimit = paragraphLimit(text, from);
		return paraLimit;
	};

	while (i < n) {
		const ch = text.charCodeAt(i);

		// Skip `%` line comments (unless the `%` is escaped — `\%`).
		if (comments && ch === 37 /* '%' */ && !isEscaped(text, i)) {
			const nl = text.indexOf('\n', i);
			i = nl === -1 ? n : nl + 1;
			continue;
		}

		// A backslash starts either an escape (`\$`, `\%`) or a delimiter
		// command (`\(`, `\[`). `\(` / `\[` are math openers; any other
		// `\x` consumes the following char so e.g. `\$` is never a `$`.
		if (ch === 92 /* '\\' */) {
			// `\begin{ENV}…\end{ENV}` math environments (align, equation,
			// gather, multline, alignat, flalign, eqnarray, displaymath — and
			// their starred forms). MathJax typesets the whole environment, so
			// the segment body is the *full* `\begin…\end` source (delimiters
			// are part of the math, not stripped). Always display (`block`).
			if (envNames && text.startsWith('\\begin{', i)) {
				const env = scanEnvironment(text, i, envNames);
				if (env) {
					segments.push(env);
					i = env.end;
					continue;
				}
				// Not a math environment (or no matching `\end`) — fall through
				// and treat the backslash as an ordinary command.
			}
			const next = text.charCodeAt(i + 1);
			if (parens && next === 40 /* '(' */) {
				const found = scanTo(text, i + 2, '\\)', limitFrom(i + 2), comments);
				if (found !== -1) {
					segments.push({
						start: i,
						end: found + 2,
						kind: 'inline',
						body: text.slice(i + 2, found),
					});
					i = found + 2;
					continue;
				}
				// No close — skip just the opener so a later `$…$` still scans.
				i += 2;
				continue;
			}
			if (brackets && next === 91 /* '[' */) {
				const found = scanTo(text, i + 2, '\\]', limitFrom(i + 2), comments);
				if (found !== -1) {
					segments.push({
						start: i,
						end: found + 2,
						kind: 'block',
						body: text.slice(i + 2, found),
					});
					i = found + 2;
					continue;
				}
				i += 2;
				continue;
			}
			// A plain escape (`\$`, `\%`, `\\`, …): consume the escaped char
			// so it can never be read as a delimiter.
			i += 2;
			continue;
		}

		if (ch === 36 /* '$' */) {
			const isDouble = text.charCodeAt(i + 1) === 36;
			if (isDouble) {
				if (displayDollar) {
					const found = scanToDollar(text, i + 2, true, limitFrom(i + 2), comments);
					if (found !== -1) {
						segments.push({
							start: i,
							end: found + 2,
							kind: 'block',
							body: text.slice(i + 2, found),
						});
						i = found + 2;
						continue;
					}
				}
				i += 2;
				continue;
			}
			if (inlineDollar) {
				const found = scanToDollar(text, i + 1, false, limitFrom(i + 1), comments);
				if (found !== -1) {
					segments.push({
						start: i,
						end: found + 1,
						kind: 'inline',
						body: text.slice(i + 1, found),
					});
					i = found + 1;
					continue;
				}
			}
			i += 1;
			continue;
		}

		i += 1;
	}

	return segments;
}

/** The built-in math-environment names as a Set (lazy singleton). */
const MATH_ENVIRONMENTS = new Set(MATH_ENVIRONMENT_NAMES);

/**
 * Resolve the `environments` config flag to the set of base names to
 * recognise, or null when environments are off.
 *
 * @param {boolean|string[]} environments
 * @returns {Set<string> | null}
 */
function resolveEnvNames(environments) {
	if (environments === false) return null;
	if (Array.isArray(environments)) return new Set(environments);
	return MATH_ENVIRONMENTS;
}

/**
 * Parse a `\begin{ENV}…\end{ENV}` math environment whose `\begin` is at
 * `start` (the backslash). Returns a `block` segment whose `body` is the
 * *full* source (`\begin{ENV}` … `\end{ENV}` included — MathJax processes
 * the environment itself), or null when ENV isn't a recognised math
 * environment or there's no matching `\end`.
 *
 * @param {string} text
 * @param {number} start - Offset of the `\` in `\begin{`.
 * @param {Set<string>} envNames - The recognised base environment names.
 * @returns {MathSegment | null}
 */
function scanEnvironment(text, start, envNames) {
	const nameStart = start + '\\begin{'.length;
	const nameEnd = text.indexOf('}', nameStart);
	if (nameEnd === -1) return null;
	const name = text.slice(nameStart, nameEnd);
	const base = name.endsWith('*') ? name.slice(0, -1) : name;
	if (!envNames.has(base)) return null;
	// The matching close. These top-level environments don't nest the same
	// name, so the first `\end{NAME}` after the opener is the right one.
	const closer = `\\end{${name}}`;
	const closeAt = text.indexOf(closer, nameEnd + 1);
	if (closeAt === -1) return null;
	const end = closeAt + closer.length;
	return { start, end, kind: 'block', body: text.slice(start, end) };
}

/**
 * The offset a delimiter-pair segment opened at `from` must close before:
 * the next paragraph break (a newline whose following whitespace run
 * reaches another newline), or the end of the text when there is none.
 *
 * A blank line ends a paragraph, and TeX will not carry math across one —
 * `$…$`, `$$…$$`, `\(…\)` and `\[…\]` all raise "Missing $ inserted"
 * there. Honouring that bound is what stops a single unbalanced delimiter
 * pairing with something pages away and swallowing the prose (and the
 * next construct's opening delimiter) in between.
 *
 * @param {string} text
 * @param {number} from - The first offset of the body.
 * @returns {number} The exclusive limit for the closing delimiter.
 */
function paragraphLimit(text, from) {
	const n = text.length;
	let i = from;
	while (i < n) {
		const nl = text.indexOf('\n', i);
		if (nl === -1) return n;
		// Walk the whitespace run after this newline: reaching a second
		// newline first means the line between them is blank.
		let j = nl + 1;
		while (j < n) {
			const c = text.charCodeAt(j);
			if (c === 10 /* '\n' */) return nl;
			if (c !== 32 /* ' ' */ && c !== 9 /* '\t' */ && c !== 13 /* '\r' */) break;
			j += 1;
		}
		if (j >= n) return n; // trailing whitespace only — no break
		i = j;
	}
	return n;
}

/**
 * Find the offset of the next unescaped occurrence of the literal
 * `closer` (a `\)` or `\]`) at or after `from`, before `limit`. Returns
 * the index of the closer's first character, or -1 if none — including
 * when the only candidate lies past `limit` (the paragraph break).
 *
 * With `comments` on (LaTeX), a `%` run to end of line is skipped, so a
 * commented-out `\)` never closes live math.
 *
 * @param {string} text
 * @param {number} from
 * @param {string} closer - Either `'\\)'` or `'\\]'`.
 * @param {number} limit - Exclusive scan limit (see {@link paragraphLimit}).
 * @param {boolean} comments - Whether `%` starts a line comment.
 * @returns {number}
 */
function scanTo(text, from, closer, limit, comments) {
	const closerChar = closer.charCodeAt(1); // ')' or ']'
	let i = from;
	while (i < limit) {
		const ch = text.charCodeAt(i);
		if (ch === 92 /* '\\' */) {
			if (text.charCodeAt(i + 1) === closerChar) return i;
			// Any other escape consumes the next char (`\\`, `\$`, …).
			i += 2;
			continue;
		}
		if (comments && ch === 37 /* '%' */) {
			const nl = text.indexOf('\n', i);
			if (nl === -1) return -1;
			i = nl + 1;
			continue;
		}
		i += 1;
	}
	return -1;
}

/**
 * Find the offset of the next unescaped `$` (single) or `$$` (double)
 * closer at or after `from`, before `limit`. Returns the index of the
 * closing `$`'s first character, or -1 if there is none in range.
 *
 * An unescaped lone `$` met while looking for a `$$` **aborts** the scan
 * (-1) rather than being consumed as content. It can be neither a close
 * nor legal display-math content, so consuming it was the one way a raw
 * delimiter reached the typesetter: `$$a + b_$ … $$` fed MathJax
 * `a + b_$`, which cheerfully subscripts the dollar. Refusing the
 * segment leaves the source on screen instead.
 *
 * @param {string} text
 * @param {number} from
 * @param {boolean} wantDouble - When true, a single `$` does not close;
 *   only `$$` does.
 * @param {number} limit - Exclusive scan limit (see {@link paragraphLimit}).
 * @param {boolean} comments - Whether `%` starts a line comment.
 * @returns {number}
 */
function scanToDollar(text, from, wantDouble, limit, comments) {
	let i = from;
	while (i < limit) {
		const ch = text.charCodeAt(i);
		if (ch === 92 /* '\\' */) {
			// Escape: consume the escaped character (`\$` is literal).
			i += 2;
			continue;
		}
		if (comments && ch === 37 /* '%' */) {
			// A commented-out `$` is not a delimiter.
			const nl = text.indexOf('\n', i);
			if (nl === -1) return -1;
			i = nl + 1;
			continue;
		}
		if (ch === 36 /* '$' */) {
			const double = text.charCodeAt(i + 1) === 36;
			if (wantDouble) return double ? i : -1;
			// Single-dollar inline: a `$$` here would be the start of a new
			// display segment, not a close — but inside an inline `$…$` that
			// can't happen with well-formed input, so close on the first `$`.
			return i;
		}
		i += 1;
	}
	return -1;
}

/**
 * Mask Markdown code so a `$` (or `\(`, `\[`, …) inside it is never read
 * as a math delimiter. Returns a **same-length** copy (offsets and line
 * structure preserved) with the characters of code spans/blocks replaced
 * by spaces; newlines are kept.
 *
 * Markdown-like modes (Markdown, and later HTML/PHP) embed math in prose
 * where a backtick code span — `` `$x$` `` — or a fenced block is *not*
 * math; without this, the delimiter scanner mis-reads those `$` as math,
 * which (e.g. for a `$$…$$` wedged in a heading's backticks) corrupts the
 * preview. LaTeX mode does not use this — backticks aren't code in a
 * `.tex` file.
 *
 * Covers fenced code blocks (```` ``` ````/`~~~`, the closing fence being
 * the same character and at least as long as the opener) and inline code
 * spans (matched backtick runs of equal length). Indented (4-space) code
 * blocks are a known gap. Because masking is length-preserving and math
 * is only ever found in the surviving (non-code) regions, segment offsets
 * and bodies map back to the original text unchanged.
 *
 * @param {string} text
 * @returns {string}
 */
export function maskMarkdownCode(text) {
	if (typeof text !== 'string' || text.length === 0) return text;
	const lines = text.split('\n');
	const out = [];
	let fenceLen = 0; // >0 while inside a fence; the opener's run length
	let fenceChar = '';
	for (const line of lines) {
		const fence = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fenceLen > 0) {
			out.push(' '.repeat(line.length));
			if (fence && fence[1][0] === fenceChar && fence[1].length >= fenceLen) {
				fenceLen = 0;
			}
			continue;
		}
		if (fence) {
			out.push(' '.repeat(line.length));
			fenceLen = fence[1].length;
			fenceChar = fence[1][0];
			continue;
		}
		out.push(maskInlineCode(line));
	}
	return out.join('\n');
}

/**
 * Replace inline code spans (backtick runs of equal length) in one line
 * with spaces, preserving length. An unclosed run is left as-is.
 *
 * @param {string} line
 * @returns {string}
 */
function maskInlineCode(line) {
	let out = '';
	let i = 0;
	while (i < line.length) {
		if (line[i] !== '`') {
			out += line[i];
			i += 1;
			continue;
		}
		let n = 0;
		while (line[i + n] === '`') n += 1;
		// Find a closing run of exactly n backticks.
		let j = i + n;
		let closed = -1;
		while (j < line.length) {
			if (line[j] === '`') {
				let k = 0;
				while (line[j + k] === '`') k += 1;
				if (k === n) {
					closed = j;
					break;
				}
				j += k;
			} else {
				j += 1;
			}
		}
		if (closed !== -1) {
			const end = closed + n;
			out += ' '.repeat(end - i);
			i = end;
		} else {
			out += line.slice(i, i + n);
			i += n;
		}
	}
	return out;
}
