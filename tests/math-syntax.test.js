// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The editor's markdown grammar over math: a formula belongs to the
// dialect whole, and none of markdown's inline parsers may reach inside it
// (src/renderer/editor/jmd/math-parser.js). Stock markdown pairs the `*` in
// `$R^*$` with the next one in the paragraph — usually inside a second
// formula — and bolds everything between.
//
// Parsed exactly as editor.js configures it, so what these tests see is
// what the editor sees. What counts as a segment is math-segments.js'
// business and is tested there; these tests are about the grammar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteMarkdown } from '../vendor/clew/renderer/editor/jmd/markdown-config.js';

const parser = noteMarkdown().language.parser;

/** The text of every node of `name`. */
function textsOf(doc, name) {
	const out = [];
	parser.parse(doc).iterate({
		enter(n) { if (n.name === name) out.push(doc.slice(n.from, n.to)); },
	});
	return out;
}

test('an asterisk inside math is not an emphasis delimiter', () => {
	// The owner's report: this bolded the sentence between the formulae.
	const doc = 'the notation $R^*$ is incomplete, we need $R_w^*(S)$ instead\n';
	assert.deepEqual(textsOf(doc, 'JmdMath'), ['$R^*$', '$R_w^*(S)$']);
	assert.deepEqual(textsOf(doc, 'Emphasis'), []);
	assert.deepEqual(textsOf(doc, 'StrongEmphasis'), []);
});

test('emphasis outside math is untouched', () => {
	const doc = 'this *is strong* and this **is intense** in prose\n';
	assert.deepEqual(textsOf(doc, 'JmdMath'), []);
	assert.deepEqual(textsOf(doc, 'Emphasis'), ['*is strong*']);
	assert.deepEqual(textsOf(doc, 'StrongEmphasis'), ['**is intense**']);
});

test('all four delimiter pairs are claimed', () => {
	const doc = 'a $x$ and $$y$$ and \\(z\\) and \\[w\\] here\n';
	assert.deepEqual(textsOf(doc, 'JmdMath'), ['$x$', '$$y$$', '\\(z\\)', '\\[w\\]']);
});

test('brackets and underscores inside math build nothing', () => {
	const doc = 'see $[a](b)$ and $x_1 \\cdot y_2$ in prose\n';
	assert.deepEqual(textsOf(doc, 'JmdMath'), ['$[a](b)$', '$x_1 \\cdot y_2$']);
	assert.deepEqual(textsOf(doc, 'Link'), []);
});

test('a dollar inside inline code is not math', () => {
	// InlineCode parses first, so the `$` is never offered to us.
	const doc = 'the shell variable `$PATH` and `$HOME` are paths\n';
	assert.deepEqual(textsOf(doc, 'JmdMath'), []);
	assert.equal(textsOf(doc, 'InlineCode').length, 2);
});

test('an escaped dollar is not a delimiter', () => {
	const doc = 'it costs \\$5 and \\$10 today\n';
	assert.deepEqual(textsOf(doc, 'JmdMath'), []);
});

test('two prices DO pair — the documented cost of `$…$`', () => {
	// Not this parser's doing: the scanner has always read this as math
	// (the overlay paints it, and MathJax typesets it in reading mode).
	// Pinned so the behaviour stays the same in the grammar and the faces;
	// the escape is `\$`, as the test above.
	const doc = 'it costs $5 and $10 today\n';
	assert.deepEqual(textsOf(doc, 'JmdMath'), ['$5 and $']);
});

test('a segment never crosses a paragraph break', () => {
	const doc = 'crossing $a\n\nb$ blank line\n';
	assert.deepEqual(textsOf(doc, 'JmdMath'), []);
});

test('a formula inside a footnote body keeps both claims', () => {
	const doc = 'Text[^n: the value $R^*$ matters here.] after.\n';
	assert.deepEqual(textsOf(doc, 'JmdMath'), ['$R^*$']);
	assert.deepEqual(textsOf(doc, 'JmdFootnoteMark'), ['[^n:', ']']);
});

test('display math on its own is one node', () => {
	const doc = '# H\n\n$$\nR^* = \\{x : x \\in S\\}\n$$\n\nAfter.\n';
	assert.deepEqual(textsOf(doc, 'JmdMath'), ['$$\nR^* = \\{x : x \\in S\\}\n$$']);
});
