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
 * @file JMarkdown dialect scanner — a pure, DOM-free scan of one
 * document producing `{captures, regions, folds, injections,
 * constructs}`.
 *
 * Ported from the jmacs project (`packages/renderer/src/jmarkdown-scan.js`,
 * GPL-3.0-or-later, same author), itself a tested port of the
 * `JMarkdown.sublime-syntax` state machine — covering what that file
 * highlights over stock Markdown:
 *
 *   - the metadata header (bold keys; `Extension N:` value specs;
 *     `Custom element:` names; indented HTML bodies → html injection)
 *   - block directives `:::name` … `:::` (3–8 colons, nesting by
 *     count), with `:::TiKZ` bodies → latex and `:::mermaid` bodies →
 *     the Mermaid scanner; all foldable per colon level
 *   - `@begin(name)`…`@end(name)` environments, with TeX/equation/
 *     align/… bodies → latex and mermaid bodies → the Mermaid scanner;
 *     foldable on a name-agnostic stack
 *   - inline directives `:name[content]{.class #id attr="v"}`
 *   - `@name[text]{attrs}` directives (inline) and `@name+[text]{attrs}`
 *     (block), with an optional `<name>` angle form
 *   - `{{mustache}}` variables, `==highlight==` spans, `/italic/`
 *     spans (with `\/` escapes and the mid-word-slash abort)
 *   - embedded JavaScript chains `ident(...).prop(...)`
 *   - `<script>` / `<style>` blocks and block-level HTML runs
 *   - `\cite{…}` family commands and inline footnotes — `[^label: …]`,
 *     `[fn: …]`, either with a `(group)` — opener, body and closer,
 *     the body free to span paragraphs as the engine allows
 *
 * Changes in the Clew port (vs jmacs):
 *
 *   - There is no tree-sitter here, so `injections` are inert data:
 *     `{start, end, language}` spans that overlay.js paints uniformly
 *     as `jmd-embedded` (the `wrapPrefix`/`wrapSuffix` fields survive
 *     as documentation of what jmacs did with them, nothing more).
 *   - `[[file]]` inclusion lines are gone: Clew's engine treats every
 *     `[[…]]` as an Obsidian wikilink (see `src/engine/wikilinks.js`),
 *     so a new inline wikilink pass handles `[[Target]]`,
 *     `[[Target|alias]]`, `[[Target#Heading]]` and `![[…]]` embeds.
 *   - A new `#tag` pass (Obsidian tags, nested `#a/b`, hyphens and
 *     underscores; never inside code/math or a heading's leading #s).
 *   - Math segments get a `jmd-math` capture of their own (jmacs hands
 *     math to a MathJax preview; Clew styles the source span instead).
 *   - `constructs`: the same passes that paint also RECORD what they
 *     matched, structurally — kind, extent, delimiters, parts — for live
 *     edit (`editor/live/model.js`), which must know where a construct's
 *     delimiters are to conceal them. Emitted beside the captures, never
 *     instead of them, so the two cannot disagree about a position.
 *
 * (Alignment `>> … <<` and description lists are deliberately *not*
 * scanned — Sublime renders those through stock Markdown, and so does
 * the CodeMirror markdown base language here. Likewise `*bold*`,
 * `**intense**` and `__underline__` are left to the base grammar's
 * emphasis nodes, which the editor theme restyles.)
 *
 * The scan works on a masked copy of the text: fenced code, inline
 * code spans, and math segments are blanked first, and each pass
 * blanks or claims what it consumes so later passes cannot match
 * inside it. Length is always preserved, so every offset refers to
 * the original text.
 *
 * Pure and DOM-free; imports nothing from CodeMirror, so the tests run
 * under plain node. overlay.js memoises the result per document.
 */

import {
	scanMathSegments,
	maskMarkdownCode,
	MARKDOWN_MATH_CONFIG,
} from './math-segments.js';
import { scanMermaid } from './mermaid-scan.js';

/** @typedef {{ start: number, end: number, face: string }} CaptureRange */

/**
 * @typedef {object} JmarkdownScan
 * @property {CaptureRange[]} captures - Dialect captures to paint.
 * @property {{ start: number, end: number }[]} regions - Spans the
 *   dialect owns; grammar/injected captures are clipped out of them.
 * @property {{ start: number, end: number }[]} folds - Foldable spans
 *   (directive blocks, `@begin/@end` environments).
 * @property {{ start: number, end: number, language: string,
 *   wrapPrefix?: string, wrapSuffix?: string }[]} injections -
 *   Embedded-language spans (latex, javascript, html, css, …). In
 *   jmacs these were tree-sitter injections; in Clew they are inert
 *   data that overlay.js paints uniformly (see overlay.js). The
 *   `wrapPrefix`/`wrapSuffix` fields are kept for test parity only.
 * @property {Construct[]} constructs - What the passes matched, in
 *   document order (outer before inner).
 */

/**
 * One dialect construct. Every offset is absolute; every part is a
 * `{start, end}` range (or null when absent). `open`/`close` are the
 * delimiter runs a live view hides — `close` is null when the construct
 * is unclosed (still being typed, or a block running to end of file).
 *
 * Kind-specific parts:
 *
 *   math             display (bool), env (name|null), body
 *   metaHeader       body (open null for a fence-less legacy header)
 *   directiveBlock   name|null, content, attrs, colons, body
 *   environment      name, content, attrs, body
 *   directiveInline  name|null, content, attrs, block (`::x` vs `:x`)
 *   directiveAt      name, content, attrs, block (`@x+[…]`)
 *   mustache         name
 *   highlight        body
 *   italic           body
 *   cite             command (without the backslash), notes[], keys[]
 *   footnote         label|null, group|null, body|null, multiline
 *   wikilink/embed   target, heading, blockId, alias, aliasText (string)
 *   tag              name (without the `#`)
 *   htmlBlock / scriptBlock / styleBlock   (none)
 *
 * `content`/`attrs` are the INTERIORS of the `[…]`/`{…}` groups.
 * A block's `body` runs from the line after its opener to the newline
 * before its closer (empty when they are adjacent).
 *
 * @typedef {{ kind: string, start: number, end: number,
 *   open: {start: number, end: number}|null,
 *   close: {start: number, end: number}|null }} Construct
 */

/** LaTeX-bodied `@begin(…)` environment names (the Sublime list). */
const LATEX_ENVIRONMENTS =
	/^(?:TeX|equation\*?|align\*?|gather\*?|multline\*?|tikzpicture|TiKZ|tikz)$/;

/** Block-level HTML tag names (CommonMark's type-6 list plus the media
 *  and embedded-content elements), case-insensitive. A line opening one
 *  of these — or any dashed custom element — starts an HTML block. */
const HTML_BLOCK_TAGS = new RegExp(
	'^(?:address|article|aside|audio|blockquote|body|canvas|caption|center|col|' +
	'colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|' +
	'form|frame|frameset|h[1-6]|head|header|hr|html|iframe|img|legend|li|link|' +
	'main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|picture|pre|' +
	'section|source|summary|svg|table|tbody|td|template|tfoot|th|thead|title|' +
	'tr|track|ul|video)$',
	'i'
);

/**
 * Scan a JMarkdown document.
 *
 * @param {string} text
 * @returns {JmarkdownScan}
 */
export function scanJmarkdown(text) {
	/** @type {JmarkdownScan} */
	const out = { captures: [], regions: [], folds: [], injections: [], constructs: [] };
	if (typeof text !== 'string' || text.length === 0) return out;

	// The masked working copy: code first (fences + inline spans), then
	// math segments — both length-preserving, so offsets into the copy
	// are offsets into the original.
	const buf = maskMarkdownCode(text).split('');
	for (const seg of scanMathSegments(buf.join(''), MARKDOWN_MATH_CONFIG)) {
		// Clew: face the whole segment (delimiters included) — the base
		// markdown grammar knows nothing about `$…$`, so this is the one
		// place math source gets a style of its own.
		out.captures.push({ start: seg.start, end: seg.end, face: 'jmd-math' });
		out.constructs.push(mathConstruct(text, seg));
		blank(buf, seg.start, seg.end);
	}

	const lineStarts = computeLineStarts(text);
	const ctx = {
		text,
		buf,
		lineStarts,
		lineCount: lineStarts.length,
		out,
		/** Spans already claimed by an inline construct. @type {{s:number,e:number}[]} */
		claimed: [],
	};

	const afterHeader = scanHeader(ctx);
	scanBlocks(ctx, afterHeader);
	scanInlines(ctx);
	// Document order, an outer construct before the inner ones it holds.
	out.constructs.sort((a, b) => a.start - b.start || b.end - a.end);
	return out;
}

/**
 * The `math` construct for one segment: its delimiters recovered from
 * the text (`$`, `$$`, `\(`, `\[`, or a whole `\begin{env}` line run).
 * For an environment the segment body IS the `\begin…\end` source —
 * MathJax typesets the environment whole — so `body` spans it and
 * `open`/`close` are the `\begin{…}`/`\end{…}` commands inside it.
 *
 * @param {string} text
 * @param {import('./math-segments.js').MathSegment} seg
 * @returns {object}
 */
function mathConstruct(text, seg) {
	const display = seg.kind === 'block';
	const env = /^\\begin\{([^}]+)\}/.exec(text.slice(seg.start, seg.start + 40));
	if (env) {
		const closeLen = `\\end{${env[1]}}`.length;
		return {
			kind: 'math', start: seg.start, end: seg.end, display, env: env[1],
			open: { start: seg.start, end: seg.start + env[0].length },
			close: { start: seg.end - closeLen, end: seg.end },
			body: { start: seg.start, end: seg.end },
		};
	}
	const two = text.startsWith('$$', seg.start) || text[seg.start] === '\\';
	const len = two ? 2 : 1;
	return {
		kind: 'math', start: seg.start, end: seg.end, display, env: null,
		open: { start: seg.start, end: seg.start + len },
		close: { start: seg.end - len, end: seg.end },
		body: { start: seg.start + len, end: seg.end - len },
	};
}

/**
 * The body range of a block construct whose opener is line `k` and
 * whose closer is line `c` (`c === lineCount` when unclosed): from the
 * start of the line after the opener to the newline before the closer.
 * Empty (start === end) when nothing lies between them.
 */
function bodyBetween(ctx, k, c) {
	const start = k + 1 < ctx.lineCount ? ctx.lineStarts[k + 1] : ctx.text.length;
	const end = c < ctx.lineCount ? ctx.lineStarts[c] - 1 : ctx.text.length;
	return { start, end: Math.max(start, end) };
}

/* ── small shared helpers ────────────────────────────────────────────── */

/** Blank `[start, end)` in the char buffer, preserving newlines. */
function blank(buf, start, end) {
	for (let i = start; i < end; i += 1) {
		if (buf[i] !== '\n') buf[i] = ' ';
	}
}

/** Offsets of every line's first character. */
function computeLineStarts(text) {
	const starts = [0];
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) === 10) starts.push(i + 1);
	}
	return starts;
}

/** The line's content (from the masked buffer), without its newline. */
function lineAt(ctx, i) {
	return ctx.buf.slice(ctx.lineStarts[i], lineEnd(ctx, i)).join('');
}

/** Offset one past the line's last character (its newline's offset). */
function lineEnd(ctx, i) {
	return i + 1 < ctx.lineCount
		? ctx.lineStarts[i + 1] - 1
		: ctx.text.length;
}

/** Push a capture. */
function cap(ctx, start, end, face) {
	if (end > start) ctx.out.captures.push({ start, end, face });
}

/** Push an owned region, merging with the previous one when adjacent. */
function region(ctx, start, end) {
	if (end <= start) return;
	const last = ctx.out.regions[ctx.out.regions.length - 1];
	if (last && start <= last.end + 1 && start >= last.start) {
		if (end > last.end) last.end = end;
		return;
	}
	ctx.out.regions.push({ start, end });
}

/** Consume a whole line: own it, and blank it in the working copy. */
function consumeLine(ctx, i) {
	region(ctx, ctx.lineStarts[i], lineEnd(ctx, i));
	blank(ctx.buf, ctx.lineStarts[i], lineEnd(ctx, i));
}

/** Record a construct (see `constructs` on JmarkdownScan). */
function construct(ctx, kind, start, end, parts) {
	ctx.out.constructs.push({ kind, start, end, open: null, close: null, ...parts });
}

/** A `{start, end}` range, or null when empty. */
function span(start, end) {
	return end > start ? { start, end } : null;
}

/** Mark an inline span as claimed so later matchers skip it. */
function claim(ctx, s, e) {
	ctx.claimed.push({ s, e });
}

/** Is the offset inside a claimed span? */
function isClaimed(ctx, pos) {
	return ctx.claimed.some((c) => c.s <= pos && pos < c.e);
}

/* ── the metadata header ─────────────────────────────────────────────── */

/**
 * Scan the metadata header, when the document opens with one: a
 * `---` fence, or (legacy) a first line shaped like `Key: value` —
 * detected with the processor's own key pattern, `[-A-Za-z0-9 ]+:`,
 * which is stricter than Sublime's lookahead (a `# Heading: x` first
 * line is not a header).
 *
 * @param {object} ctx
 * @returns {number} The line index after the header (0 = no header).
 */
function scanHeader(ctx) {
	if (ctx.lineCount === 0) return 0;
	let i = 0;
	const first = lineAt(ctx, 0);
	const header = {
		kind: 'metaHeader', start: 0, end: ctx.text.length,
		open: null, close: null, body: null,
	};
	ctx.out.constructs.push(header);
	if (/^-{3,}$/.test(first)) {
		header.open = { start: 0, end: lineEnd(ctx, 0) };
		cap(ctx, ctx.lineStarts[0], lineEnd(ctx, 0), 'jmd-meta-fence');
		consumeLine(ctx, 0);
		i = 1;
	} else if (/^[-A-Za-z0-9 ]+:/.test(first) && legacyHeaderTerminated(ctx)) {
		i = 0;
	} else {
		ctx.out.constructs.pop();
		return 0;
	}

	while (i < ctx.lineCount) {
		const ls = ctx.lineStarts[i];
		const line = lineAt(ctx, i);
		let m;

		if (/^-{3,}$/.test(line)) {
			cap(ctx, ls, lineEnd(ctx, i), 'jmd-meta-fence');
			consumeLine(ctx, i);
			header.close = { start: ls, end: lineEnd(ctx, i) };
			header.end = lineEnd(ctx, i);
			header.body = bodyBetween(ctx, header.open ? 0 : -1, i);
			return i + 1;
		}

		if ((m = /^(Custom element):\s*(\S.*)?$/.exec(line))) {
			cap(ctx, ls, ls + m[1].length, 'jmd-meta-key');
			if (m[2]) {
				const at = line.lastIndexOf(m[2]);
				cap(ctx, ls + at, ls + at + m[2].length, 'jmd-meta-element');
			}
			consumeLine(ctx, i);
			i = headerBody(ctx, i + 1);
			continue;
		}

		if ((m = /^(Extension[ \t]+\S[^:]*):(.*)$/.exec(line))) {
			cap(ctx, ls, ls + m[1].length, 'jmd-meta-key');
			extensionValue(ctx, m[2], ls + m[1].length + 1);
			consumeLine(ctx, i);
			i = headerBody(ctx, i + 1);
			continue;
		}

		if ((m = /^(\S[^:]*):/.exec(line))) {
			cap(ctx, ls, ls + m[1].length, 'jmd-meta-key');
		}
		// Continuation/blank lines carry no captures but are still owned.
		consumeLine(ctx, i);
		i += 1;
	}
	// No closing fence: like Sublime, the header runs to end of file.
	header.body = bodyBetween(ctx, header.open ? 0 : -1, ctx.lineCount);
	return ctx.lineCount;
}

/**
 * A fence-less (legacy) header is accepted only when its terminating
 * `---` line arrives before the first blank line. Sublime's lookahead
 * (`^(?=\S[^:]*:)`) treats *any* colon-bearing first line as a header
 * — "See :ref[x] for…" would swallow the whole document — which is far
 * too eager for an editor. Real legacy headers are a contiguous block
 * of key lines closed by `---`, which is exactly what this checks.
 *
 * @param {object} ctx
 * @returns {boolean}
 */
function legacyHeaderTerminated(ctx) {
	for (let i = 1; i < ctx.lineCount; i += 1) {
		const line = lineAt(ctx, i);
		if (/^-{3,}$/.test(line)) return true;
		if (/^[ \t]*$/.test(line)) return false;
	}
	return false;
}

/**
 * The `Extension N:` value line — either two `/regex/` tokens or two
 * bare delimiter tokens, then the parse-flags boolean (or list) and
 * the argument count.
 *
 * @param {object} ctx
 * @param {string} rest - The text after the colon.
 * @param {number} base - Absolute offset of `rest[0]`.
 */
function extensionValue(ctx, rest, base) {
	const BOOLS = '(\\[(?:true|false)(?:\\s*,\\s*(?:true|false))*\\]|true|false)';
	let m = new RegExp(
		`^\\s*(\\/\\S+\\/)\\s+(\\/\\S+\\/)\\s+${BOOLS}\\s+(\\d+)\\s*$`
	).exec(rest);
	let faces = ['jmd-meta-regex', 'jmd-meta-regex'];
	if (!m) {
		m = new RegExp(`^\\s*(\\S+)\\s+(\\S+)\\s+${BOOLS}\\s+(\\d+)\\s*$`).exec(
			rest
		);
		faces = ['jmd-meta-delim', 'jmd-meta-delim'];
	}
	if (!m) return;
	let at = 0;
	const groups = [m[1], m[2], m[3], m[4]];
	const groupFaces = [...faces, 'jmd-meta-bool', 'jmd-meta-number'];
	for (let g = 0; g < groups.length; g += 1) {
		at = rest.indexOf(groups[g], at);
		cap(ctx, base + at, base + at + groups[g].length, groupFaces[g]);
		at += groups[g].length;
	}
}

/**
 * The indented HTML body under an `Extension`/`Custom element` key:
 * lines until the next non-indented line or the closing fence. The
 * body is injected into the html grammar (Sublime includes
 * `text.html.basic`) and blanked, but *not* owned — the injection's
 * captures must survive.
 *
 * @param {object} ctx
 * @param {number} from - First candidate body line.
 * @returns {number} The line index after the body.
 */
function headerBody(ctx, from) {
	let j = from;
	while (
		j < ctx.lineCount &&
		!/^\S/.test(lineAt(ctx, j)) &&
		!/^-{3,}$/.test(lineAt(ctx, j))
	) {
		j += 1;
	}
	if (j > from) {
		const start = ctx.lineStarts[from];
		const end = lineEnd(ctx, j - 1);
		if (ctx.text.slice(start, end).trim() !== '') {
			ctx.out.injections.push({ start, end, language: 'html' });
		}
		blank(ctx.buf, start, end);
	}
	return j;
}

/* ── block constructs ────────────────────────────────────────────────── */

/**
 * Scan block directives, `@begin/@end` environments, and `<script>` /
 * `<style>` / block-HTML runs, maintaining the two nesting stacks.
 * Consumed lines are blanked so the inline pass skips them.
 *
 * @param {object} ctx
 * @param {number} from - First line after the header.
 */
function scanBlocks(ctx, from) {
	/** @type {{ colons: number, start: number, construct: object, line: number }[]} */
	const dirStack = [];
	/** @type {{ start: number, construct: object, line: number }[]} */
	const envStack = [];
	let k = from;

	while (k < ctx.lineCount) {
		const ls = ctx.lineStarts[k];
		const line = lineAt(ctx, k);
		let m;

		// --- :::TiKZ / :::mermaid (exactly three colons, like Sublime) ---
		if ((m = /^(:::)(?!:)(TiKZ|tikz|mermaid)\b/.exec(line))) {
			k = verbatimDirective(ctx, k, m[2] === 'mermaid' ? 'mermaid' : 'latex', m);
			continue;
		}

		// --- generic block directives, openers and closers ---
		if ((m = /^(:{3,})([A-Za-z][A-Za-z0-9-]*)?/.exec(line))) {
			const colons = m[1].length;
			const top = dirStack[dirStack.length - 1];
			if (!m[2] && /^:{3,}\s*$/.test(line) && top && top.colons === colons) {
				cap(ctx, ls, ls + colons, 'jmd-directive-punct');
				ctx.out.folds.push({ start: top.start, end: lineEnd(ctx, k) });
				closeBlock(ctx, top.construct, top.line, k, { start: ls, end: ls + colons });
				dirStack.pop();
			} else {
				cap(ctx, ls, ls + colons, 'jmd-directive-punct');
				if (m[2]) {
					cap(ctx, ls + colons, ls + m[0].length, 'jmd-directive-name');
				}
				const parts = {};
				afterName(ctx, line, m[0].length, ls, parts);
				const construct = directiveBlock(ctx, k, colons, m, parts);
				dirStack.push({ colons, start: ls, construct, line: k });
			}
			consumeLine(ctx, k);
			k += 1;
			continue;
		}

		// --- @begin(…) environments ---
		if ((m = /^[ \t]*(@begin)(\()(\.|<)?([A-Za-z][\w-]*\*?)(>)?(\))/.exec(line))) {
			if (LATEX_ENVIRONMENTS.test(m[4]) && !m[3]) {
				k = verbatimEnvironment(ctx, k, 'latex', m);
				continue;
			}
			if (m[4] === 'mermaid' && !m[3]) {
				k = verbatimEnvironment(ctx, k, 'mermaid', m);
				continue;
			}
			const parts = {};
			const end = environmentZones(ctx, k, m, parts);
			const construct = environment(ctx, k, m, parts, end);
			envStack.push({ start: ls, construct, line: k });
			region(ctx, ls, end);
			blank(ctx.buf, ls, end);
			k += 1;
			continue;
		}

		// --- @end(…) ---
		if ((m = /^[ \t]*(@end)(\()([^)]*)(\))/.exec(line))) {
			const end = environmentZones(ctx, k, m);
			const open = envStack.pop();
			if (open !== undefined) {
				// A *block* fold: collapsing keeps both the `@begin(…)` and the
				// `@end(…)` lines visible, with a vertical ellipsis between them —
				// rather than swallowing the closing line (`@end(…)` is not a
				// structural close the line-based preview would re-show). See
				// folding.js / view.js.
				ctx.out.folds.push({ start: open.start, end: lineEnd(ctx, k), block: true });
				closeBlock(ctx, open.construct, open.line, k, {
					start: ls + m[0].indexOf('@'), end,
				});
			}
			region(ctx, ls, end);
			blank(ctx.buf, ls, end);
			k += 1;
			continue;
		}

		// --- <script> blocks → the html grammar ---
		if (/^\s*<script\b/.test(line)) {
			let c = k;
			while (c < ctx.lineCount && !/<\/script>/.test(lineAt(ctx, c))) c += 1;
			const last = Math.min(c, ctx.lineCount - 1);
			ctx.out.injections.push({
				start: ls,
				end: lineEnd(ctx, last),
				language: 'html',
			});
			htmlConstruct(ctx, 'scriptBlock', ls, lineEnd(ctx, last));
			blank(ctx.buf, ls, lineEnd(ctx, last));
			k = last + 1;
			continue;
		}

		// --- <style> blocks → the html grammar (css nests via html.js) ---
		// Raw-text semantics like <script>: the block runs to the closing
		// tag regardless of blank lines. tree-sitter-html injects the body
		// into css, so the sheet highlights properly — and blanking stops
		// the inline pass reading `div.center` as an expression chain.
		if (/^\s{0,3}<style\b/.test(line)) {
			let c = k;
			while (c < ctx.lineCount && !/<\/style>/.test(lineAt(ctx, c))) c += 1;
			const last = Math.min(c, ctx.lineCount - 1);
			ctx.out.injections.push({
				start: ls,
				end: lineEnd(ctx, last),
				language: 'html',
			});
			htmlConstruct(ctx, 'styleBlock', ls, lineEnd(ctx, last));
			blank(ctx.buf, ls, lineEnd(ctx, last));
			k = last + 1;
			continue;
		}

		// --- block-level HTML → the html grammar --------------------------
		// A line opening (or closing) a KNOWN block-level tag — or a custom
		// element (any dashed name, e.g. <dissertation-feedback>) — at up to
		// three spaces of indent starts an HTML block, CommonMark-style: it
		// runs to the first blank line. The whole run is injected into the
		// html grammar and blanked. Inline HTML *within* a prose paragraph
		// is deliberately not consumed here — the inline grammar injects
		// each html_tag on its own (see languages/jmarkdown-inline.js).
		if ((m = /^\s{0,3}<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/.exec(line)) &&
				(HTML_BLOCK_TAGS.test(m[1]) || m[1].includes('-'))) {
			let c = k;
			while (c + 1 < ctx.lineCount && lineAt(ctx, c + 1).trim() !== '') c += 1;
			ctx.out.injections.push({
				start: ls,
				end: lineEnd(ctx, c),
				language: 'html',
			});
			htmlConstruct(ctx, 'htmlBlock', ls, lineEnd(ctx, c));
			blank(ctx.buf, ls, lineEnd(ctx, c));
			k = c + 1;
			continue;
		}

		// (jmacs handled `[[file]]` inclusion lines here; in Clew every
		// `[[…]]` is an Obsidian wikilink, matched by the inline pass.)

		k += 1;
	}
}

/**
 * Open a `directiveBlock` construct on line `k` — closed later by
 * `closeBlock`, or left running to end of file (`close: null`), which is
 * what the scanner's colouring does with an unclosed opener too.
 *
 * @param {object} ctx
 * @param {number} k - The opener's line index.
 * @param {number} colons - The fence's colon count (nesting level).
 * @param {RegExpExecArray} m - The opener match (m[2] = the name).
 * @param {{content: object|null, attrs: object|null}} parts - From afterName.
 * @returns {object}
 */
function directiveBlock(ctx, k, colons, m, parts) {
	const ls = ctx.lineStarts[k];
	const construct = {
		kind: 'directiveBlock', start: ls, end: ctx.text.length,
		open: { start: ls, end: ls + colons }, close: null,
		name: m[2] ? { start: ls + colons, end: ls + m[0].length } : null,
		content: parts.content, attrs: parts.attrs, colons,
		body: bodyBetween(ctx, k, ctx.lineCount),
	};
	ctx.out.constructs.push(construct);
	return construct;
}

/**
 * Open an `environment` construct (`@begin(name)` on line `k`).
 *
 * @param {object} ctx
 * @param {number} k
 * @param {RegExpExecArray} m - The begin match (m[4] = the name).
 * @param {{content: object|null, attrs: object|null}} parts - From afterName.
 * @param {number} openEnd - One past the opener's tail.
 * @returns {object}
 */
function environment(ctx, k, m, parts, openEnd) {
	const ls = ctx.lineStarts[k];
	const at = ls + m[0].indexOf('@');
	const nameAt = ls + m[0].indexOf('(') + 1 + (m[3] ? 1 : 0);
	const construct = {
		kind: 'environment', start: ls, end: ctx.text.length,
		open: { start: at, end: openEnd }, close: null,
		name: { start: nameAt, end: nameAt + m[4].length },
		content: parts.content, attrs: parts.attrs,
		body: bodyBetween(ctx, k, ctx.lineCount),
	};
	ctx.out.constructs.push(construct);
	return construct;
}

/** Close a block construct opened on line `k` at closer line `c`. */
function closeBlock(ctx, construct, k, c, close) {
	construct.close = close;
	construct.end = lineEnd(ctx, c);
	construct.body = bodyBetween(ctx, k, c);
}

/** An HTML / `<script>` / `<style>` block construct. */
function htmlConstruct(ctx, kind, start, end) {
	ctx.out.constructs.push({ kind, start, end, open: null, close: null });
}

/**
 * A `:::TiKZ` / `:::mermaid` directive: opener zones, a verbatim body
 * (latex injection or the Mermaid scanner), the `:::` closer, and a
 * fold. An unclosed body runs to end of file, exactly like the Sublime
 * context.
 *
 * @param {object} ctx
 * @param {number} k - The opener's line index.
 * @param {'latex'|'mermaid'} kind
 * @param {RegExpExecArray} m - The opener match.
 * @returns {number} The next line index to scan.
 */
function verbatimDirective(ctx, k, kind, m) {
	const ls = ctx.lineStarts[k];
	cap(ctx, ls, ls + 3, 'jmd-directive-punct');
	cap(ctx, ls + 3, ls + m[0].length, 'jmd-directive-name');
	const parts = {};
	afterName(ctx, lineAt(ctx, k), m[0].length, ls, parts);
	const construct = directiveBlock(ctx, k, 3, m, parts);
	consumeLine(ctx, k);

	let c = k + 1;
	while (c < ctx.lineCount && !/^:::\s*$/.test(lineAt(ctx, c))) c += 1;
	verbatimBody(ctx, k, c, kind);
	if (c < ctx.lineCount) {
		cap(ctx, ctx.lineStarts[c], ctx.lineStarts[c] + 3, 'jmd-directive-punct');
		ctx.out.folds.push({ start: ls, end: lineEnd(ctx, c) });
		closeBlock(ctx, construct, k, c, {
			start: ctx.lineStarts[c], end: ctx.lineStarts[c] + 3,
		});
		consumeLine(ctx, c);
	}
	return c + 1;
}

/**
 * A `@begin(TeX|…|mermaid)` environment: opener/closer zones, the
 * verbatim body, and a fold.
 *
 * @param {object} ctx
 * @param {number} k - The opener's line index.
 * @param {'latex'|'mermaid'} kind
 * @param {RegExpExecArray} m - The opener match.
 * @returns {number} The next line index to scan.
 */
function verbatimEnvironment(ctx, k, kind, m) {
	const ls = ctx.lineStarts[k];
	const parts = {};
	const openEnd = environmentZones(ctx, k, m, parts);
	const construct = environment(ctx, k, m, parts, openEnd);
	consumeLine(ctx, k);

	let c = k + 1;
	while (c < ctx.lineCount && !/^[ \t]*@end\(/.test(lineAt(ctx, c))) c += 1;
	verbatimBody(ctx, k, c, kind);
	if (c < ctx.lineCount) {
		const em = /^[ \t]*(@end)(\()([^)]*)(\))/.exec(lineAt(ctx, c));
		const cs = ctx.lineStarts[c];
		const closeEnd = em ? environmentZones(ctx, c, em) : lineEnd(ctx, c);
		ctx.out.folds.push({ start: ls, end: lineEnd(ctx, c) });
		closeBlock(ctx, construct, k, c, {
			start: cs + lineAt(ctx, c).indexOf('@'), end: closeEnd,
		});
		consumeLine(ctx, c);
	}
	return c + 1;
}

/**
 * The body between opener line `k` and closer line `c` (exclusive):
 * latex bodies become injections; mermaid bodies get scanned captures
 * plus an owned region (no grammar bleed-through). Both are blanked.
 *
 * @param {object} ctx
 * @param {number} k - Opener line index.
 * @param {number} c - Closer line index (may be `lineCount`).
 * @param {'latex'|'mermaid'} kind
 */
function verbatimBody(ctx, k, c, kind) {
	if (c <= k + 1) return;
	const start = ctx.lineStarts[k + 1];
	const end = c < ctx.lineCount ? ctx.lineStarts[c] - 1 : ctx.text.length;
	if (end <= start) return;
	if (kind === 'latex') {
		ctx.out.injections.push({ start, end, language: 'latex' });
	} else {
		region(ctx, start, end);
		ctx.out.captures.push(...scanMermaid(ctx.text.slice(start, end), start));
	}
	blank(ctx.buf, start, end);
}

/**
 * Capture the colour zones of one `@begin(name)` / `@end(name)` line —
 * the keyword, the parens (and `.`/`<`/`>` name sigils), the name —
 * then any `[label]{attrs}` tail.
 *
 * @param {object} ctx
 * @param {number} k - The line index.
 * @param {RegExpExecArray} m - A begin/end match for that line.
 * @param {object} [parts] - Passed through to afterName.
 * @returns {number} Absolute offset one past the construct (after any
 *   `[label]{attrs}` tail).
 */
function environmentZones(ctx, k, m, parts) {
	const ls = ctx.lineStarts[k];
	let at = ls + m[0].indexOf(m[1]);
	cap(ctx, at, at + m[1].length, 'jmd-env-keyword');
	at += m[1].length;
	cap(ctx, at, at + 1, 'jmd-env-paren'); // (
	at += 1;
	// Optional sigil, the name, optional closing sigil — group layout
	// differs between the begin and end regexes, so re-parse the span.
	const inner = /^(\.|<)?([A-Za-z][\w-]*\*?)?(>)?/.exec(
		ctx.text.slice(at, ls + m[0].length - 1)
	);
	if (inner) {
		if (inner[1]) cap(ctx, at, at + 1, 'jmd-env-paren');
		if (inner[2]) {
			const s = at + (inner[1] ? 1 : 0);
			cap(ctx, s, s + inner[2].length, 'jmd-env-name');
		}
		if (inner[3]) {
			const s = at + inner[0].length - 1;
			cap(ctx, s, s + 1, 'jmd-env-paren');
		}
	}
	const close = ls + m[0].length - 1;
	cap(ctx, close, close + 1, 'jmd-env-paren'); // )
	return afterName(ctx, lineAt(ctx, k), m[0].length, ls, parts);
}

/* ── the directive tail: [content]{.class #id attr="val"} ────────────── */

/**
 * Parse a directive's optional `[content]` and `{attributes}` tail on
 * one line, emitting captures. Mirrors Sublime's `directive-after-name`
 * chain (single-line; an unclosed bracket runs to end of line, the
 * Sublime context's bail-at-blank-line collapsed to one line).
 *
 * @param {object} ctx
 * @param {string} line - The line's text.
 * @param {number} col - Column where the tail may start.
 * @param {number} base - Absolute offset of `line[0]`.
 * @param {object} [parts] - When given, receives `content` and `attrs`:
 *   the absolute `{start, end}` interiors of the `[…]` and `{…}` groups
 *   (delimiters excluded), or null for a group that is absent. An
 *   unclosed `[` reports its interior to end of line.
 * @returns {number} Absolute offset one past the tail.
 */
function afterName(ctx, line, col, base, parts = {}) {
	let i = col;
	parts.content = null;
	parts.attrs = null;
	if (line[i] === '[') {
		cap(ctx, base + i, base + i + 1, 'jmd-punct');
		let depth = 1;
		let j = i + 1;
		while (j < line.length && depth > 0) {
			if (line[j] === '[') depth += 1;
			else if (line[j] === ']') depth -= 1;
			j += 1;
		}
		if (depth === 0) {
			cap(ctx, base + i + 1, base + j - 1, 'jmd-directive-bracket');
			cap(ctx, base + j - 1, base + j, 'jmd-punct');
			parts.content = { start: base + i + 1, end: base + j - 1 };
			i = j;
		} else {
			cap(ctx, base + i + 1, base + line.length, 'jmd-directive-bracket');
			parts.content = { start: base + i + 1, end: base + line.length };
			return base + line.length;
		}
	}
	if (line[i] === '{') {
		cap(ctx, base + i, base + i + 1, 'jmd-punct');
		let j = i + 1;
		while (j < line.length && line[j] !== '}') {
			const rest = line.slice(j);
			let m;
			if ((m = /^\.([-\w]+)/.exec(rest))) {
				cap(ctx, base + j, base + j + 1, 'jmd-punct');
				cap(ctx, base + j + 1, base + j + m[0].length, 'jmd-attr-class');
				j += m[0].length;
			} else if ((m = /^#([-\w]+)/.exec(rest))) {
				cap(ctx, base + j, base + j + 1, 'jmd-punct');
				cap(ctx, base + j + 1, base + j + m[0].length, 'jmd-attr-id');
				j += m[0].length;
			} else if ((m = /^([-\w]+)(=)(["'])/.exec(rest))) {
				cap(ctx, base + j, base + j + m[1].length, 'jmd-attr-name');
				cap(ctx, base + j + m[1].length, base + j + m[1].length + 1, 'jmd-punct');
				const quote = m[3];
				let q = j + m[0].length;
				while (q < line.length && line[q] !== quote) {
					q += line[q] === '\\' ? 2 : 1;
				}
				q = Math.min(q + 1, line.length);
				cap(ctx, base + j + m[1].length + 1, base + q, 'jmd-string');
				j = q;
			} else if ((m = /^[-\w]+/.exec(rest))) {
				cap(ctx, base + j, base + j + m[0].length, 'jmd-attr-name');
				j += m[0].length;
			} else {
				j += 1;
			}
		}
		parts.attrs = { start: base + i + 1, end: base + j };
		if (line[j] === '}') {
			cap(ctx, base + j, base + j + 1, 'jmd-punct');
			j += 1;
		}
		i = j;
	}
	return base + i;
}

/* ── inline constructs ───────────────────────────────────────────────── */

/**
 * Scan the inline constructs over the masked, block-consumed text, in
 * the Sublime `inlines` order: mustache, directives, JS chains,
 * highlight, italic — then the extras (citations, footnote openers)
 * and Clew's Obsidian passes (wikilinks, tags).
 *
 * @param {object} ctx
 */
function scanInlines(ctx) {
	const S = ctx.buf.join('');
	// `@name[…]{…}` directives stake out their sigils/brackets first so the
	// later passes still highlight the `[…]` text group (left ambient) while
	// skipping the sigils and the injected `{…}` attribute group.
	atDirectives(ctx, S);
	// Wikilinks claim early so `[[a/b|x.y]]` never reads as an italic
	// span or a JS chain; masking has already blanked code and math, so
	// a `[[…]]` inside a fence or `$…$` is invisible to the pass.
	wikilinks(ctx, S);
	mustaches(ctx, S);
	inlineDirectives(ctx, S);
	jsChains(ctx, S);
	highlights(ctx, S);
	italics(ctx, S);
	citations(ctx, S);
	footnotes(ctx, S);
	// Tags run last: every other construct that may legitimately contain
	// a '#' (wikilink headings, attribute lists, citations) has claimed
	// its span by now, so whatever '#word' is left really is a tag.
	tags(ctx, S);
}

/** `{{variable}}` */
function mustaches(ctx, S) {
	const re = /(\{\{)([^}\n]+)(\}\})/g;
	let m;
	while ((m = re.exec(S))) {
		if (isClaimed(ctx, m.index)) continue;
		cap(ctx, m.index, m.index + 2, 'jmd-punct');
		cap(ctx, m.index + 2, m.index + 2 + m[2].length, 'jmd-mustache');
		cap(ctx, m.index + 2 + m[2].length, m.index + m[0].length, 'jmd-punct');
		construct(ctx, 'mustache', m.index, m.index + m[0].length, {
			open: { start: m.index, end: m.index + 2 },
			close: { start: m.index + m[0].length - 2, end: m.index + m[0].length },
			name: { start: m.index + 2, end: m.index + 2 + m[2].length },
		});
		claim(ctx, m.index, m.index + m[0].length);
	}
}

/**
 * Inline directives — `:{2,}name` (name optional, like Sublime) and
 * single-colon `:name` (a letter required, so prose colons, times, and
 * URLs never match). The whole construct, brackets and attributes
 * included, is owned: the grammar reads `[content]` as a link.
 */
function inlineDirectives(ctx, S) {
	for (const re of [
		/(^|\s)(:{2,8})([A-Za-z][A-Za-z0-9-]*)?/g,
		/(^|\s)(:)([A-Za-z][A-Za-z0-9-]*)/g,
	]) {
		let m;
		while ((m = re.exec(S))) {
			const at = m.index + m[1].length;
			if (isClaimed(ctx, at)) continue;
			cap(ctx, at, at + m[2].length, 'jmd-directive-punct');
			let nameEnd = at + m[2].length;
			if (m[3]) {
				cap(ctx, nameEnd, nameEnd + m[3].length, 'jmd-directive-name');
				nameEnd += m[3].length;
			}
			// The tail parser is line-bound: hand it the rest of this line.
			const eol = S.indexOf('\n', nameEnd);
			const lineEndAt = eol === -1 ? S.length : eol;
			const lineStartAt = S.lastIndexOf('\n', at) + 1;
			const parts = {};
			const end = afterName(
				ctx,
				S.slice(lineStartAt, lineEndAt),
				nameEnd - lineStartAt,
				lineStartAt,
				parts
			);
			construct(ctx, 'directiveInline', at, end, {
				open: { start: at, end: nameEnd },
				name: m[3] ? { start: nameEnd - m[3].length, end: nameEnd } : null,
				content: parts.content, attrs: parts.attrs,
				block: m[2].length > 1,
			});
			region(ctx, at, end);
			claim(ctx, at, end);
			re.lastIndex = end;
		}
	}
}

/**
 * `@name[…]{…}` directives — JMarkdown's inline/block directive
 * extension. The opening is `@`, an optional `<`, a `[-A-Za-z0-9]+`
 * name, an optional matching `>` (a `<` obliges a `>`, and vice versa),
 * and — for a *block* directive — a trailing `+` outside the `>`. Then
 * an optional `[jmarkdown text]` group and an optional `{HTML attribute
 * list}` group; both are optional, and either may span lines but not a
 * blank line.
 *
 * The sigils (`@ < > +`) and the group delimiters (`[ ] { }`) are
 * painted and owned. The text group is *not* owned and *not* injected:
 * we are already in a JMarkdown context, so the surrounding
 * highlighting (the paragraph → `jmarkdown_inline` injection, plus the
 * later inline passes here — `==highlight==`, `/italic/`, `{{var}}`, …)
 * paints its interior. The attribute group is injected into the html
 * grammar, wrapped as `<x … />` so tree-sitter-html actually captures
 * the attributes (bare, tagless attributes are top-level text to it);
 * see `treesitter.js#spliceInjections`. The attribute interior is
 * claimed (not owned) so the injection survives the capture-provider
 * clip while the inline passes stay out of it.
 *
 * `@begin(…)` / `@end(…)` environments are consumed and blanked by the
 * block pass before this runs, so they never reach here; a bare `@begin`
 * with no `(` is just a directive named "begin".
 */
function atDirectives(ctx, S) {
	const re = /(^|\s)@(<)?([-A-Za-z0-9]+)(>)?(\+)?/g;
	let m;
	while ((m = re.exec(S))) {
		const at = m.index + m[1].length; // offset of '@'
		if (isClaimed(ctx, at)) continue;
		// Angle brackets come as a pair, or not at all.
		if (Boolean(m[2]) !== Boolean(m[4])) continue;

		// Paint the opening: '@', optional '<', name, optional '>', optional '+'.
		let p = at;
		cap(ctx, p, p + 1, 'jmd-directive-punct'); // @
		p += 1;
		if (m[2]) { cap(ctx, p, p + 1, 'jmd-directive-punct'); p += 1; } // <
		cap(ctx, p, p + m[3].length, 'jmd-directive-name'); // name
		p += m[3].length;
		if (m[4]) { cap(ctx, p, p + 1, 'jmd-directive-punct'); p += 1; } // >
		if (m[5]) { cap(ctx, p, p + 1, 'jmd-directive-punct'); p += 1; } // +
		const openEnd = p;
		region(ctx, at, openEnd);
		claim(ctx, at, openEnd);
		const nameAt = at + 1 + (m[2] ? 1 : 0);
		const directive = {
			open: { start: at, end: openEnd },
			name: { start: nameAt, end: nameAt + m[3].length },
			content: null, attrs: null, block: Boolean(m[5]),
		};

		// Optional [jmarkdown text] group: paint/own the brackets, then
		// inject the bracket-free interior into the inline grammar. Injecting
		// the bare slice (rather than leaving the whole `[…]` to the ambient
		// paragraph injection) renders it as clean JMarkdown — bold, emphasis,
		// real links, math — without the shortcut-link mis-parse that a
		// surrounding `[…]` would trigger. The interior is deliberately left
		// *unclaimed*, so the scanner's own inline passes (==highlight==,
		// /italic/, {{var}}, citations, footnotes) still paint over it too.
		if (S[p] === '[') {
			const rb = matchGroup(S, p, '[', ']', false);
			if (rb !== -1) {
				cap(ctx, p, p + 1, 'jmd-punct'); // [
				cap(ctx, rb, rb + 1, 'jmd-punct'); // ]
				region(ctx, p, p + 1);
				region(ctx, rb, rb + 1);
				claim(ctx, p, p + 1);
				claim(ctx, rb, rb + 1);
				if (rb > p + 1) {
					ctx.out.injections.push({
						start: p + 1,
						end: rb,
						language: 'jmarkdown_inline',
					});
				}
				directive.content = { start: p + 1, end: rb };
				p = rb + 1;
			}
		}

		// Optional {HTML attribute list} group: own/paint the braces, inject
		// the interior into html (wrapped so its attributes are captured),
		// and claim (not own) the interior so the injection shows through.
		if (S[p] === '{') {
			const rc = matchGroup(S, p, '{', '}', true);
			if (rc !== -1) {
				cap(ctx, p, p + 1, 'jmd-punct'); // {
				cap(ctx, rc, rc + 1, 'jmd-punct'); // }
				region(ctx, p, p + 1);
				region(ctx, rc, rc + 1);
				if (rc > p + 1) {
					ctx.out.injections.push({
						start: p + 1,
						end: rc,
						language: 'html',
						wrapPrefix: '<x ',
						wrapSuffix: ' />',
					});
					// A `style="…"` value is CSS, not a bare string — inject each
					// one into the css grammar (pushed after the html injection so
					// it wins the value span). See `styleAttrInjections`.
					styleAttrInjections(ctx, S, p + 1, rc);
					claim(ctx, p + 1, rc);
				}
				claim(ctx, p, p + 1);
				claim(ctx, rc, rc + 1);
				directive.attrs = { start: p + 1, end: rc };
				p = rc + 1;
			}
		}
		construct(ctx, 'directiveAt', at, p, directive);
		re.lastIndex = p;
	}
}

/**
 * From an opener at `from` (where `S[from] === open`), return the offset
 * of its matching `close`, or -1 if a blank line or end of input arrives
 * first (JMarkdown forbids a blank line inside a directive group). Groups
 * nest by depth. When `quoteAware`, a `close` inside a `'…'` or `"…"`
 * run (with `\` escapes) does not count — so an attribute value like
 * `style='a}b'` does not close the `{…}` early.
 *
 * @param {string} S
 * @param {number} from
 * @param {string} open
 * @param {string} close
 * @param {boolean} quoteAware
 * @returns {number}
 */
function matchGroup(S, from, open, close, quoteAware) {
	let depth = 1;
	let i = from + 1;
	while (i < S.length) {
		const c = S[i];
		if (quoteAware && (c === '"' || c === "'")) {
			i += 1;
			while (i < S.length && S[i] !== c && S[i] !== '\n') {
				i += S[i] === '\\' ? 2 : 1;
			}
			if (S[i] !== c) continue; // unterminated at EOL/EOF — resume scanning
			i += 1;
			continue;
		}
		if (c === '\n') {
			// A blank (empty/whitespace-only) next line is not permitted.
			if (/^[ \t]*(\n|$)/.test(S.slice(i + 1))) return -1;
			i += 1;
			continue;
		}
		if (c === open) depth += 1;
		else if (c === close) {
			depth -= 1;
			if (depth === 0) return i;
		}
		i += 1;
	}
	return -1;
}

/**
 * Within a directive's `{…}` attribute list `[from, to)`, inject each
 * `style="…"` / `style='…'` value into the css grammar. tree-sitter-html
 * only injects css into `<style>` *elements*, so a style *attribute*
 * value would otherwise render as a plain string. The value is a
 * declaration list, not a whole stylesheet, so it is wrapped as a rule
 * body `*{…}` (see `treesitter.js#spliceInjections`); the synthetic
 * selector and braces fall outside the real span and are clipped away.
 * Pushed after the list's html injection so it wins the value span.
 *
 * @param {object} ctx
 * @param {string} S - The masked working copy (offsets are document offsets).
 * @param {number} from - Absolute start of the attribute interior.
 * @param {number} to - Absolute end of the attribute interior.
 */
function styleAttrInjections(ctx, S, from, to) {
	const re = /\bstyle\s*=\s*(['"])/g;
	const seg = S.slice(from, to);
	let m;
	while ((m = re.exec(seg))) {
		const quote = m[1];
		const valStart = from + m.index + m[0].length;
		let j = valStart;
		while (j < to && S[j] !== quote) j += S[j] === '\\' ? 2 : 1;
		const valEnd = Math.min(j, to);
		if (valEnd > valStart) {
			ctx.out.injections.push({
				start: valStart,
				end: valEnd,
				language: 'css',
				wrapPrefix: '*{',
				wrapSuffix: '}',
			});
		}
		re.lastIndex = valEnd - from + 1;
	}
}

/** Embedded JavaScript chains → the javascript grammar. */
function jsChains(ctx, S) {
	const re = /(^|\s)(?![eEiI]\.[gGeE]\.)([A-Za-z_]\w*)(?=\(|\.(?=[A-Za-z_]))/g;
	let m;
	while ((m = re.exec(S))) {
		const start = m.index + m[1].length;
		if (isClaimed(ctx, start)) continue;
		const end = walkChain(S, start + m[2].length);
		if (end > start + m[2].length) {
			ctx.out.injections.push({ start, end, language: 'javascript' });
			claim(ctx, start, end);
			re.lastIndex = end;
		}
	}
}

/**
 * Walk a JS expression chain from just past the identifier: `(…)`
 * argument lists (balanced, string-aware) and `.prop` accesses, ending
 * at the line end like Sublime's `js-arguments` (pop at `$`).
 *
 * @param {string} S
 * @param {number} i
 * @returns {number} Offset one past the chain.
 */
function walkChain(S, i) {
	for (;;) {
		if (S[i] === '(') {
			i = walkBalanced(S, i);
		} else if (S[i] === '.' && /[A-Za-z_]/.test(S[i + 1] ?? '')) {
			i += 2;
			while (i < S.length && /\w/.test(S[i])) i += 1;
		} else {
			return i;
		}
	}
}

/**
 * Walk past a balanced bracket run starting at an opener, skipping
 * string literals (with escapes). Bails at end of line — an unclosed
 * argument list ends the chain there.
 *
 * @param {string} S
 * @param {number} i - Offset of the opener.
 * @returns {number} Offset one past the matching closer (or the EOL).
 */
function walkBalanced(S, i) {
	const pairs = { '(': ')', '[': ']', '{': '}' };
	const stack = [pairs[S[i]]];
	i += 1;
	while (i < S.length && stack.length > 0) {
		const c = S[i];
		if (c === '\n') return i;
		if (c === '"' || c === "'" || c === '`') {
			i += 1;
			while (i < S.length && S[i] !== c && S[i] !== '\n') {
				i += S[i] === '\\' ? 2 : 1;
			}
			if (S[i] === '\n') return i;
			i += 1;
			continue;
		}
		if (pairs[c]) stack.push(pairs[c]);
		else if (c === stack[stack.length - 1]) stack.pop();
		i += 1;
	}
	return i;
}

/** `==highlight==` spans — owned, so no grammar face bleeds through. */
function highlights(ctx, S) {
	const re = /==(?=\S)/g;
	let m;
	while ((m = re.exec(S))) {
		if (isClaimed(ctx, m.index)) continue;
		const open = m.index;
		const close = S.indexOf('==', open + 2);
		const blankAt = blankLineAfter(S, open + 2);
		if (close !== -1 && (blankAt === -1 || close < blankAt)) {
			cap(ctx, open, open + 2, 'jmd-punct');
			cap(ctx, open + 2, close, 'jmd-highlight');
			cap(ctx, close, close + 2, 'jmd-punct');
			construct(ctx, 'highlight', open, close + 2, {
				open: { start: open, end: open + 2 },
				close: { start: close, end: close + 2 },
				body: { start: open + 2, end: close },
			});
			region(ctx, open, close + 2);
			claim(ctx, open, close + 2);
			re.lastIndex = close + 2;
		} else if (blankAt !== -1) {
			cap(ctx, open, open + 2, 'jmd-punct');
			cap(ctx, open + 2, blankAt, 'jmd-highlight');
			construct(ctx, 'highlight', open, blankAt, {
				open: { start: open, end: open + 2 },
				body: { start: open + 2, end: blankAt },
			});
			region(ctx, open, blankAt);
			claim(ctx, open, blankAt);
			re.lastIndex = blankAt;
		}
		// No closer and no blank line: half-typed at end of file — leave it.
	}
}

/**
 * `/italic/` spans, exactly as the ENGINE reads them (owner's rule,
 * 2026-09-27: the editor always follows the engine). Its tokenizer
 * (vendor/jmarkdown/src/syntax-modifications.js#italics) is a bare regex,
 * `/([^/.?!]+[.?!]?)/`, tried at every slash the inline lexer reaches — no
 * word boundaries, so `and/or/not`, `/usr/bin` and `1/2 or 3/4` italicise
 * too, and `\/` is how an author says a slash is only a slash. A slash the
 * lexer never reaches cannot open one: an escaped `\/`, a slash inside a
 * link's destination, or an autolink or HTML tag (each consumed whole by an
 * earlier token). A BARE URL is not one: the engine does not link it, and
 * `https://a.com/b/c` italicises its `b` (measured with the engine itself). The body is raw text up to the next slash of
 * any kind — escaped or not — and no further than the paragraph. Not owned:
 * a nested `*bold*` keeps its grammar face.
 */
const ITALIC = /\/([^/.?!]+[.?!]?)\//y;
const LEXED_WHOLE = [
	/\]\([^)\n]*\)/g, // a link's destination (its text is lexed, and may hold one)
	/<[A-Za-z/!?][^>\n]*>/g, // an HTML tag or an autolink
];

function italics(ctx, S) {
	const whole = [];
	for (const re of LEXED_WHOLE) {
		re.lastIndex = 0;
		for (let m = re.exec(S); m; m = re.exec(S)) whole.push([m.index, m.index + m[0].length]);
	}
	const unreached = (pos) => whole.some(([a, b]) => pos >= a && pos < b);
	for (let open = S.indexOf('/'); open !== -1; open = S.indexOf('/', open + 1)) {
		if (isClaimed(ctx, open) || unreached(open)) continue;
		let backslashes = 0;
		for (let k = open - 1; k >= 0 && S[k] === '\\'; k -= 1) backslashes += 1;
		if (backslashes % 2 === 1) continue;
		ITALIC.lastIndex = open;
		const m = ITALIC.exec(S);
		// A blank line ends the paragraph, and the engine lexes one at a time.
		if (!m || /\n[ \t]*\n/.test(m[1])) continue;
		const closed = open + m[0].length - 1;
		cap(ctx, open, open + 1, 'jmd-punct');
		cap(ctx, open + 1, closed, 'jmd-italic');
		cap(ctx, closed, closed + 1, 'jmd-punct');
		construct(ctx, 'italic', open, closed + 1, {
			open: { start: open, end: open + 1 },
			close: { start: closed, end: closed + 1 },
			body: { start: open + 1, end: closed },
		});
		claim(ctx, open, closed + 1);
		open = closed;
	}
}

/** `\cite{…}` family — command, optional `[pre][post]`, the keys. */
function citations(ctx, S) {
	const re = /\\(?:full|no)?cite(?:author|year|t|p)?\*?(?=\s*[[{])/g;
	let m;
	while ((m = re.exec(S))) {
		if (isClaimed(ctx, m.index)) continue;
		const start = m.index;
		cap(ctx, start, start + m[0].length, 'jmd-cite');
		const cite = {
			open: { start, end: start + m[0].length },
			command: { start: start + 1, end: start + m[0].length },
			notes: [], keys: [],
		};
		let i = start + m[0].length;
		while (S[i] === '[') {
			const close = S.indexOf(']', i + 1);
			const eol = S.indexOf('\n', i + 1);
			if (close === -1 || (eol !== -1 && eol < close)) break;
			cap(ctx, i, i + 1, 'jmd-punct');
			cap(ctx, i + 1, close, 'jmd-string');
			cap(ctx, close, close + 1, 'jmd-punct');
			cite.notes.push({ start: i + 1, end: close });
			i = close + 1;
		}
		if (S[i] === '{') {
			const close = S.indexOf('}', i + 1);
			const eol = S.indexOf('\n', i + 1);
			if (close !== -1 && (eol === -1 || close < eol)) {
				cap(ctx, i, i + 1, 'jmd-punct');
				cap(ctx, i + 1, close, 'jmd-cite-key');
				cap(ctx, close, close + 1, 'jmd-punct');
				// One range per comma-separated key, whitespace trimmed.
				const keyRe = /[^,\s]+/g;
				const list = S.slice(i + 1, close);
				let k;
				while ((k = keyRe.exec(list))) {
					cite.keys.push({ start: i + 1 + k.index, end: i + 1 + k.index + k[0].length });
				}
				i = close + 1;
			}
		}
		construct(ctx, 'cite', start, i, cite);
		region(ctx, start, i);
		claim(ctx, start, i);
		re.lastIndex = i;
	}
}

/**
 * The opener of an inline footnote: `[fn:`, `[^label:`, and either with
 * an endnote group — `[fn(g):`, `[^label(g):`. The label may not hold a
 * `]`, whitespace, a colon or a `(`.
 *
 * This is the engine's own pair of patterns (OPEN_ANON / OPEN_LABEL in
 * `vendor/jmarkdown/src/inline-footnotes.js`) written as one regex, and
 * it is exported so `jmd/footnote-parser.js` — which tells lang-markdown
 * that these brackets are NOT a link — cannot drift from the scanner
 * that colours them (the arrangement block-refs.js/block-ids.js use).
 * Callers add their own flags; the source carries no anchor.
 */
export const FOOTNOTE_OPEN = /\[(?:\^[^\]\s:(]+|fn)(?:\([^)\n]*\))?:/;

/**
 * Inline footnotes — `[^label: body]`, `[fn: body]`, either with a
 * `(group)` — the WHOLE construct: the opener, the body, the closing
 * `]`.
 *
 * The body carries `jmd-footnote-body` and is left unclaimed, so the
 * passes that ran before this one (and the base grammar) still paint
 * italics, wikilinks, maths and the rest inside a note.
 *
 * The body may span paragraphs: the engine extracts a note whose body
 * holds blank lines, dedents it and renders it as its own block
 * (`preprocessFootnotes`), so a blank line inside the brackets ends
 * nothing. That is the whole point of this pass — lang-markdown reads
 * `[…]` as a link, which is what used to colour a note's body, and a
 * link stops dead at a blank line. The scanner's own face carries
 * across the break; footnote-parser.js takes the bogus link away.
 *
 * The closing bracket is found the engine's way (`findClosingBracket`):
 * nesting counted, `\]` escaped. Its code-span and maths cases are
 * already handled here — the scan runs on the masked buffer, where both
 * are blank. An unclosed opener paints the opener alone.
 */
function footnotes(ctx, S) {
	const re = new RegExp(FOOTNOTE_OPEN.source, 'g');
	let m;
	while ((m = re.exec(S))) {
		const start = m.index;
		if (isClaimed(ctx, start)) continue;
		const open = start + m[0].length;
		cap(ctx, start, open, 'jmd-footnote');
		region(ctx, start, open);
		claim(ctx, start, open);
		const close = footnoteClose(S, open);
		const note = {
			open: { start, end: open },
			label: m[0][1] === '^' ? { start: start + 2, end: start + 2 + /^[^(:]*/.exec(m[0].slice(2))[0].length } : null,
			group: null, body: null, multiline: false,
		};
		const g = /\(([^)\n]*)\):$/.exec(m[0]);
		if (g) note.group = { start: open - 2 - g[1].length, end: open - 2 };
		if (close === -1) {
			// Still being typed: the opener alone, nothing to conceal.
			construct(ctx, 'footnote', start, open, note);
			continue;
		}
		note.close = { start: close, end: close + 1 };
		note.body = { start: open, end: close };
		note.multiline = S.slice(open, close).includes('\n');
		construct(ctx, 'footnote', start, close + 1, note);
		cap(ctx, open, close, 'jmd-footnote-body');
		cap(ctx, close, close + 1, 'jmd-footnote');
		region(ctx, close, close + 1);
		claim(ctx, close, close + 1);
		// Past the whole note, as the engine's preprocessor skips it: an
		// opener inside a body is body text, not a note of its own.
		re.lastIndex = close + 1;
	}
}

/**
 * The offset of the `]` closing a footnote opened before `from`, or -1
 * when the brackets never balance.
 *
 * @param {string} S - the masked buffer (code and maths already blank)
 * @param {number} from - the offset just past the opener's colon
 * @returns {number}
 */
function footnoteClose(S, from) {
	let depth = 1;
	for (let i = from; i < S.length; i += 1) {
		const ch = S[i];
		if (ch === '\\') i += 1;
		else if (ch === '[') depth += 1;
		else if (ch === ']') {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/* ── Clew's Obsidian passes: wikilinks and tags ──────────────────────── */

/**
 * Obsidian wikilinks — `[[Target]]`, `[[Target|alias]]`,
 * `[[Target#Heading]]`, same-file `[[#Heading]]`, and `![[…]]` embeds.
 * Single-line only, matching Clew's engine (`src/engine/wikilinks.js`):
 * the target may be empty when a `#heading` follows, but a bare `[[]]`
 * (or `[[|alias]]`) is not a link.
 *
 * Faces: the delimiters — `!`, `[[`, `#`, `|`, `]]` — are
 * `jmd-wikilink-bracket`; the target and the heading part are
 * `jmd-wikilink-target`; the alias is `jmd-wikilink-alias`.
 *
 * Because the pass runs over the masked buffer, a wikilink inside a
 * code fence, an inline code span, or math never fires; the whole span
 * is claimed so the later passes (italics, JS chains, tags) stay out.
 */
function wikilinks(ctx, S) {
	const re = /(!)?(\[\[)([^[\]|#\n]*)(#[^[\]|\n]*)?(\|[^[\]\n]*)?(\]\])/g;
	let m;
	while ((m = re.exec(S))) {
		const start = m.index;
		const bstart = start + (m[1] ? 1 : 0); // offset of '[['
		if (isClaimed(ctx, bstart)) continue;
		const target = m[3];
		const heading = m[4]; // includes the leading '#'
		const alias = m[5]; // includes the leading '|'
		if (!target && !heading) continue; // [[]] is not a link
		let p = start;
		if (m[1]) {
			cap(ctx, p, p + 1, 'jmd-wikilink-bracket'); // !
			p += 1;
		}
		cap(ctx, p, p + 2, 'jmd-wikilink-bracket'); // [[
		p += 2;
		if (target) {
			cap(ctx, p, p + target.length, 'jmd-wikilink-target');
			p += target.length;
		}
		if (heading) {
			cap(ctx, p, p + 1, 'jmd-wikilink-bracket'); // #
			cap(ctx, p + 1, p + heading.length, 'jmd-wikilink-target');
			p += heading.length;
		}
		if (alias) {
			cap(ctx, p, p + 1, 'jmd-wikilink-bracket'); // |
			cap(ctx, p + 1, p + alias.length, 'jmd-wikilink-alias');
			p += alias.length;
		}
		cap(ctx, p, p + 2, 'jmd-wikilink-bracket'); // ]]
		const end = start + m[0].length;
		const t0 = bstart + 2;
		const h0 = t0 + target.length; // offset of '#', when present
		const a0 = h0 + (heading ? heading.length : 0); // offset of '|'
		const isBlock = Boolean(heading) && heading[1] === '^';
		construct(ctx, m[1] ? 'embed' : 'wikilink', start, end, {
			open: { start, end: t0 },
			close: { start: end - 2, end },
			target: span(t0, h0),
			heading: heading && !isBlock ? span(h0 + 1, a0) : null,
			blockId: isBlock ? span(h0 + 2, a0) : null,
			alias: alias ? { start: a0 + 1, end: a0 + alias.length } : null,
			aliasText: alias ? alias.slice(1) : null,
		});
		region(ctx, start, end);
		claim(ctx, start, end);
		re.lastIndex = end;
	}
}

/**
 * Obsidian tags — `#tag`, nested `#a/b`, hyphens and underscores — at
 * a word boundary (start of line/text, after whitespace, or after an
 * opening bracket). A heading's leading `#`s never match: an ATX
 * heading requires a space (or another `#`) after the marker, and a
 * tag requires a tag character immediately, so the two are disjoint
 * (`#tag` at line start IS a tag, `# Title` is not). A purely numeric
 * `#123` is not a tag (Obsidian's rule — keeps issue references
 * plain), and running over the masked buffer keeps code and math
 * clean; the claimed-span check keeps the pass out of wikilink
 * headings, attribute lists, and every other resolved construct.
 */
function tags(ctx, S) {
	const re = /(^|[\s([{])#([\w-]+(?:\/[\w-]+)*)/g;
	let m;
	while ((m = re.exec(S))) {
		const at = m.index + m[1].length; // offset of '#'
		if (isClaimed(ctx, at)) continue;
		if (!/[^\d/]/.test(m[2])) continue; // purely numeric
		const end = at + 1 + m[2].length;
		cap(ctx, at, end, 'jmd-tag');
		construct(ctx, 'tag', at, end, { name: { start: at + 1, end } });
		region(ctx, at, end);
		claim(ctx, at, end);
	}
}

/**
 * The offset of the first blank line at or after `from` (the offset of
 * the newline that *precedes* the blank line), or -1.
 *
 * @param {string} S
 * @param {number} from
 * @returns {number}
 */
function blankLineAfter(S, from) {
	const m = /\n[ \t]*(?:\n|$)/.exec(S.slice(from));
	return m ? from + m.index : -1;
}
