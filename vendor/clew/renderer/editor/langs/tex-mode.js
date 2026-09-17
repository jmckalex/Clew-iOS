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
 * @file TeX highlighting for the editor's ```tikz, ```latex and ```tex
 * fences: a CodeMirror stream-parser spec (StreamLanguage.define takes it
 * in fence-languages.js), written against StringStream alone so it is
 * pure and tests under plain node. metapost-mode.js borrows `texToken`
 * for the TeX inside `btex … etex`.
 *
 * Faces, by lezer tag name (theme.js maps them onto the overlay's jmd-*
 * classes, so a keyword here is the same colour as one in a mermaid body):
 *
 *   %comment                        → comment
 *   \begin \end \documentclass …    → keyword    (structure and definitions)
 *   the {name} after \begin/\end    → atom
 *   any other \controlsequence      → variableName.function
 *   { } [ ]                         → bracket
 *   2pt 0.5cm 3                     → number
 *   -- -> <-> .. |- -| = + …        → operator   (TikZ path operators included)
 *   #1                              → variableName.special
 *   $                               → operator
 *
 * Everything else — words, punctuation, the text of a node label — is left
 * unstyled: a TikZ picture is mostly its commands and coordinates, and the
 * colour is for finding those.
 */

/** Control sequences that shape a document rather than draw in it. */
const KEYWORDS = new Set([
	'begin', 'end', 'documentclass', 'usepackage', 'usetikzlibrary', 'usegdlibrary',
	'RequirePackage', 'input', 'include', 'def', 'edef', 'gdef', 'xdef', 'let',
	'newcommand', 'renewcommand', 'providecommand', 'newenvironment',
	'renewenvironment', 'newif', 'newcounter', 'newlength', 'setlength',
	'if', 'ifx', 'ifnum', 'ifdim', 'ifcase', 'ifdefined', 'ifcsname', 'iftrue',
	'iffalse', 'else', 'fi', 'or', 'loop', 'repeat', 'foreach', 'tikzset',
	'pgfkeys', 'pgfmathsetmacro', 'pgfmathparse', 'pgfmathtruncatemacro',
	'csname', 'endcsname', 'expandafter', 'noexpand', 'the', 'global', 'long',
	'outer', 'relax', 'bye', 'directlua', 'luaexec', 'makeatletter',
	'makeatother', 'section', 'subsection', 'subsubsection', 'chapter',
	'paragraph', 'item', 'label', 'ref', 'cite',
]);

const UNIT = '(?:pt|bp|cm|mm|in|em|ex|pc|dd|cc|sp|px|mu|truept|truecm|truemm|truein)?';
const NUMBER = new RegExp(`^(?:\\d+\\.?\\d*|\\.\\d+)${UNIT}`);
// Longest first: a `<->` must not be read as `<` `-` `>`.
const OPERATOR = /^(?:<->|<-|->|--|\.\.|-\||\|-|[-+*/=<>&^_~!|])/;

/**
 * One token of TeX. `state.env` tracks the `{name}` after a \begin or \end
 * so the environment name gets a face: 1 = expecting the brace, 2 = inside
 * it, 0 = elsewhere.
 * @param {import('@codemirror/language').StringStream} stream
 * @param {{ env?: number }} state
 * @returns {string|null} a lezer tag name, or null for plain text
 */
export function texToken(stream, state) {
	if (stream.eatSpace()) return null;
	const ch = stream.peek();
	if (ch === '%') {
		stream.skipToEnd();
		return 'comment';
	}
	if (ch === '\\') {
		stream.next();
		if (stream.eatWhile(/[A-Za-z@]/)) {
			const name = stream.current().slice(1);
			const keyword = KEYWORDS.has(name);
			state.env = keyword && (name === 'begin' || name === 'end') ? 1 : 0;
			return keyword ? 'keyword' : 'variableName.function';
		}
		// A control symbol: \\, \,, \%, \{, \$ — one character, whatever it is.
		stream.next();
		state.env = 0;
		return 'variableName.function';
	}
	if (ch === '{' || ch === '}' || ch === '[' || ch === ']') {
		stream.next();
		if (ch === '{' && state.env === 1) state.env = 2;
		else state.env = 0;
		return 'bracket';
	}
	if (ch === '#') {
		stream.next();
		stream.eatWhile(/\d/);
		state.env = 0;
		return 'variableName.special';
	}
	if (ch === '$') {
		stream.next();
		stream.eat('$');
		state.env = 0;
		return 'operator';
	}
	if (/[A-Za-z]/.test(ch)) {
		// A word — with any digits glued on (`x2`, `node1`), so that a digit
		// inside a name is never a number.
		stream.eatWhile(/[A-Za-z0-9*]/);
		if (state.env === 2) {
			state.env = 0;
			return 'atom';
		}
		return null;
	}
	state.env = 0;
	if (stream.match(NUMBER)) return 'number';
	if (stream.match(OPERATOR)) return 'operator';
	stream.next();
	return null;
}

/** The StreamLanguage spec. */
export const texMode = {
	name: 'tex',
	startState: () => ({ env: 0 }),
	copyState: (state) => ({ env: state.env }),
	token: texToken,
	languageData: { commentTokens: { line: '%' } },
};
