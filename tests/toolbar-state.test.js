// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What the toolbar shows for a cursor (src/renderer/editor/toolbar/toolbar-state.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { noteMarkdown } from '../vendor/clew/renderer/editor/jmd/markdown-config.js';
import { liveModel } from '../vendor/clew/renderer/editor/live/model.js';
import { deriveState } from '../vendor/clew/renderer/editor/toolbar/toolbar-state.js';

function at(doc, marker, opts = {}) {
	const pos = doc.indexOf('|');
	const text = doc.replace('|', '');
	const state = EditorState.create({ doc: text, selection: { anchor: pos }, extensions: [noteMarkdown(opts)] });
	return deriveState(state, liveModel(state, opts), opts);
}

test('block types', () => {
	assert.equal(at('# Ti|tle\n').blockType, 'h1');
	assert.equal(at('### Ti|tle\n').blockType, 'h3');
	assert.equal(at('Plain |text.\n').blockType, 'paragraph');
	assert.equal(at('> quo|te\n').blockType, 'quote');
	assert.equal(at('> [!tip] Ti|tle\n> body\n').blockType, 'callout');
	assert.equal(at('> [!tip] Title\n> bo|dy\n').blockType, 'callout');
	assert.equal(at('- ite|m\n').blockType, 'bullet');
	assert.equal(at('1. ite|m\n').blockType, 'numbered');
	assert.equal(at('- [ ] ta|sk\n').blockType, 'task');
	assert.equal(at('```js\nco|de\n```\n').blockType, 'code');
	assert.equal(at('| a |\n|---|\n| b| |\n').blockType, 'table');
	assert.equal(at('$$\nx|\n$$\n').blockType, 'math');
});

test('an environment names itself', () => {
	const s = at(':::theorem\nBo|dy\n:::\n');
	assert.deepEqual([s.blockType, s.envName], ['env', 'theorem']);
});

test('inline styles under the cursor — innermost and outer both count', () => {
	assert.deepEqual([...at('*a /b|/ c*').inline].sort(), ['italic', 'strong']);
	assert.deepEqual([...at('A [[No|te]] and `x`').inline], ['wikilink']);
	assert.deepEqual([...at('plain| text').inline], []);
});

test('lists: inList and depth', () => {
	const s = at('- a\n  - b|\n');
	assert.deepEqual([s.inList, s.listDepth], [true, 2]);
	assert.equal(at('para|\n').inList, false);
});

test('normalSyntax flows through', () => {
	const s = at('a **b|** c', null, { normalSyntax: true });
	assert.equal(s.normalSyntax, true);
	assert.deepEqual([...s.inline], ['strong']);
});
