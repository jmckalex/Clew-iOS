// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The editor's markdown grammar over jmarkdown's inline footnotes: the
// brackets of `[^label: …]` / `[fn: …]` belong to the dialect, not to the
// link parser (src/renderer/editor/jmd/footnote-parser.js). Stock markdown
// reads them as a shortcut-reference link, which is what used to colour a
// note's body — and an inline link cannot cross a blank line, so a
// multi-paragraph note lost its highlighting at the break.
//
// Parsed exactly as editor.js configures it, so what these tests see is
// what the editor sees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteMarkdown } from '../vendor/clew/renderer/editor/jmd/markdown-config.js';

const parser = noteMarkdown().language.parser;

/** Every node in the tree, as `{name, from, to, text}`. */
function nodes(doc) {
	const out = [];
	parser.parse(doc).iterate({
		enter(n) { out.push({ name: n.name, from: n.from, to: n.to, text: doc.slice(n.from, n.to) }); },
	});
	return out;
}

/** The text of every node of `name`. */
function textsOf(doc, name) {
	return nodes(doc).filter((n) => n.name === name).map((n) => n.text);
}

test('a footnote is not a link: both brackets belong to the dialect', () => {
	const doc = 'A claim[^n: the evidence.] and on.\n';
	assert.deepEqual(textsOf(doc, 'JmdFootnoteMark'), ['[^n:', ']']);
	assert.deepEqual(textsOf(doc, 'Link'), []);
});

test('the anonymous and grouped openers too', () => {
	const doc = 'A[fn: one.] B[fn(asides): two.] C[^lab(asides): three.]\n';
	assert.deepEqual(
		textsOf(doc, 'JmdFootnoteMark'),
		['[fn:', ']', '[fn(asides):', ']', '[^lab(asides):', ']']
	);
	assert.deepEqual(textsOf(doc, 'Link'), []);
});

test('a multi-paragraph note keeps its brackets a pair', () => {
	// The closer is in a block of its own — an inline parser never sees
	// the opener from there, so a `]` closing nothing is claimed too.
	// Bracket matching pairs two brackets only when the tree gives them
	// the same node type; without this every note wears a red bracket.
	const doc = 'Text[^n: first paragraph.\n\n\tsecond paragraph.] after.\n';
	assert.deepEqual(textsOf(doc, 'JmdFootnoteMark'), ['[^n:', ']']);
	assert.deepEqual(textsOf(doc, 'Link'), []);
});

test('a note body is still ordinary markdown', () => {
	const doc = 'Text[^n: with *emphasis* inside.] after.\n';
	assert.deepEqual(textsOf(doc, 'Emphasis'), ['*emphasis*']);
});

test('a real link inside a note body is still a link', () => {
	const doc = 'Text[^n: see [the paper](https://example.org) for more.] after.\n';
	assert.deepEqual(textsOf(doc, 'Link'), ['[the paper](https://example.org)']);
	assert.deepEqual(textsOf(doc, 'JmdFootnoteMark'), ['[^n:', ']']);
});

test('an ordinary link is untouched', () => {
	const doc = 'A real [link](https://example.org) and a [shortcut] one.\n';
	assert.deepEqual(textsOf(doc, 'JmdFootnoteMark'), []);
	assert.deepEqual(
		textsOf(doc, 'Link'),
		['[link](https://example.org)', '[shortcut]']
	);
});

test('a reference-style footnote marker is not an inline footnote', () => {
	// `[^1]` and its `[^1]: …` definition are the other footnote syntax
	// (marked-footnote); no colon follows the label, so the opener does
	// not match and the grammar reads them as it always did.
	const doc = 'A claim.[^1]\n\n[^1]: The note.\n';
	assert.deepEqual(textsOf(doc, 'JmdFootnoteMark'), []);
	assert.ok(textsOf(doc, 'Link').includes('[^1]'));
});

test('a task list keeps its checkbox', () => {
	const doc = '- [ ] undone\n- [x] done\n';
	assert.deepEqual(textsOf(doc, 'JmdFootnoteMark'), []);
	assert.deepEqual(textsOf(doc, 'TaskMarker'), ['[ ]', '[x]']);
});

test('a wikilink is left to the overlay, brackets and all', () => {
	const doc = 'See [[Target|alias]] and ![[Embed]].\n';
	assert.deepEqual(textsOf(doc, 'JmdFootnoteMark'), []);
});

test('an escaped bracket does not close a note', () => {
	const doc = 'Text[^n: a \\] escaped bracket.] after.\n';
	assert.deepEqual(textsOf(doc, 'JmdFootnoteMark'), ['[^n:', ']']);
});
