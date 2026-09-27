// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The editor's grammar over TeX-style sub/superscripts and block ids
// (src/renderer/editor/jmd/subsup-parser.js): the tree must say what the
// engine does — `H_2O` is a subscript, `_x_` is NOT emphasis, `^x^` is not
// GFM's superscript, and a trailing `^id` is a block id, not x-to-the-i.
// Parsed with editor.js's own configuration (jmd/markdown-config.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteMarkdown } from '../vendor/clew/renderer/editor/jmd/markdown-config.js';

const dialect = noteMarkdown().language.parser;
const normal = noteMarkdown({ normalSyntax: true }).language.parser;

/** The text of every node of `name`. */
function textsOf(doc, name, parser = dialect) {
	const out = [];
	parser.parse(doc).iterate({
		enter(n) { if (n.name === name) out.push(doc.slice(n.from, n.to)); },
	});
	return out;
}

test('H_2O: a one-character subscript, the underscore its mark', () => {
	const doc = 'Water is H_2O.\n';
	assert.deepEqual(textsOf(doc, 'JmdSubscript'), ['_2']);
	assert.deepEqual(textsOf(doc, 'JmdSubSupMark'), ['_']);
});

test('braced forms take the whole group; both braces are marks', () => {
	const doc = 'Growth x^{10} and a_{ij} here.\n';
	assert.deepEqual(textsOf(doc, 'JmdSuperscript'), ['^{10}']);
	assert.deepEqual(textsOf(doc, 'JmdSubscript'), ['_{ij}']);
	assert.deepEqual(textsOf(doc, 'JmdSubSupMark'), ['^{', '}', '_{', '}']);
});

test('_x_ is a subscript and a literal underscore, never emphasis', () => {
	const doc = 'Not _emphasis_ in this dialect.\n';
	assert.deepEqual(textsOf(doc, 'Emphasis'), []);
	assert.deepEqual(textsOf(doc, 'JmdSubscript'), ['_e']);
});

test('^x^ is superscript-x and a literal caret, not GFM superscript', () => {
	const doc = 'Try x^2^ here.\n';
	assert.deepEqual(textsOf(doc, 'Superscript'), []);
	assert.deepEqual(textsOf(doc, 'JmdSuperscript'), ['^2']);
});

test('__underline__ and *strong* are left to their own parsers', () => {
	const doc = 'An __underline__ and *strong* word.\n';
	assert.deepEqual(textsOf(doc, 'JmdSubscript'), []);
	assert.deepEqual(textsOf(doc, 'StrongEmphasis'), ['__underline__']);
	assert.deepEqual(textsOf(doc, 'Emphasis'), ['*strong*']);
});

test('~x~ stays lezer\'s (strike in this dialect); math and code are untouched', () => {
	const doc = 'A ~gone~ word, $x_1^2$ and `a_b` here.\n';
	assert.deepEqual(textsOf(doc, 'Subscript'), ['~gone~']);
	assert.deepEqual(textsOf(doc, 'JmdSubscript'), []);
	assert.deepEqual(textsOf(doc, 'JmdSuperscript'), []);
});

test('an escaped underscore is an escape', () => {
	const doc = 'snake\\_case stays literal.\n';
	assert.deepEqual(textsOf(doc, 'JmdSubscript'), []);
	assert.deepEqual(textsOf(doc, 'Escape'), ['\\_']);
});

test('a lone underscore or caret before a space is nothing', () => {
	const doc = 'a _ b ^ c _{unclosed\n';
	assert.deepEqual(textsOf(doc, 'JmdSubscript'), []);
	assert.deepEqual(textsOf(doc, 'JmdSuperscript'), []);
});

test('a trailing ^id is a block id', () => {
	const doc = 'Ideal observers are a convenience. ^ideal-obs\n';
	assert.deepEqual(textsOf(doc, 'JmdBlockId'), ['^ideal-obs']);
	assert.deepEqual(textsOf(doc, 'JmdSuperscript'), []);
});

test('a line that is only ^id is a block id, joined to the paragraph or alone', () => {
	assert.deepEqual(textsOf('Some prose.\n^abc-1\n', 'JmdBlockId'), ['^abc-1']);
	assert.deepEqual(textsOf('- item\n\n^abc-1\n', 'JmdBlockId'), ['^abc-1']);
});

test('x^2 mid-line, or glued to its word at the end, is a superscript', () => {
	assert.deepEqual(textsOf('So x^2 grows.\n', 'JmdBlockId'), []);
	assert.deepEqual(textsOf('So x^2 grows.\n', 'JmdSuperscript'), ['^2']);
	assert.deepEqual(textsOf('It ends in x^2\n', 'JmdBlockId'), []);
	assert.deepEqual(textsOf('A ^caret mid-sentence here.\n', 'JmdBlockId'), []);
});

test('under normalSyntax none of this applies: _x_ IS emphasis', () => {
	const doc = 'Plain _emphasis_ and x^2^ and H_2O.\n';
	assert.deepEqual(textsOf(doc, 'Emphasis', normal), ['_emphasis_']);
	assert.deepEqual(textsOf(doc, 'Superscript', normal), ['^2^']);
	assert.deepEqual(textsOf(doc, 'JmdSubscript', normal), []);
});
