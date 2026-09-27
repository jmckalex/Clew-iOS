// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The reveal rule (src/renderer/editor/live/reveal.js) over real models:
// every level, the boundaries, multiple ranges, line mode, and the rule
// that nested constructs are judged independently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, EditorSelection } from '@codemirror/state';
import { noteMarkdown } from '../vendor/clew/renderer/editor/jmd/markdown-config.js';
import { liveModel } from '../vendor/clew/renderer/editor/live/model.js';
import { revealed, revealSet } from '../vendor/clew/renderer/editor/live/reveal.js';

const DOC = [
	'# Head',            // 0
	'',
	'Say *a /b/ c* now.', // 8
	'',
	':::theorem',        // 28
	'Body *x* here.',    // 39
	':::',               // 54
	'',
	'$$',                // 59
	'E',
	'$$',
	'',
].join('\n');

const state = EditorState.create({ doc: DOC, extensions: [noteMarkdown()] });
const model = liveModel(state);
const find = (kind, n = 0) => model.filter((c) => c.kind === kind)[n];
const at = (pos) => [EditorSelection.cursor(pos)];
const pos = (s, k = 0) => { let p = -1; for (let i = 0; i <= k; i += 1) p = DOC.indexOf(s, p + 1); return p; };

test('inline: at from, at to (inclusive), inside; not one past', () => {
	const strong = find('strong');
	const from = pos('*a');
	const to = pos('c*') + 2;
	assert.equal(revealed(strong, at(from)), true);
	assert.equal(revealed(strong, at(to)), true);
	assert.equal(revealed(strong, at(from + 3)), true);
	assert.equal(revealed(strong, at(to + 1)), false);
	assert.equal(revealed(strong, at(from - 1)), false);
});

test('nesting: the outer revealed does not reveal the inner, nor the reverse', () => {
	const strong = find('strong');
	const italic = find('italic');
	assert.equal(revealed(strong, at(pos('a /'))), true);
	assert.equal(revealed(italic, at(pos('a /'))), false);
	assert.equal(revealed(italic, at(pos('b/'))), true);
	// Inside the italic is inside the strong too (it is its extent) — but
	// the italic touched does not force anything about constructs beyond.
	assert.equal(revealed(find('heading'), at(pos('b/'))), false);
});

test('line level: anywhere on the heading line', () => {
	const h = find('heading');
	assert.equal(revealed(h, at(pos('Head') + 2)), true);
	assert.equal(revealed(h, at(pos('Head') + 4)), true);
	assert.equal(revealed(h, at(pos('Say'))), false);
});

test('directive: opener and closer lines reveal; the body does not', () => {
	const d = find('directive');
	assert.equal(revealed(d, at(pos(':::theorem') + 5)), true);
	assert.equal(revealed(d, at(pos(':::', 1) + 1)), true);
	assert.equal(revealed(d, at(pos('Body') + 2)), false);
});

test('block: anywhere inside display math', () => {
	const m = find('math');
	assert.equal(revealed(m, at(pos('E'))), true);
	assert.equal(revealed(m, at(pos('$$'))), true);
	assert.equal(revealed(m, at(pos(':::', 1))), false);
});

test('a selection range touching the construct reveals it; several ranges all count', () => {
	const strong = find('strong');
	assert.equal(revealed(strong, [EditorSelection.range(pos('Say'), pos('*a') + 1)]), true);
	assert.equal(revealed(strong, [EditorSelection.range(pos('Head'), pos('Say'))]), false);
	assert.equal(revealed(strong, [EditorSelection.cursor(0), EditorSelection.cursor(pos('c*'))]), true);
});

test('line mode widens inline constructs to their lines', () => {
	const strong = find('strong');
	assert.equal(revealed(strong, at(pos('now')), 'construct'), false);
	assert.equal(revealed(strong, at(pos('now')), 'line'), true);
});

test('revealSet: the ids touched, and a signature that only changes when they do', () => {
	const a = revealSet(model, at(pos('Say')));
	const b = revealSet(model, at(pos('now')));
	assert.equal(a.signature, b.signature); // prose on the same line, nothing touched
	const c = revealSet(model, at(pos('*a')));
	assert.ok(c.ids.has(find('strong').id));
	assert.notEqual(c.signature, a.signature);
});

test('a pinned construct is never revealed (a table with a cell being edited in place)', () => {
	const math = find('math');
	const touching = at(pos('E'));
	assert.ok(revealSet(model, touching).ids.has(math.id));
	assert.ok(!revealSet(model, touching, 'construct', math.id).ids.has(math.id));
});
