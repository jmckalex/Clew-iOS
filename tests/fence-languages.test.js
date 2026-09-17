// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The editor's fence languages: the TeX and MetaPost stream modes, driven
// the way CodeMirror drives them (one StringStream per line, a token at a
// time), and the shared MetaPost vocabulary they and the engine read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StringStream } from '@codemirror/language';
import { texMode } from '../vendor/clew/renderer/editor/langs/tex-mode.js';
import { metapostMode } from '../vendor/clew/renderer/editor/langs/metapost-mode.js';
import {
	METAPOST_CONSTANTS, METAPOST_KEYWORDS, METAPOST_OPERATORS, METAPOST_TYPES,
} from '../vendor/clew/engine/metapost-words.js';

/** Every styled token of `text`, as [text, tag] pairs. */
function tokens(mode, text) {
	let state = mode.startState();
	const out = [];
	for (const line of text.split('\n')) {
		const stream = new StringStream(line, 4, 2);
		while (!stream.eol()) {
			stream.start = stream.pos;
			const tag = mode.token(stream, state);
			assert.ok(stream.pos > stream.start, `the tokenizer must advance at ${JSON.stringify(line.slice(stream.pos))}`);
			if (tag) out.push([stream.current(), tag]);
		}
		state = mode.copyState(state);
	}
	return out;
}
const withTag = (list, tag) => list.filter(([, t]) => t === tag).map(([s]) => s);

// ---- TeX ------------------------------------------------------------------

test('TeX: structure is a keyword, drawing is a function, the environment name an atom', () => {
	const t = tokens(texMode, '\\begin{tikzpicture}[scale=2]\n\\draw[->,thick] (0,0) -- (1.5cm,0) node[right] {$x^2$};\n\\end{tikzpicture}');
	assert.deepEqual(withTag(t, 'keyword'), ['\\begin', '\\end']);
	assert.deepEqual(withTag(t, 'atom'), ['tikzpicture', 'tikzpicture']);
	assert.deepEqual(withTag(t, 'variableName.function'), ['\\draw'], 'node[right] is a word, not a control sequence');
	// …the last 2 being the superscript in the label's math.
	assert.deepEqual(withTag(t, 'number'), ['2', '0', '0', '1.5cm', '0', '2']);
	assert.ok(withTag(t, 'operator').includes('--'), 'the path operator');
	assert.ok(withTag(t, 'operator').includes('->'), 'the arrow tip');
	assert.ok(withTag(t, 'operator').includes('^'), 'a superscript');
	assert.deepEqual(withTag(t, 'bracket').join(''), '{}[][][]{}{}');
});

test('TeX: a comment runs to the end of the line, but \\% is not one', () => {
	const t = tokens(texMode, '\\draw (0,0); % the origin\n50\\% of it');
	assert.deepEqual(withTag(t, 'comment'), ['% the origin']);
	assert.ok(withTag(t, 'variableName.function').includes('\\%'));
});

test('TeX: macro parameters, control symbols and digits inside words', () => {
	const t = tokens(texMode, '\\newcommand{\\pt}[2]{#1\\\\#2 node1 x2}');
	assert.deepEqual(withTag(t, 'variableName.special'), ['#1', '#2']);
	assert.ok(withTag(t, 'variableName.function').includes('\\\\'), 'the line break');
	assert.deepEqual(withTag(t, 'number'), ['2'], 'node1 and x2 are words, not numbers');
	assert.deepEqual(withTag(t, 'keyword'), ['\\newcommand']);
});

test('TeX: the environment-name state does not leak past its braces', () => {
	const t = tokens(texMode, '\\begin{axis} x {y}');
	assert.deepEqual(withTag(t, 'atom'), ['axis']);
});

// ---- MetaPost -------------------------------------------------------------

test('MetaPost: the four word classes, numbers with units, and the assignment operator', () => {
	const t = tokens(metapostMode, 'pair a; a := (2cm, 1.5);\ndraw fullcircle scaled 60 withcolor red;');
	assert.deepEqual(withTag(t, 'typeName'), ['pair']);
	assert.deepEqual(withTag(t, 'keyword'), ['draw']);
	assert.deepEqual(withTag(t, 'atom'), ['cm', 'fullcircle', 'red']);
	assert.deepEqual(withTag(t, 'operatorKeyword'), ['scaled', 'withcolor']);
	assert.deepEqual(withTag(t, 'number'), ['2', '1.5', '60']);
	assert.deepEqual(withTag(t, 'variableName'), ['a', 'a']);
	assert.ok(withTag(t, 'operator').includes(':='));
});

test('MetaPost: variables with subscripts, suffix parameters, strings and comments', () => {
	const t = tokens(metapostMode, 'z1 = (0,0); p12 := z1 -- z2; % solved\nvardef f@# = @#.c enddef; message "a % b";');
	assert.deepEqual(withTag(t, 'variableName'), ['z1', 'p12', 'z1', 'z2', 'f', 'c']);
	assert.deepEqual(withTag(t, 'variableName.special'), ['@#', '@#']);
	assert.deepEqual(withTag(t, 'comment'), ['% solved']);
	assert.deepEqual(withTag(t, 'string'), ['"a % b"'], 'a % inside a string is not a comment');
	assert.deepEqual(withTag(t, 'keyword'), ['vardef', 'enddef', 'message']);
});

test('MetaPost: btex … etex hands the label to the TeX mode and comes back', () => {
	const t = tokens(metapostMode, 'label.top(btex $\\alpha_1$ etex, origin);\ndraw z1;');
	assert.deepEqual(withTag(t, 'keyword'), ['label', 'btex', 'etex', 'draw']);
	assert.ok(withTag(t, 'variableName.function').includes('\\alpha'), 'TeX inside the label');
	assert.deepEqual(withTag(t, 'atom'), ['origin']);
	assert.ok(withTag(t, 'variableName').includes('z1'), 'MetaPost again after etex');
});

test('MetaPost: a verbatimtex block can span lines', () => {
	const t = tokens(metapostMode, 'verbatimtex\n\\documentclass{article}\n\\begin{document}\netex\nbeginfig(1);');
	assert.deepEqual(withTag(t, 'keyword'), ['verbatimtex', '\\documentclass', '\\begin', 'etex', 'beginfig']);
	assert.deepEqual(withTag(t, 'atom'), ['document']);
});

test('the MetaPost vocabulary is one word, one class', () => {
	const all = [...METAPOST_KEYWORDS, ...METAPOST_TYPES, ...METAPOST_CONSTANTS, ...METAPOST_OPERATORS];
	assert.equal(new Set(all).size, all.length, 'no word is in two lists');
	for (const word of all) assert.match(word, /^[A-Za-z_]+$/, `${word} is a plain word`);
});
