// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The worker's `util` (src/worker/shims/util.js) answers as Node's does on the
// values book.js compares: configuration entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual as node } from 'node:util';
import { isDeepStrictEqual as shim } from '../src/worker/shims/util.js';

const cycle = () => { const o = { a: 1 }; o.self = o; return o; };

const pairs = [
	['a', 'a'], ['a', 'b'], [1, '1'], [NaN, NaN], [0, -0], [null, undefined], [true, true],
	[['a', 'b'], ['a', 'b']], [['a'], ['a', 'b']], [['1'], [1]],
	[{ a: ['x'] }, { a: ['x'] }], [{ a: 1 }, { a: 1, b: undefined }], [{ a: 1 }, { b: 1 }],
	[{ 'Document class': ['book'] }, { 'Document class': ['book'] }],
	[{ n: { m: [1, { k: 'v' }] } }, { n: { m: [1, { k: 'w' }] } }],
	[[], {}], [{}, Object.create(null)],
	[new Date(5), new Date(5)], [new Date(5), new Date(6)],
	[/a/g, /a/g], [/a/g, /a/i],
	[new Map([['k', [1]]]), new Map([['k', [1]]])], [new Map([['k', 1]]), new Map([['k', 2]])],
	[new Set([1, 2]), new Set([2, 1])], [new Set([1]), new Set([2])],
	[cycle(), cycle()],
];

test('isDeepStrictEqual agrees with Node on configuration-shaped values', () => {
	pairs.forEach(([a, b], i) => assert.equal(shim(a, b), node(a, b), `pair ${i}`));
});
