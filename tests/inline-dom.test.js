// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Live edit's inline subset renderer (src/renderer/editor/live/inline-dom.js)
// pinned as a token tree: the kinds it knows, nesting, and that anything
// else comes out as its source text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { noteMarkdown } from '../vendor/clew/renderer/editor/jmd/markdown-config.js';
import { liveModel } from '../vendor/clew/renderer/editor/live/model.js';
import { inlineTokens } from '../vendor/clew/renderer/editor/live/inline-dom.js';

function tokens(text) {
	const state = EditorState.create({ doc: text, extensions: [noteMarkdown()] });
	return inlineTokens(state.doc, 0, text.length, liveModel(state));
}
/** A compact string form: kind(children) / "text". */
const show = (ts) => ts.map((t) => {
	if (t.type === 'text') return JSON.stringify(t.text);
	if (t.type === 'break') return 'BR';
	if (t.children) return `${t.type}(${show(t.children)})`;
	return `${t.type}[${t.text ?? t.tex ?? t.name}]`;
}).join(' ');

test('the dialect\'s styles become their elements, delimiters gone', () => {
	assert.equal(show(tokens('a *b* **c** /d/ __e__ ==f== ~g~ H_2O x^{10}')),
		'"a " strong("b") " " intense("c") " " italic("d") " " underline("e") " " highlight("f") " " strike("g") " H" sub("2") "O x" sup("10")');
});

test('nesting: strong holding italic', () => {
	assert.equal(show(tokens('*a /b/ c*')), 'strong("a " italic("b") " c")');
});

test('code, math, links, wikilinks, tags', () => {
	assert.equal(show(tokens('`x` $y$ [t](u) [[N|shown]] #tag')),
		'code[x] " " math[y] " " link("t") " " wikilink("shown") " " tag[#tag]');
	const link = tokens('[t](http://x.org)')[0];
	assert.equal(link.href, 'http://x.org');
	assert.equal(tokens('[[Note#Part]]')[0].target, 'Note#Part');
});

test('escapes drop the backslash', () => {
	assert.equal(show(tokens('a \\* b')), '"a " "*" " b"');
});

test('what it does not render comes out as source', () => {
	assert.equal(show(tokens('A \\cite{k} and [fn: note] here')), '"A " "\\\\cite{k}" " and " "[fn: note]" " here"');
});

test('a literal <br> is a line break (a table cell writes its breaks so)', () => {
	assert.equal(show(tokens('one<br>two<BR/>three<br />four')), '"one" BR "two" BR "three" BR "four"');
	assert.equal(show(tokens('*a<br>b*')), 'strong("a" BR "b")');
});

test('an escaped pipe shows as a pipe', () => {
	assert.equal(show(tokens('a\\|b')), '"a" "|" "b"');
});

test('references and labels: the number the engine prints, the key for a label', () => {
	const doc = '@begin(theorem){#t}\nx\n@end(theorem)\n\nSee @ref[t], :cref[t], @ref[gone] and @label[here].';
	const from = doc.indexOf('See');
	const state = EditorState.create({ doc, extensions: [noteMarkdown()] });
	const ts = inlineTokens(state.doc, from, doc.length, liveModel(state));
	assert.equal(show(ts), '"See " ref[1] ", " ref[theorem 1] ", " ref[??] " and " label[⚓ here] "."');
	assert.equal(ts.find((t) => t.key === 'gone').state, 'missing');
});
