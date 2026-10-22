// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Obsidian's comments, hidden as Obsidian hides them (the owner's "C1",
// 2026-10-22): `%%…%%` within a line, and a block of lines opened by `%%` and
// closed by the next `%%` —
//
//     %% kanban:settings
//     ```
//     {"kanban-plugin":"basic"}
//     ```
//     %%
//
// — leave nothing in reading view, an HTML or LaTeX export, a PDF via LaTeX,
// the reading-view PDF or a site export. Until then a note without front
// matter printed them (the HTML as paragraphs; the LaTeX, since jmarkdown
// 2928d5d writes a `%` the HTML shows as `\%`, too). Live edit is source: it
// shows them as written.
//
// NEVER INSIDE CODE OR MATHS. The lexer never stands inside a fence, a code
// span or a formula — each is consumed whole where it starts — so an opening
// `%%` there is never seen. A CLOSING one could be: `%% a \`b %% c\` d %%`.
// So the closer is looked for past fences (at a line's start), code spans,
// `$…$`, `$$…$$`, `\(…\)`, `\[…\]`, `\begin{x}…\end{x}` and escapes, each
// skipped whole as the engine reads it (a lone `$` is text, as there).
//
// AN UNCLOSED `%%` IS TEXT (Clew-boss, 2026-10-22): hiding the rest of a note
// for a stray `%%` would lose it from every export without a word. Obsidian
// differs here, by its own help: "If you start a block comment and never close
// it, Reading view hides the rest of the note."
//
// jmarkdown's own `%` comment (installed for a note WITH a header, per
// document, so after these rules — and marked tries the last registered
// first) takes the rest of a line at a `%` before the inline rule is asked:
// in such a note `a %%b%% c` loses ` c` too, as it always has. The block rule
// is asked before any inline rule, so a block is hidden whole in either.
//
// Loaded by the preview's generated config (render-service.js `Extensions`,
// which the site export shares) and registered by every export
// (export-config.js#EXPORT_EXTENSIONS, export-worker.mjs). No imports: a host
// without Node (Clew-iOS) registers it as is.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Where `text` (searched from `from`) has the `%%` that closes a comment
 *  begun before `from`, skipping code and maths whole; -1 if none. `lineStart`
 *  says whether `from` begins a line (a fence opens only there). */
function closerIndex(text, from, lineStart = false) {
	let i = from;
	let atLineStart = lineStart;
	while (i < text.length) {
		if (atLineStart) {
			const fence = FENCE.exec(text.slice(i));
			if (fence) {
				const marker = fence[1];
				const close = new RegExp(`\\n {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*(?=\\n|$)`, 'g');
				close.lastIndex = i + fence[0].length;
				const end = close.exec(text);
				if (!end) return -1;	// an unclosed fence runs to the end, comment and all
				i = end.index + end[0].length;
				atLineStart = false;
				continue;
			}
		}
		const c = text[i];
		atLineStart = false;
		if (c === '\n') { i += 1; atLineStart = true; continue; }
		if (c === '\\') {
			i = skipBackslash(text, i);
			continue;
		}
		if (c === '`') {
			// A code span ends at a run exactly as long as its opening one.
			const run = /^`+/.exec(text.slice(i))[0];
			const close = findRun(text, run, i + run.length);
			i = close === -1 ? i + run.length : close + run.length;
			continue;
		}
		if (c === '$') {
			const double = text.startsWith('$$', i);
			const delim = double ? '$$' : '$';
			const end = text.indexOf(delim, i + delim.length);
			if (end > i + delim.length) { i = end + delim.length; continue; }
			i += delim.length;
			continue;
		}
		if (c === '%' && text[i + 1] === '%') return i;
		i += 1;
	}
	return -1;
}

/** Past an escape, or past `\(…\)`, `\[…\]`, `\begin{x}…\end{x}` when closed. */
function skipBackslash(text, i) {
	const next = text[i + 1];
	if (next === '(' || next === '[') {
		const end = text.indexOf(next === '(' ? '\\)' : '\\]', i + 2);
		return end === -1 ? i + 2 : end + 2;
	}
	const begin = /^\\begin\{([A-Za-z*]+)\}/.exec(text.slice(i));
	if (begin) {
		const close = `\\end{${begin[1]}}`;
		const end = text.indexOf(close, i + begin[0].length);
		return end === -1 ? i + begin[0].length : end + close.length;
	}
	return i + 2;
}

/** The index of the next backtick run exactly as long as `run`, or -1. */
function findRun(text, run, from) {
	let at = text.indexOf(run, from);
	while (at !== -1) {
		const before = at > 0 && text[at - 1] === '`';
		const after = text[at + run.length] === '`';
		if (!before && !after) return at;
		at = text.indexOf(run, at + 1);
	}
	return -1;
}

/** A block comment at the start of `src`: its raw text, or null. A closer
 *  ending its line takes the line; one with text after it, on a LATER line
 *  than the opener, ends the comment there and the text is prose ("Text after
 *  the closing %% stays visible", Obsidian's help); on the opener's own line
 *  (`%%a%% visible`) it is a paragraph, whose comment the inline rule takes. */
function blockAt(src) {
	const open = /^ {0,3}%%/.exec(src);
	if (!open) return null;
	const close = closerIndex(src, open[0].length);
	if (close === -1) return null;
	const rest = /^%%[ \t]*(?:\n|$)/.exec(src.slice(close));
	if (rest) return src.slice(0, close + rest[0].length);
	return src.slice(0, close).includes('\n') ? src.slice(0, close + 2) : null;
}

/** An inline comment at the start of `src`: its raw text, or null. */
function inlineAt(src) {
	if (!src.startsWith('%%')) return null;
	const close = closerIndex(src, 2);
	return close === -1 ? null : src.slice(0, close + 2);
}

export const obsidianComment = {
	name: 'obsidianComment',
	level: 'block',
	start(src) {
		// Only where the rule will take the block: a start that the tokenizer
		// then declined would cut the paragraph before it in two.
		for (const m of src.matchAll(/(^|\n)( {0,3}%%)/g)) {
			const at = m.index + m[1].length;
			if (blockAt(src.slice(at))) return at;
		}
		return undefined;
	},
	tokenizer(src) {
		const raw = blockAt(src);
		if (raw) return { type: 'obsidianComment', raw, text: raw };
	},
	renderer() {
		return '';
	},
};

export const obsidianInlineComment = {
	name: 'obsidianInlineComment',
	level: 'inline',
	start(src) {
		for (let at = src.indexOf('%%'); at !== -1; at = src.indexOf('%%', at + 1)) {
			if (at > 0 && src[at - 1] === '\\') continue;
			if (inlineAt(src.slice(at))) return at;
		}
		return undefined;
	},
	tokenizer(src) {
		const raw = inlineAt(src);
		if (raw) return { type: 'obsidianInlineComment', raw, text: raw };
	},
	renderer() {
		return '';
	},
};
