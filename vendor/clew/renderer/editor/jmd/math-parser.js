// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// A lang-markdown extension that hands every math segment to the dialect
// whole, before markdown's own inline parsers see inside it.
//
// Stock markdown knows nothing about `$…$`, so the asterisk in `$R^*$`
// is an emphasis delimiter like any other: it pairs with the next one in
// the paragraph — typically inside a SECOND formula — and everything
// between, prose and formulae alike, goes bold (the owner's report,
// 2026-09-18: `$R^*$ is incomplete … we need $R_w^*(S)$` bolded the
// sentence). The same would go for `[` and `_` and a backtick inside a
// formula; TeX is full of markdown's punctuation.
//
// The overlay already knew better — jmarkdown-scan.js scans math first and
// paints it `jmd-math` — but a face cannot un-parse a node. This parser
// claims the whole segment as one element, so no inline construct can
// start, end or pair inside it. The segments come from the SAME scanner
// the overlay uses, on the same config, so the grammar and the faces
// cannot disagree about where a formula begins and ends.
//
// What counts as math is therefore math-segments.js' business: `$…$`,
// `$$…$$`, `\(…\)`, `\[…\]` and the display environments, escapes
// respected, and no delimiter pair crossing a blank line. Inline code is
// not a special case here: InlineCode parses before this, so a `$` inside
// backticks is never offered to us, and a fenced block never reaches
// inline parsing at all.
import { scanMathSegments, MARKDOWN_MATH_CONFIG } from './math-segments.js';

/** The one node type: a whole math segment, delimiters included. */
const MARK = 'JmdMath';

// The scan is per inline section, and a section is parsed to completion
// before the next one starts, so a single slot serves. Without it every
// `$` in a paragraph would rescan the paragraph.
let cachedText = null;
let cachedStarts = null;

/** Map of segment start → end offset, within this inline section's text. */
function segmentsOf(text) {
	if (text !== cachedText) {
		cachedStarts = new Map();
		for (const seg of scanMathSegments(text, MARKDOWN_MATH_CONFIG)) {
			cachedStarts.set(seg.start, seg.end);
		}
		cachedText = text;
	}
	return cachedStarts;
}

/**
 * The markdown extension. Registered in editor.js alongside the dialect's
 * other corrections to stock markdown.
 *
 * @type {import('@lezer/markdown').MarkdownConfig}
 */
export const jmdMath = {
	defineNodes: [MARK],
	parseInline: [{
		name: MARK,
		// Before EVERY default inline parser, not just the delimiter ones:
		// `Escape` is first in that list and claims the `\(` of `\(x\)`
		// as an escaped paren, which would hide the segment from us (it did
		// — `\(…\)` and `\[…\]` went unclaimed until this said Escape).
		// Running first costs nothing: at a `\` that opens no segment we
		// return -1 and Escape gets it back, and a `$` inside a code span
		// is never offered to us at all — InlineCode claims the span from
		// its backtick, a position where we decline.
		before: 'Escape',
		parse(cx, next, pos) {
			// `$` opens three of the four pairs; `\` opens `\(`, `\[` and the
			// display environments. Every other character is not ours.
			if (next !== 36 /* '$' */ && next !== 92 /* '\\' */) return -1;
			const end = segmentsOf(cx.text).get(pos - cx.offset);
			if (end === undefined) return -1;
			return cx.addElement(cx.elt(MARK, pos, cx.offset + end));
		},
	}],
};
