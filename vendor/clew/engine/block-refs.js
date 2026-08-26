// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Obsidian block identifiers: `^some-id` marking a block so that
// `[[Note#^some-id]]` can link to it and `![[Note#^some-id]]` can transclude
// just that block. Core Obsidian, and the largest remaining compatibility gap
// after callouts.
//
// A marker sits either at the end of the block's last line —
//
//     Ideal observers are a modelling convenience, not a claim. ^ideal-obs
//
// — or, for blocks that cannot carry a trailing word (tables, fenced code,
// whole lists), on its own line directly below.
//
// THE SUPERSCRIPT PROBLEM. jmarkdown reads `^` as TeX superscript: `x^2` is
// x², and its rule (`/^\^([a-zA-Z0-9]|\{[^}]*\})/`) would happily take the
// `^i` of `^ideal-obs` and leave `deal-obs` as prose. Registration order is
// not a reliable fix — marked consults extensions per position, and both
// rules start at the same `^`.
//
// So the trailing-marker rule CLAIMS THE WHITESPACE BEFORE THE CARET. The two
// rules can then never be offered the same offset: at the space, superscript's
// `/^\^/` cannot match; by the caret, this rule has already consumed the
// token. `start()` cuts the preceding text token at the space, which is what
// puts the lexer there in the first place. It also means `x^2` at the end of a
// paragraph stays a superscript, because nothing separates the x from the
// caret.
//
// Obsidian's character class is `[A-Za-z0-9-]`; matching it exactly is
// deliberate. Widening it to `_` would collide with subscript (`H_2O`) for no
// compatibility gain, since Obsidian would not have written such an id.

// Exported so that the editor-side command which WRITES markers agrees with
// the renderer that reads them — one definition of what a block id is.
export const ID = '[A-Za-z0-9-]{1,128}';
const TRAILING_START = new RegExp(`[ \\t]\\^${ID}$`);
const TRAILING = new RegExp(`^[ \\t]+\\^(${ID})$`);
const STANDALONE = new RegExp(`^\\^(${ID})[ \\t]*(?:\\n+|$)`);

const escapeAttr = (s) =>
	s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The anchor a marker leaves behind. Invisible (see preview.css) — Obsidian
 * hides the identifier in reading mode, and a note peppered with `^a3f9c1`
 * would be unreadable.
 *
 * Both `id` and `data-block-id` are emitted: the id makes `#^a3f9c1` work as a
 * real URL fragment in an exported site (browsers percent-decode before
 * matching), the data attribute makes the element findable from script without
 * having to CSS-escape a caret.
 */
const anchor = (id) =>
	`<span class="block-anchor" id="^${escapeAttr(id)}" data-block-id="${escapeAttr(id)}"></span>`;

/** `Some prose. ^block-id` — the common case. */
export const blockAnchor = {
	name: 'blockAnchor',
	level: 'inline',
	start(src) {
		const match = TRAILING_START.exec(src);
		return match ? match.index : undefined;
	},
	tokenizer(src) {
		const match = TRAILING.exec(src);
		if (!match) return;
		return { type: 'blockAnchor', raw: match[0], id: match[1] };
	},
	renderer(token) {
		return global.isLatex ? '' : anchor(token.id);
	},
};

/** A marker on its own line, below a table, fence or list. */
export const blockAnchorLine = {
	name: 'blockAnchorLine',
	level: 'block',
	// Clipping the paragraph above is the whole reason this rule exists: left
	// alone, marked swallows the marker line as a lazy continuation and the
	// inline rule never sees it (a newline is not the space it requires). The
	// pattern is the full marker, not a bare `\n^`, so that a line merely
	// STARTING with a caret does not get torn off its paragraph.
	start(src) {
		const match = new RegExp(`\\n\\^${ID}[ \\t]*(?:\\n|$)`).exec(src);
		return match ? match.index + 1 : undefined;
	},
	tokenizer(src) {
		const match = STANDALONE.exec(src);
		if (!match) return;
		return { type: 'blockAnchorLine', raw: match[0], id: match[1] };
	},
	renderer(token) {
		return global.isLatex ? '' : anchor(token.id) + '\n';
	},
};

/**
 * A marker on the line below a TABLE needs help.
 *
 * A table is the one block that keeps swallowing lines until it meets a blank
 * one, and marked's `start()` hook — which is how the rule above keeps a
 * paragraph off its marker — clips paragraphs and nothing else. So
 * `^payoff-table` under a table becomes a phantom final row reading
 * "ᵖayoff-table", which is worse than not supporting the syntax at all.
 *
 * Block extensions are tried before the engine's table rule (marked unshifts
 * each registration, and a host's extensions load long after the engine's),
 * so this rule gets the first look at the table. It claims the rows, lexes
 * them on their own — where, with no marker beneath, the table rule renders
 * them exactly as it always would — and leaves the marker line untouched for
 * the next pass to pick up.
 *
 * It fires ONLY on a run of non-blank lines that both starts with a pipe row
 * and ends at a marker, so an ordinary table is never intercepted.
 */
const TABLE_THEN_MARKER = new RegExp(
	`^([^\\n]*\\|[^\\n]*\\n(?:[^\\n\\s][^\\n]*\\n)*?)(?=\\^${ID}[ \\t]*(?:\\n|$))`,
);

export const tableBeforeAnchor = {
	name: 'tableBeforeAnchor',
	level: 'block',
	tokenizer(src) {
		const match = TABLE_THEN_MARKER.exec(src);
		if (!match) return;
		const token = { type: 'tableBeforeAnchor', raw: match[1], tokens: [] };
		// No marker follows this slice, so the rule cannot recurse into itself.
		this.lexer.blockTokens(match[1], token.tokens);
		return token;
	},
	renderer(token) {
		return this.parser.parse(token.tokens);
	},
};

// ---- source slicing (used by wikilinks.js for ![[Note#^id]]) ---------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LIST_ITEM = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+/;
const indentOf = (line) => /^[ \t]*/.exec(line)[0].length;

/**
 * Which lines a blank line actually separates blocks on. A blank line inside
 * a fenced block is content — walking over one would slice a code sample in
 * half and transclude the tail.
 */
export function boundaries(lines) {
	const blank = new Array(lines.length).fill(false);
	let fence = null;
	for (let i = 0; i < lines.length; i++) {
		const delim = /^[ \t]*(`{3,}|~{3,})/.exec(lines[i]);
		if (fence === null && delim) { fence = delim[1][0]; continue; }
		if (fence !== null) { if (delim && delim[1][0] === fence) fence = null; continue; }
		blank[i] = lines[i].trim() === '';
	}
	return blank;
}

/** Remove every `^id` marker from a slice of source, in both positions. */
export function stripBlockMarkers(text) {
	return text
		.split('\n')
		.filter((line) => !new RegExp(`^[ \\t]*\\^${ID}[ \\t]*$`).test(line))
		.map((line) => line.replace(new RegExp(`[ \\t]+\\^${ID}[ \\t]*$`), ''))
		.join('\n');
}

/**
 * The block `id` marks, as source text, or null when the id is not in `content`.
 *
 * "Block" means what a reader would point at: the paragraph, the table, the
 * fenced code. A marker at the end of a LIST ITEM takes that item and the
 * lines nested under it rather than the whole list — a mid-list marker
 * otherwise drags in every item above it, which is not what the link meant.
 */
export function sliceBlock(content, id) {
	const lines = content.split('\n');
	const standaloneRe = new RegExp(`^[ \\t]*\\^${escapeRe(id)}[ \\t]*$`);
	const trailingRe = new RegExp(`[ \\t]\\^${escapeRe(id)}[ \\t]*$`);

	let marker = -1;
	let standalone = false;
	for (let i = 0; i < lines.length; i++) {
		if (standaloneRe.test(lines[i])) { marker = i; standalone = true; break; }
		if (trailingRe.test(lines[i])) { marker = i; break; }
	}
	if (marker === -1) return null;

	const blank = boundaries(lines);
	let start;
	let end;
	if (standalone) {
		// The block above, back to the blank line that opened it.
		end = marker - 1;
		while (end >= 0 && blank[end]) end--;
		if (end < 0) return null;
		start = end;
		while (start > 0 && !blank[start - 1]) start--;
	} else if (LIST_ITEM.test(lines[marker])) {
		const indent = LIST_ITEM.exec(lines[marker])[1].length;
		start = marker;
		end = marker;
		while (end + 1 < lines.length) {
			const next = lines[end + 1];
			if (blank[end + 1] || indentOf(next) <= indent) break;
			end++;
		}
	} else {
		start = marker;
		end = marker;
		while (start > 0 && !blank[start - 1]) start--;
		while (end + 1 < lines.length && !blank[end + 1]) end++;
	}
	return stripBlockMarkers(lines.slice(start, end + 1).join('\n')).trim();
}

export default [tableBeforeAnchor, blockAnchorLine, blockAnchor];
