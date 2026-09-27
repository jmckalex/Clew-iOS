// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Toggling inline markup (src/renderer/editor/toggle-wrap.js): wrap, unwrap
// around a selection, and — the toolbar's case — unwrap from a bare cursor
// INSIDE a construct, found through the construct model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, EditorSelection } from '@codemirror/state';
import { noteMarkdown } from '../vendor/clew/renderer/editor/jmd/markdown-config.js';
import { toggleWrapSpec } from '../vendor/clew/renderer/editor/toggle-wrap.js';

function run(doc, selection, before, after, opts) {
	const state = EditorState.create({ doc, selection, extensions: [noteMarkdown(opts), EditorState.allowMultipleSelections.of(true)] });
	const next = state.update(toggleWrapSpec(state, before, after, opts)).state;
	return { doc: next.doc.toString(), sel: next.selection.ranges.map((r) => [r.from, r.to]) };
}
const cursor = (pos) => EditorSelection.single(pos);
const range = (a, b) => EditorSelection.single(a, b);

test('wraps a selection', () => {
	assert.deepEqual(run('say word now', range(4, 8), '*').doc, 'say *word* now');
});

test('unwraps a selection whose markers sit just outside it, or inside it', () => {
	assert.equal(run('say *word* now', range(5, 9), '*').doc, 'say word now');
	assert.equal(run('say *word* now', range(4, 10), '*').doc, 'say word now');
});

test('a bare cursor INSIDE *word* unwraps it (the toolbar case)', () => {
	const r = run('say *word* now', cursor(6), '*');
	assert.equal(r.doc, 'say word now');
	assert.deepEqual(r.sel, [[5, 5]]); // the cursor stays on the same letter
});

test('innermost of the kind wins; other kinds are left alone', () => {
	assert.equal(run('*a /b/ c*', cursor(4), '/').doc, '*a b c*');
	assert.equal(run('*a /b/ c*', cursor(4), '*').doc, 'a /b/ c');
});

test('a cursor outside any construct wraps an empty pair to type into', () => {
	const r = run('say word now', cursor(3), '*');
	assert.equal(r.doc, 'say** word now');
	assert.deepEqual(r.sel, [[4, 4]]);
});

test('braced sub/superscripts and math unwrap from inside', () => {
	assert.equal(run('H_{2}O', cursor(3), '_{', '}').doc, 'H2O');
	assert.equal(run('a $x^2$ b', cursor(4), '$').doc, 'a x^2 b');
});

test('multiple ranges each toggle', () => {
	assert.equal(run('one two', EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 7)]), '==').doc, '==one== ==two==');
});

test('under normalSyntax a cursor inside **bold** unwraps it', () => {
	assert.equal(run('a **bold** b', cursor(5), '**', '**', { normalSyntax: true }).doc, 'a bold b');
});
