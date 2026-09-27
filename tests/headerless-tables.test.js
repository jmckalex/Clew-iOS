// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The engine's headerless tables in live edit (tables.js#headerlessTables,
// live/model.js#pipeTables): separator-first and pure-pipe tables, which
// lezer parses as paragraphs. The parity test at the bottom lexes the same
// documents with the ENGINE's own table extension and asserts the same
// lines become tables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EditorState, Text } from '@codemirror/state';
import {
	headerlessTables, isRenderedTable, tableAround, formatTable,
	insertRow, deleteRow, moveRow, setAlignment,
} from '../vendor/clew/renderer/editor/tables.js';
import { cellRanges } from '../vendor/clew/renderer/editor/live/table-cell-model.js';
import { noteMarkdown } from '../vendor/clew/renderer/editor/jmd/markdown-config.js';
import { liveModel } from '../vendor/clew/renderer/editor/live/model.js';

const GRADES = [
	'The categories:',
	'',
	'| *Description* | *Grade* |',
	'| Lively and perceptive | 80 |',
	'| Reasonable | 65 |',
	'',
	'After.',
].join('\n');

test('pure pipes: the run of pipe rows is a table', () => {
	assert.deepEqual(headerlessTables(['| a | b |', '| c | d |']), [{ first: 0, last: 1, form: 'pipes' }]);
	// One row is enough, as in the engine.
	assert.deepEqual(headerlessTables(['| hello |']), [{ first: 0, last: 0, form: 'pipes' }]);
	// Prose around it (a paragraph the table interrupts) is not part of it.
	assert.deepEqual(headerlessTables(['prose', '| a | b |', 'more prose']), [{ first: 1, last: 1, form: 'pipes' }]);
});

test('pure pipes: both end pipes are required', () => {
	assert.deepEqual(headerlessTables(['a | b', 'c | d']), []);
	assert.deepEqual(headerlessTables(['| a | b', '| c | d']), []);
});

test('a separator in or after the run makes it GFM, never form B', () => {
	assert.deepEqual(headerlessTables(['| h | i |', '| --- | --- |', '| a | b |']), []);
	assert.deepEqual(headerlessTables(['| h | i |', '--- | ---']), []);
});

test('separator-first: alignment row, then the body to the paragraph end', () => {
	assert.deepEqual(headerlessTables(['|:---|---:|', '| L | R |', '| l | r |']),
		[{ first: 0, last: 2, form: 'separator' }]);
	// The engine's body takes a prose line too.
	assert.deepEqual(headerlessTables(['|:---|---:|', '| L | R |', 'prose']),
		[{ first: 0, last: 2, form: 'separator' }]);
	// Column counts must agree, and a body is required.
	assert.deepEqual(headerlessTables(['|---|---|', '| a |']), []);
	assert.deepEqual(headerlessTables(['|---|---|']), []);
	// A pipe on the line above: that line is a GFM header, not prose.
	assert.deepEqual(headerlessTables(['a | b', '|---|---|', '| c | d |']), []);
});

test('a null line bounds a run and holds no row', () => {
	assert.deepEqual(headerlessTables([null, '| a |', null, '| b |']),
		[{ first: 1, last: 1, form: 'pipes' }, { first: 3, last: 3, form: 'pipes' }]);
});

test('isRenderedTable: GFM, or all of the run one headerless table', () => {
	const doc = ['| a | b |', '| c | d |', '', '| x | y', '| z |'];
	assert.ok(isRenderedTable(tableAround(doc, 0), doc));
	assert.ok(!isRenderedTable(tableAround(doc, 3), doc));
	assert.ok(!isRenderedTable(null, doc));
	const gfm = ['| h |', '| --- |', '| a |'];
	assert.ok(isRenderedTable(tableAround(gfm, 2), gfm));
});

test('cellRanges: a separator on the first line is skipped; headerless means no header rows', () => {
	const a = Text.of(['|:---|---:|', '| L | R |', '| l | r |']);
	const ra = cellRanges(a, 1, 3);
	assert.equal(ra.delimiterLine, 1);
	assert.equal(ra.headerRows, 0);
	assert.deepEqual(ra.rows.map((r) => r.map((c) => a.sliceString(c.from, c.to))), [['L', 'R'], ['l', 'r']]);
	const b = Text.of(['| a | b |', '| c | d |']);
	const rb = cellRanges(b, 1, 2);
	assert.equal(rb.delimiterLine, null);
	assert.equal(rb.headerRows, 0);
	assert.equal(rb.rows.length, 2);
	const gfm = Text.of(['| h | i |', '| --- | --- |', '| a | b |']);
	assert.equal(cellRanges(gfm, 1, 3).headerRows, 1);
	// A header that merely looks like a separator stays the header.
	const odd = Text.of(['| - | - |', '| --- | --- |', '| a | b |']);
	const ro = cellRanges(odd, 1, 3);
	assert.equal(ro.delimiterLine, 2);
	assert.equal(ro.headerRows, 1);
});

test('formatTable: a pure-pipe table pads to its content, not to ---', () => {
	const doc = ['| a | 80 |', '| bb | 5 |'];
	assert.deepEqual(formatTable(tableAround(doc, 0)), ['| a  | 80 |', '| bb | 5  |']);
});

test('structure on a headerless table: row 0 is a body row', () => {
	const doc = ['| a | 1 |', '| b | 2 |'];
	const t = tableAround(doc, 0);
	assert.deepEqual(formatTable(insertRow(t, 0)), ['|   |   |', '| a | 1 |', '| b | 2 |']);
	assert.deepEqual(formatTable(deleteRow(t, 0)), ['| b | 2 |']);
	assert.deepEqual(formatTable(moveRow(t, 1, 0)), ['| b | 2 |', '| a | 1 |']);
	// The last row of a headerless table is never deleted: nothing would be left.
	const lone = tableAround(['| a |'], 0);
	assert.equal(deleteRow(lone, 0), lone);
});

test('structure on a separator-first table: never above the separator', () => {
	const doc = ['|---|---|', '| a | 1 |', '| b | 2 |'];
	const t = tableAround(doc, 1);
	assert.deepEqual(formatTable(insertRow(t, 0)), ['| --- | --- |', '|     |     |', '| a   | 1   |', '| b   | 2   |']);
	assert.equal(deleteRow(t, 0), t);
	assert.deepEqual(formatTable(deleteRow(t, 1)), ['| --- | --- |', '| b   | 2   |']);
});

test('aligning a pure-pipe column gives the table a separator (still headerless)', () => {
	const t = tableAround(['| a | 80 |', '| bb | 5 |'], 0);
	const next = setAlignment(t, 1, 'right');
	assert.equal(next.delimiterRow, 0);
	assert.deepEqual(formatTable(next), ['| --- | --: |', '| a   |  80 |', '| bb  |   5 |']);
	assert.equal(setAlignment(t, 1, null), t);
});

// ---- the live model --------------------------------------------------------

function tables(doc) {
	const state = EditorState.create({ doc, extensions: [noteMarkdown({})] });
	return liveModel(state, {}).filter((c) => c.kind === 'table').map((c) => ({
		lines: [state.doc.lineAt(c.from).number, state.doc.lineAt(c.to).number],
		headerless: c.headerless ?? null,
		inline: liveModel(state, {}).filter((i) => i.level === 'inline' && i.from >= c.from && i.to <= c.to).map((i) => i.kind),
	}));
}

test('the model: the owner\'s grades table is a headerless table, cells still parsed', () => {
	assert.deepEqual(tables(GRADES), [{ lines: [3, 5], headerless: 'pipes', inline: ['strong', 'strong'] }]);
});

test('the model: GFM stays lezer\'s; a list item\'s first line holds no row', () => {
	assert.deepEqual(tables('| h |\n| --- |\n| a |\n').map((t) => t.headerless), [null]);
	assert.deepEqual(tables('- | a |\n'), []);
	assert.deepEqual(tables('> | a | b |\n'), []);
});

// ---- parity with the engine's own tokenizer ----------------------------------

// The engine's own marked: the golden master's install (the vendored mirror
// carries no node_modules), found the way scripts/vendor-jmarkdown.js finds it.
const MARKED = path.join(process.env.JMARKDOWN_SRC
	?? path.join(os.homedir(), 'Sites', 'jmckalex', 'software', 'jmarkdown'),
'node_modules', 'marked', 'lib', 'marked.esm.js');

/** The 1-based line ranges the engine lexes as tables. */
async function engineTables(doc) {
	const { Marked } = await import(pathToFileURL(MARKED).href);
	const { markedExtendedTablesHeaderless } = await import('../vendor/jmarkdown/src/marked-extended-tables-headerless.js');
	const marked = new Marked();
	marked.use(markedExtendedTablesHeaderless());
	const out = [];
	let offset = 0;
	for (const tok of marked.lexer(doc)) {
		if (['table', 'spanTable', 'headerlessTable'].includes(tok.type)) {
			const raw = tok.raw.replace(/\n+$/, '');
			const first = doc.slice(0, offset).split('\n').length;
			out.push([first, first + raw.split('\n').length - 1]);
		}
		offset += tok.raw.length;
	}
	return out;
}

const PARITY = [
	GRADES,
	'Prose straight above\n| a | b |\n| c | d |\n\nAfter.\n',
	'Prose\n\n|:---|---:|\n| L | R |\n| l | r |\n\nAfter.\n',
	'| h | i |\n| --- | --- |\n| a | b |\n\nAfter.\n',
	'Above\n\n| a | b |\n| c | d |\nprose straight below\n',
	'A line like\n\n| hello |\n\nis a table.\n',
	'a | b\nc | d\n\nNot a table.\n',
	'| a | b\n| c | d\n\nNot one either.\n',
];

test('parity: the engine and live edit draw tables on the same lines', { skip: !existsSync(MARKED) && 'the engine master (and its marked) is not on this machine' }, async () => {
	for (const doc of PARITY) {
		assert.deepEqual(tables(doc).map((t) => t.lines), await engineTables(doc), doc);
	}
});
