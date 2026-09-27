// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// A lang-markdown extension that takes an inline footnote's brackets away
// from the link parser.
//
// `[^label: …]` and `[fn: …]` (jmarkdown's inline footnotes) open with a
// `[`, so stock markdown reads the whole note as a bracket link — a
// shortcut reference, built whether or not any definition exists — and
// paints its body with the link face. That face was the only thing
// colouring a note's body, and it stops dead at a blank line, because an
// inline construct cannot leave its paragraph. The engine, on the other
// hand, is perfectly happy with a multi-paragraph note (it lifts such a
// body out and sets it as its own block: `preprocessFootnotes` in
// vendor/jmarkdown/src/inline-footnotes.js), so a note that grew a second
// paragraph appeared to lose its highlighting halfway through.
//
// This parser claims the opener before `Link` can see the `[`, so no link
// node is built and the dialect overlay (jmd-footnote / jmd-footnote-body,
// from jmarkdown-scan.js) is the one thing painting a note — the same face
// whether the body runs to the end of the line or over five paragraphs.
// The opener pattern comes from the scanner, so the two cannot disagree
// about what a footnote is.
//
// It claims the closing `]` too, and that is not cosmetic: `matchBrackets`
// pairs two brackets only when the syntax tree gives them the SAME node
// type, so an opener lifted out of the paragraph and a closer left in it
// would no longer be a pair — every note would wear the red
// `cm-nonmatchingBracket`. Both ends carry one node type, and a note's
// brackets match across the blank lines of a multi-paragraph body, which
// the accidental link never managed.
import { FOOTNOTE_OPEN } from './jmarkdown-scan.js';

/** The one node type: `[^label:` / `[fn:` and the `]` that closes it. */
const MARK = 'JmdFootnoteMark';

/** The opener, sticky, for matching at one position. */
const OPENER = new RegExp(FOOTNOTE_OPEN.source, 'y');

/**
 * True when the `]` at `at` closes an inline footnote: the nearest `[`
 * still open before it is a footnote opener — or nothing is open at all,
 * which is how the last block of a multi-paragraph note ends (its opener
 * is in an earlier block, out of this inline section's reach, and a `]`
 * closing nothing was never a link either way).
 *
 * The walk is backwards over the section's own text and stops at the
 * first unbalanced bracket, so it reads a few words in the ordinary
 * case; code spans and escapes are already out of the way (`InlineCode`
 * parses before this, and an escaped bracket is skipped here).
 *
 * @param {string} text - the inline section's text
 * @param {number} at - the `]`'s offset within it
 * @returns {boolean}
 */
function closesFootnote(text, at) {
	let depth = 0;
	for (let i = at - 1; i >= 0; i -= 1) {
		const ch = text[i];
		if ((ch !== '[' && ch !== ']') || escaped(text, i)) continue;
		if (ch === ']') {
			depth += 1;
			continue;
		}
		if (depth > 0) {
			depth -= 1;
			continue;
		}
		OPENER.lastIndex = i;
		return OPENER.test(text);
	}
	return true;
}

/** True when the character at `i` is preceded by an odd run of `\`. */
function escaped(text, i) {
	let n = 0;
	while (i - n > 0 && text[i - n - 1] === '\\') n += 1;
	return n % 2 === 1;
}

/**
 * The markdown extension. Registered in editor.js alongside the dialect's
 * other corrections to stock markdown.
 *
 * @type {import('@lezer/markdown').MarkdownConfig}
 */
export const jmdFootnotes = {
	defineNodes: [MARK],
	parseInline: [{
		name: MARK,
		before: 'Link',
		parse(cx, next, pos) {
			const at = pos - cx.offset;
			if (next === 91 /* '[' */) {
				OPENER.lastIndex = at;
				const m = OPENER.exec(cx.text);
				return m ? cx.addElement(cx.elt(MARK, pos, pos + m[0].length)) : -1;
			}
			if (next === 93 /* ']' */ && closesFootnote(cx.text, at)) {
				return cx.addElement(cx.elt(MARK, pos, pos + 1));
			}
			return -1;
		},
	}],
};
