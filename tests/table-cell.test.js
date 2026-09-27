// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// In-place table editing's arithmetic (src/renderer/editor/live/table-cell-model.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Text, ChangeSet } from '@codemirror/state';
import {
	cellRanges, cellAt, neighbour, escapeCellText, forwardChanges, isExtendedTable, pipePositions,
} from '../vendor/clew/renderer/editor/live/table-cell-model.js';

const DOC = Text.of(['Intro', '| Name | Value |', '| --- | ---: |', '| one | 1 |', '|  | \\| pipe |', 'After']);
const R = cellRanges(DOC, 2, 5);
const text = (r) => DOC.sliceString(r.from, r.to);

test('cell ranges: content trimmed, delimiter skipped, logical rows', () => {
	assert.equal(R.rows.length, 3);
	assert.equal(R.delimiterLine, 3);
	assert.deepEqual(R.rows.map((row) => row.map(text)), [['Name', 'Value'], ['one', '1'], ['', '\\| pipe']]);
});

test('an empty cell is the empty range just after its first space', () => {
	const empty = R.rows[2][0];
	assert.equal(empty.from, empty.to);
	assert.equal(DOC.sliceString(empty.from - 2, empty.from), '| ');
});

test('an escaped pipe is part of the cell, not a boundary', () => {
	assert.deepEqual(pipePositions('| a \\| b | c |'), [0, 9, 13]);
});

test('cellAt: boundaries inclusive; the padding and pipes are no cell', () => {
	const one = R.rows[1][0];
	assert.deepEqual(cellAt(R, one.from), { row: 1, col: 0 });
	assert.deepEqual(cellAt(R, one.to), { row: 1, col: 0 });
	assert.equal(cellAt(R, DOC.line(4).from), null); // the leading pipe
	assert.equal(cellAt(R, 0), null);
});

test('neighbours wrap across rows and report the table\'s edges', () => {
	assert.deepEqual(neighbour(R, 1, 1, 'right'), { row: 2, col: 0 });
	assert.deepEqual(neighbour(R, 1, 0, 'left'), { row: 0, col: 1 });
	assert.deepEqual(neighbour(R, 0, 0, 'left'), { edge: 'start' });
	assert.deepEqual(neighbour(R, 2, 1, 'right'), { edge: 'end' });
	assert.deepEqual(neighbour(R, 0, 1, 'up'), { edge: 'above' });
	assert.deepEqual(neighbour(R, 2, 0, 'down'), { edge: 'below' });
	assert.deepEqual(neighbour(R, 1, 1, 'up'), { row: 0, col: 1 });
});

test('escapeCellText: bare pipes escaped, escaped ones and escaped backslashes respected', () => {
	assert.equal(escapeCellText('a|b'), 'a\\|b');
	assert.equal(escapeCellText('a\\|b'), 'a\\|b');
	assert.equal(escapeCellText('|', '\\'), '|'); // typed right after a backslash
	assert.equal(escapeCellText('\\\\|'), '\\\\\\|'); // an escaped backslash, then a bare pipe
	assert.equal(escapeCellText('[[Note|alias]]'), '[[Note\\|alias]]');
});

test('escapeCellText: newlines (LF, CRLF, CR) become <br>; tabs stay', () => {
	assert.equal(escapeCellText('one\ntwo\r\nthree\rfour\tfive'), 'one<br>two<br>three<br>four\tfive');
});

test('forwardChanges maps the cell\'s changes onto the note', () => {
	const changes = ChangeSet.of([{ from: 1, to: 2, insert: 'XY' }, { from: 3, insert: '!' }], 3);
	assert.deepEqual(forwardChanges(40, changes), [
		{ from: 41, to: 42, insert: 'XY' },
		{ from: 43, to: 43, insert: '!' },
	]);
});

test('extended tables (colspan, rowspan, widths) are recognised', () => {
	assert.equal(isExtendedTable(['| a | b |', '| --- | --- |', '| 1 | 2 |']), false);
	assert.equal(isExtendedTable(['| a | b |', '| --- | --- |', '| wide ||']), true);
	assert.equal(isExtendedTable(['| a | b |', '| --- | --- |', '| ^ | 2 |']), true);
	assert.equal(isExtendedTable(['| a | b |', '|---30%---|---|', '| 1 | 2 |']), true);
	assert.equal(isExtendedTable(['|| empty first |', '| --- |']), false);
	assert.equal(isExtendedTable(['| x^2 | b |', '| --- | --- |']), false);
});
