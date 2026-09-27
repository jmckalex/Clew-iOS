// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// TeX-style sub- and superscripts, and Obsidian block ids, in the editor's
// markdown grammar — so the lezer tree says what the ENGINE will do.
//
// In this dialect `H_2O` and `x^{10}` are a subscript and a superscript
// (the engine's rules, vendor/jmarkdown/src/syntax-modifications.js:
// `/^_([a-zA-Z0-9]|\{[^}]*\})/` and the same with `^`). Stock markdown
// disagrees in two places: it reads `_x_` as emphasis, and GFM reads
// `^x^` as a superscript. Neither is a thing here — `_x_` is subscript-x
// then a literal underscore, `^x^` superscript-x then a literal caret.
// Source mode never cared (the faces were close enough); live edit reads
// meaning from the tree, and a face cannot un-parse a node.
//
// Block ids share the caret. The engine's block-refs.js claims the
// WHITESPACE before `^id` when the id runs to the end of the block, so the
// two rules are never offered the same offset; here the same test picks
// JmdBlockId over JmdSuperscript: a caret after whitespace (or opening
// the block) whose id runs to the end of the inline section. `x^2` at the
// end of a paragraph stays a superscript, because nothing separates the x
// from the caret. `ID` comes from block-refs.js itself, as block-ids.js
// does, so writer, reader and grammar share one idea of an id.
//
// Registered only when the vault's `normalSyntax` is off: under standard
// markdown `_x_` IS emphasis and none of this applies (editor.js).
import { ID } from '../../../engine/block-refs.js';

const SUB = 'JmdSubscript';
const SUP = 'JmdSuperscript';
const MARK = 'JmdSubSupMark';
const BLOCK_ID = 'JmdBlockId';

/** `^id` running to the end of the section (trailing blanks allowed). */
const BLOCK_ID_REST = new RegExp(`^\\^${ID}[ \\t]*$`);

const isAlnum = (c) =>
	(c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isBlank = (c) => c === 32 || c === 9 || c === 10;

/**
 * The markdown extension. Order among the dialect's parsers matters:
 * math first (a `_` inside `$…$` is TeX, never offered here), then this,
 * then footnotes — editor.js lists them in that order, and `before:
 * 'Escape'` puts all of them ahead of every stock inline parser (Emphasis
 * and GFM's Superscript included). `\_` is still an escape: at a
 * backslash this parser declines and Escape takes both characters.
 *
 * @type {import('@lezer/markdown').MarkdownConfig}
 */
export const jmdSubSup = {
	defineNodes: [SUB, SUP, MARK, BLOCK_ID],
	parseInline: [{
		name: SUB,
		before: 'Escape',
		parse(cx, next, pos) {
			if (next !== 95 /* _ */ && next !== 94 /* ^ */) return -1;
			const rel = pos - cx.offset;
			if (next === 94) {
				const prev = rel === 0 ? 10 : cx.text.charCodeAt(rel - 1);
				if (isBlank(prev) && BLOCK_ID_REST.test(cx.text.slice(rel))) {
					const idEnd = cx.offset + rel + /^\^[A-Za-z0-9-]+/.exec(cx.text.slice(rel))[0].length;
					return cx.addElement(cx.elt(BLOCK_ID, pos, idEnd));
				}
			}
			const name = next === 95 ? SUB : SUP;
			const c = cx.char(pos + 1);
			if (isAlnum(c)) {
				return cx.addElement(cx.elt(name, pos, pos + 2, [cx.elt(MARK, pos, pos + 1)]));
			}
			if (c === 123 /* { */) {
				const close = cx.text.indexOf('}', rel + 2);
				if (close === -1) return -1;
				const end = cx.offset + close + 1;
				return cx.addElement(cx.elt(name, pos, end, [
					cx.elt(MARK, pos, pos + 2),
					cx.elt(MARK, end - 1, end),
				]));
			}
			return -1;
		},
	}],
};
