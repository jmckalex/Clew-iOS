// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Live edit writes properties through the editor as ONE change over the
// frontmatter block (src/renderer/editor/frontmatter-edit.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { propertiesChange } from '../vendor/clew/renderer/editor/frontmatter-edit.js';
import { applyProperties } from '../vendor/clew/shared/frontmatter.js';

const apply = (text, change) => EditorState.create({ doc: text }).update({ changes: change }).state.doc.toString();

test('the change produces exactly what the Properties panel would write', () => {
	const text = '---\nstatus: open\ntags: [a, b]\n---\n# Body\n';
	const entries = [{ key: 'status', value: 'done' }, { key: 'tags', value: ['a', 'b'] }];
	assert.equal(apply(text, propertiesChange(text, entries)), applyProperties(text, entries));
	assert.match(apply(text, propertiesChange(text, entries)), /^---\nstatus: done\n/);
});

test('it touches only the frontmatter range', () => {
	const text = '---\nx: 1\n---\nBody *stays*.\n';
	const change = propertiesChange(text, [{ key: 'x', value: 2 }]);
	assert.deepEqual([change.from, change.to], [0, '---\nx: 1\n---\n'.length]);
});

test('frontmatter beyond the subset is refused, not rewritten', () => {
	const text = '---\nnested: {a: 1}\n---\nBody\n';
	assert.equal(propertiesChange(text, [{ key: 'nested', value: 'x' }]), null);
});

test('a note without frontmatter gains one at the top', () => {
	const text = '# Title\n';
	assert.equal(apply(text, propertiesChange(text, [{ key: 'k', value: 'v' }])), '---\nk: v\n---\n# Title\n');
});
