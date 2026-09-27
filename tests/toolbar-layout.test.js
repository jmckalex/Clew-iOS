// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Which toolbar groups fit (src/renderer/editor/toolbar/toolbar-layout.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutGroups } from '../vendor/clew/renderer/editor/toolbar/toolbar-layout.js';

const GROUPS = [
	{ id: 'history', priority: 10 },
	{ id: 'block', priority: 90 },
	{ id: 'inline', priority: 100 },
	{ id: 'list', priority: 80 },
	{ id: 'insert', priority: 70 },
	{ id: 'table-tools', priority: 60, when: (s) => s.inTable },
	{ id: 'mode', priority: Infinity },
];
const W = { history: 60, block: 130, inline: 300, list: 150, insert: 280, 'table-tools': 60, mode: 100 };
const opts = { separator: 10, overflowButton: 30 };

test('everything fits: nothing overflows, no button reserved', () => {
	// 60+130+300+150+280+100 = 1020, + 5 separators = 1070
	assert.deepEqual(layoutGroups(GROUPS, W, 1070, opts), {
		visible: ['history', 'block', 'inline', 'list', 'insert', 'mode'], overflow: [],
	});
});

test('too narrow: lowest priorities go first, spec order kept', () => {
	const r = layoutGroups(GROUPS, W, 800, opts);
	assert.deepEqual(r.visible, ['block', 'inline', 'list', 'mode']);
	assert.deepEqual(r.overflow, ['history', 'insert']);
});

test('the mode switch never drops, however narrow', () => {
	assert.deepEqual(layoutGroups(GROUPS, W, 50, opts).visible, ['mode']);
});

test('a group whose when() is false is not laid out at all', () => {
	assert.ok(!layoutGroups(GROUPS, W, 2000, opts).visible.includes('table-tools'));
	assert.ok(layoutGroups(GROUPS, W, 2000, { ...opts, state: { inTable: true } }).visible.includes('table-tools'));
});

test('the overflow button\'s width counts only when something overflows', () => {
	// Exactly the full width fits without the button…
	assert.equal(layoutGroups(GROUPS, W, 1070, opts).overflow.length, 0);
	// …one pixel less and the button's 30 + a separator must be found too.
	assert.deepEqual(layoutGroups(GROUPS, W, 1069, opts).overflow, ['history']);
});
