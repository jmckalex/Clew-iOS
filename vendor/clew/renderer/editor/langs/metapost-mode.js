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
 * @file MetaPost highlighting for the editor's ```metapost fences — a
 * stream-parser spec like tex-mode.js, and pure for the same reason.
 *
 * The vocabulary comes from src/engine/metapost-words.js, the SAME lists
 * the engine builds its highlight.js grammar from, so the source pane and
 * a `show=code` block in the preview agree on what is a keyword. Faces:
 *
 *   beginfig draw def if …          → keyword
 *   pair path numeric …             → typeName
 *   origin cycle red cm true …      → atom
 *   scaled withpen of and …         → operatorKeyword
 *   "string"                        → string       (never spans a line)
 *   3  0.5  .25                     → number       (`2cm` is 2 then cm)
 *   := .. -- ... = + < …            → operator
 *   z1  a.b  @#                     → variableName / variableName.special
 *   ( ) [ ] { }                     → bracket
 *   %comment                        → comment
 *   btex … etex, verbatimtex … etex → the keywords, and TeX in between
 *                                     (tex-mode.js takes the tokens)
 */
import {
	METAPOST_CONSTANTS, METAPOST_KEYWORDS, METAPOST_OPERATORS, METAPOST_TYPES,
} from '../../../engine/metapost-words.js';
import { texToken } from './tex-mode.js';

const KEYWORDS = new Set(METAPOST_KEYWORDS);
const TYPES = new Set(METAPOST_TYPES);
const CONSTANTS = new Set(METAPOST_CONSTANTS);
const OPERATORS = new Set(METAPOST_OPERATORS);

const NUMBER = /^(?:\d+\.?\d*|\.\d+)/;
const OPERATOR = /^(?::=|\.\.\.|\.\.|--|->|<=|>=|<>|[-+*/=<>&])/;

/**
 * @param {import('@codemirror/language').StringStream} stream
 * @param {{ tex: boolean, texState: { env?: number } }} state
 * @returns {string|null}
 */
function metapostToken(stream, state) {
	if (state.tex) {
		// The closer first, at every token boundary: TeX's own word rule
		// would otherwise swallow it as a word.
		if (stream.match(/^etex\b/)) {
			state.tex = false;
			return 'keyword';
		}
		return texToken(stream, state.texState);
	}
	if (stream.eatSpace()) return null;
	const ch = stream.peek();
	if (ch === '%') {
		stream.skipToEnd();
		return 'comment';
	}
	if (ch === '"') {
		stream.next();
		if (stream.skipTo('"')) stream.next(); else stream.skipToEnd();
		return 'string';
	}
	if (stream.match(/^(?:btex|verbatimtex)\b/)) {
		state.tex = true;
		state.texState = { env: 0 };
		return 'keyword';
	}
	if (/[A-Za-z_]/.test(ch)) {
		stream.eatWhile(/[A-Za-z_]/);
		const word = stream.current();
		if (KEYWORDS.has(word)) return 'keyword';
		if (TYPES.has(word)) return 'typeName';
		if (CONSTANTS.has(word)) return 'atom';
		if (OPERATORS.has(word)) return 'operatorKeyword';
		// A variable: its tag, plus any numeric subscript (`z1`, `p12`).
		stream.eatWhile(/\d/);
		return 'variableName';
	}
	if (stream.match(NUMBER)) return 'number';
	if (stream.match(OPERATOR)) return 'operator';
	if (stream.match(/^@#?/)) return 'variableName.special';
	if (/[()[\]{}]/.test(ch)) {
		stream.next();
		return 'bracket';
	}
	stream.next();
	return null;
}

/** The StreamLanguage spec. */
export const metapostMode = {
	name: 'metapost',
	startState: () => ({ tex: false, texState: { env: 0 } }),
	copyState: (state) => ({ tex: state.tex, texState: { ...state.texState } }),
	token: metapostToken,
	languageData: { commentTokens: { line: '%' } },
};
