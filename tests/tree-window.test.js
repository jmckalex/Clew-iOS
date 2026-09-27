// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The file explorer's windowing arithmetic (renderer/lib/tree-window.js).
// The explorer draws the tree as a FLAT list — depth is padding, not
// nesting — so a row height buys an index for any scroll position, and the
// DOM cost becomes the size of the viewport instead of the size of the
// vault (20,503 rows and 23.5 s in the owner's ph341 vault, 2026-09-25).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenTree, visibleRange, scrollTopFor } from '../vendor/clew/renderer/lib/tree-window.js';

const folder = (name, path, children) => ({ type: 'folder', name, path, children });
const file = (name, path) => ({ type: 'file', name, path });

const tree = [
	folder('a', 'a', [file('a1.md', 'a/a1.md'), folder('deep', 'a/deep', [file('d.md', 'a/deep/d.md')])]),
	folder('b', 'b', [file('b1.md', 'b/b1.md')]),
	file('top.md', 'top.md'),
];

test('flatten: depth-first, folders before their children, depth counted', () => {
	assert.deepEqual(flattenTree(tree).map((r) => `${r.depth}:${r.entry.path}`), [
		'0:a', '1:a/a1.md', '1:a/deep', '2:a/deep/d.md', '0:b', '1:b/b1.md', '0:top.md',
	]);
});

test('flatten: a collapsed folder keeps its row and loses its children', () => {
	assert.deepEqual(flattenTree(tree, new Set(['a'])).map((r) => r.entry.path),
		['a', 'b', 'b/b1.md', 'top.md']);
	// …including a collapsed folder nested inside an open one.
	assert.deepEqual(flattenTree(tree, new Set(['a/deep'])).map((r) => r.entry.path),
		['a', 'a/a1.md', 'a/deep', 'b', 'b/b1.md', 'top.md']);
});

test('flatten: nothing to draw is not a crash', () => {
	assert.deepEqual(flattenTree(null), []);
	assert.deepEqual(flattenTree([]), []);
	assert.deepEqual(flattenTree([folder('empty', 'empty', undefined)]).map((r) => r.entry.path), ['empty']);
});

test('window: the viewport, plus overscan, clamped to the list', () => {
	const total = 20503; // the vault that earned this
	const at = (scrollTop) => visibleRange({ scrollTop, viewportHeight: 800, rowHeight: 20, total, overscan: 8 });
	assert.deepEqual(at(0), { first: 0, last: 49 });          // 41 visible + 8 below
	const mid = at(10000);
	assert.equal(mid.first, 500 - 8);
	assert.equal(mid.last, 500 + 41 + 8);
	assert.ok(mid.last - mid.first < 60, 'the window stays small however big the vault is');
	assert.deepEqual(at(20503 * 20), { first: total - 8, last: total }); // past the end
});

test('window: degenerate inputs draw nothing rather than everything', () => {
	assert.deepEqual(visibleRange({ scrollTop: 0, viewportHeight: 800, rowHeight: 0, total: 100 }), { first: 0, last: 0 });
	assert.deepEqual(visibleRange({ scrollTop: 0, viewportHeight: 800, rowHeight: 20, total: 0 }), { first: 0, last: 0 });
	// A negative scrollTop (rubber-banding at the top) must not read backwards.
	assert.deepEqual(visibleRange({ scrollTop: -120, viewportHeight: 100, rowHeight: 20, total: 50, overscan: 0 }),
		{ first: 0, last: 6 });
});

test('scrollTopFor: only scrolls when the row is actually outside', () => {
	const view = { scrollTop: 1000, viewportHeight: 400, rowHeight: 20 };
	assert.equal(scrollTopFor({ index: 55, ...view }), null);      // 1100–1120, inside
	assert.equal(scrollTopFor({ index: 10, ...view }), 200);       // above → align top
	assert.equal(scrollTopFor({ index: 200, ...view }), 4020 - 400); // below → align bottom
	assert.equal(scrollTopFor({ index: -1, ...view }), null);      // not in the list at all
});
