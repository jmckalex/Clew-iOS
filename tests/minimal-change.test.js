// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// A reload from disk as the smallest change (src/renderer/editor/minimal-change.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minimalChange } from '../vendor/clew/renderer/editor/minimal-change.js';

const apply = (s, c) => (c ? s.slice(0, c.from) + c.insert + s.slice(c.to) : s);

test('equal texts need no change', () => {
	assert.equal(minimalChange('same', 'same'), null);
});

test('only the middle is replaced', () => {
	assert.deepEqual(minimalChange('| a1 | b1 | c1 |', '| a1 | NEW | c1 |'), { from: 7, to: 9, insert: 'NEW' });
});

test('insertions, deletions, and the edges', () => {
	for (const [a, b] of [['abc', 'abXc'], ['abXc', 'abc'], ['', 'x'], ['x', ''], ['abc', 'xbc'], ['abc', 'abx'], ['aaa', 'aaaa'], ['abab', 'ab']]) {
		assert.equal(apply(a, minimalChange(a, b)), b, `${a} → ${b}`);
	}
});
