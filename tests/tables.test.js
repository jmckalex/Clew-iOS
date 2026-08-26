// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitRow, tableAround, formatTable, displayWidth } from '../vendor/clew/renderer/editor/tables.js';

const lines = (s) => s.split('\n');

test('splitRow trims cells and respects escaped pipes', () => {
	assert.deepEqual(splitRow('| a | b |'), ['a', 'b']);
	assert.deepEqual(splitRow('|a|b|'), ['a', 'b']);
	assert.deepEqual(splitRow('| a \\| b | c |'), ['a \\| b', 'c']);
	assert.deepEqual(splitRow('| trailing space   |  x |'), ['trailing space', 'x']);
});

test('tableAround finds the block and its alignments', () => {
	const doc = lines([
		'prose above',
		'| Name | Qty | Cost |',
		'| :--- | --: | :--: |',
		'| Nail | 100 | 2.50 |',
		'prose below',
	].join('\n'));
	const t = tableAround(doc, 2);
	assert.equal(t.from, 1);
	assert.equal(t.to, 3);
	assert.equal(t.delimiterRow, 1);
	assert.deepEqual(t.align, ['left', 'right', 'center']);
	assert.equal(tableAround(doc, 0), null, 'prose is not a table');
	assert.equal(tableAround(doc, 4), null);
});

test('formatTable lines the pipes up and honours alignment', () => {
	const t = tableAround(lines([
		'| Name | Qty | Cost |',
		'| :- | --: | :-: |',
		'| A very long name | 1 | 2 |',
		'| B | 1000 | 30 |',
	].join('\n')), 0);
	assert.deepEqual(formatTable(t), [
		// The header is aligned by the column spec too, like every other cell.
		'| Name             |  Qty | Cost |',
		'| :--------------- | ---: | :--: |',
		'| A very long name |    1 |  2   |',
		'| B                | 1000 |  30  |',
	]);
});

test('an unaligned table gets left-aligned columns and a plain delimiter', () => {
	const t = tableAround(lines('| a | b |\n| --- | --- |\n| longer | x |'), 0);
	assert.deepEqual(formatTable(t), [
		'| a      | b   |',
		'| ------ | --- |',
		'| longer | x   |',
	]);
});

test('ragged rows are squared off rather than refused', () => {
	// This is the half-typed state the feature exists to help with.
	const t = tableAround(lines('| a | b | c |\n| --- | --- | --- |\n| x |'), 0);
	const out = formatTable(t);
	assert.equal(out.length, 3);
	assert.ok(out[2].startsWith('| x '), out[2]);
	assert.equal(splitRow(out[2]).length, 3, 'short row padded to full width');
});

test('a row with MORE cells widens the table', () => {
	const t = tableAround(lines('| a | b |\n| --- | --- |\n| x | y | z |'), 0);
	const out = formatTable(t);
	assert.equal(splitRow(out[0]).length, 3);
	assert.equal(splitRow(out[1]).length, 3, 'the delimiter grows too, or the table stops parsing');
});

test('formatting is idempotent', () => {
	const src = '| Name | Qty |\n| :--- | ---: |\n| Nail | 100 |';
	const once = formatTable(tableAround(lines(src), 0)).join('\n');
	const twice = formatTable(tableAround(lines(once), 0)).join('\n');
	assert.equal(twice, once);
});

test('CJK and emoji count as two columns wide', () => {
	assert.equal(displayWidth('abc'), 3);
	assert.equal(displayWidth('日本語'), 6);
	assert.equal(displayWidth('a日b'), 4);
	// A table mixing scripts still lines up for a human reading it.
	const t = tableAround(lines('| x | y |\n| --- | --- |\n| 日本語 | ab |'), 0);
	const out = formatTable(t);
	assert.equal(displayWidth(out[0]), displayWidth(out[2]),
		`rows should be the same visible width:\n${out.join('\n')}`);
});

test('escaped pipes survive a reformat', () => {
	const t = tableAround(lines('| a \\| b | c |\n| --- | --- |\n| d | e |'), 0);
	const out = formatTable(t);
	assert.ok(out[0].includes('a \\| b'));
	assert.equal(splitRow(out[0]).length, 2, 'the escaped pipe did not split the cell');
});
