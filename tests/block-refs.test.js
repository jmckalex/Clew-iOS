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
import {
	blockAnchor, blockAnchorLine, tableBeforeAnchor, sliceBlock, stripBlockMarkers,
} from '../vendor/clew/engine/block-refs.js';
import { extractNoteMetadata } from '../vendor/clew/shared/note-metadata.js';
import { blockRefEdit, blockRefLink, generateBlockId } from '../vendor/clew/renderer/editor/block-ids.js';
import { wikilinkCompletions } from '../vendor/clew/renderer/editor/complete/wikilinks.js';
import { vaultStore } from '../vendor/clew/renderer/state/vault-store.js';

// ---- the tokenizers --------------------------------------------------------

const trailing = (src) => blockAnchor.tokenizer(src);
const standalone = (src) => blockAnchorLine.tokenizer(src);

test('a marker at the end of a block is a block id', () => {
	const token = trailing(' ^ideal-obs');
	assert.equal(token.id, 'ideal-obs');
	assert.equal(token.raw, ' ^ideal-obs');
});

test('a superscript is NOT a block id — the space is the whole discriminator', () => {
	// jmarkdown reads `x^2` as TeX superscript. The rule requires whitespace
	// before the caret, so the two can never claim the same offset.
	assert.equal(trailing('^2'), undefined);
	assert.equal(trailing('^{10}'), undefined);
	// And start() must not tempt the lexer into cutting the text token there.
	assert.equal(blockAnchor.start('the area is x^2'), undefined);
	assert.equal(blockAnchor.start('a claim worth naming ^abc123'), 20);
});

test('only a marker ENDING the block counts', () => {
	assert.equal(trailing(' ^abc and then more prose'), undefined);
	assert.equal(blockAnchor.start('mid ^abc sentence'), undefined);
});

test("Obsidian's character class is matched exactly", () => {
	assert.equal(trailing(' ^a3f9c1').id, 'a3f9c1');
	assert.equal(trailing(' ^with-hyphens').id, 'with-hyphens');
	// `_` is subscript in jmarkdown and is not a legal Obsidian id: the match
	// stops before it rather than swallowing the rest.
	assert.equal(trailing(' ^has_underscore'), undefined);
	assert.equal(trailing(' ^'), undefined);
});

test('a marker alone on a line is a block id too', () => {
	assert.equal(standalone('^table-1\n').id, 'table-1');
	assert.equal(standalone('^table-1').id, 'table-1');
	// A line that merely begins with a caret is not one.
	assert.equal(standalone('^2 is the exponent\n'), undefined);
});

test('the standalone rule clips the paragraph above it, and nothing else', () => {
	// start() is what stops marked swallowing the marker as a lazy
	// continuation; firing on a bare `\n^` would tear ordinary prose in half.
	assert.equal(blockAnchorLine.start('ome prose here\n^abc\n'), 15);
	assert.equal(blockAnchorLine.start('ome prose\n^2 is the exponent\n'), undefined);
});

test('the anchor renders invisibly, and not at all in LaTeX', () => {
	const html = blockAnchor.renderer({ id: 'a3f9c1' });
	assert.match(html, /class="block-anchor"/);
	assert.match(html, /id="\^a3f9c1"/);
	assert.match(html, /data-block-id="a3f9c1"/);
	assert.match(html, /><\/span>$/, 'the anchor holds no text');

	global.isLatex = true;
	try {
		assert.equal(blockAnchor.renderer({ id: 'a3f9c1' }), '');
		assert.equal(blockAnchorLine.renderer({ id: 'a3f9c1' }), '');
	} finally { global.isLatex = false; }
});

// ---- the table rescue ------------------------------------------------------

// The tokenizer re-lexes what it claims, so the test stands in for the lexer.
const claimTable = (src) => {
	const lexer = { blockTokens: (text, out) => out.push({ text }) };
	return tableBeforeAnchor.tokenizer.call({ lexer }, src);
};

test('a table followed by a marker is claimed WITHOUT the marker line', () => {
	// Left alone, the table rule eats the marker as a phantom final row.
	const table = '| Sender | Receiver |\n| --- | --- |\n| 1 | A |\n';
	const token = claimTable(table + '^payoff-table\n');
	assert.equal(token.raw, table, 'the marker line must be left for the next pass');
	assert.equal(token.tokens[0].text, table);
});

test('an ordinary table is never intercepted', () => {
	const table = '| a | b |\n| --- | --- |\n| 1 | 2 |\n';
	assert.equal(claimTable(table), undefined);
	assert.equal(claimTable(table + '\nFollowing prose.\n'), undefined);
	// Nor is a marker that follows a blank line — the table has already ended,
	// so the plain standalone rule handles it.
	assert.equal(claimTable(table + '\n^payoff-table\n'), undefined);
});

test('the rescue needs a pipe row, so prose is not swept up', () => {
	assert.equal(claimTable('Just prose.\n^abc\n'), undefined);
});

// ---- slicing, which is what ![[Note#^id]] transcludes -----------------------

const NOTE = [
	'# Signals and Society',                      // 1
	'',                                           // 2
	'Ideal observers are a modelling convenience,', // 3
	'not a claim about anyone. ^ideal-obs',       // 4
	'',                                           // 5
	'| Sender | Receiver |',                      // 6
	'| --- | --- |',                              // 7
	'| 1 | A |',                                  // 8
	'^payoff-table',                              // 9
	'',                                           // 10
	'- first point',                              // 11
	'- second point ^second',                     // 12
	'  - nested under the second',                // 13
	'- third point',                              // 14
	'',                                           // 15
	'Unmarked closing paragraph.',                // 16
].join('\n');

test('a trailing marker slices its own paragraph, marker removed', () => {
	assert.equal(
		sliceBlock(NOTE, 'ideal-obs'),
		'Ideal observers are a modelling convenience,\nnot a claim about anyone.',
	);
});

test('a marker on its own line slices the block ABOVE it', () => {
	assert.equal(
		sliceBlock(NOTE, 'payoff-table'),
		'| Sender | Receiver |\n| --- | --- |\n| 1 | A |',
	);
});

test('a marker on a list item takes that item and its children, not the list', () => {
	// Walking back to the blank line would drag in "first point", which is
	// not what the link meant.
	assert.equal(
		sliceBlock(NOTE, 'second'),
		'- second point\n  - nested under the second',
	);
});

test('a blank line inside a fence does not cut the sliced block in half', () => {
	const text = 'Intro.\n\n```js\n\nconst x = 1;\n```\n^snippet\n';
	assert.equal(sliceBlock(text, 'snippet'), '```js\n\nconst x = 1;\n```');
});

test('an id that is not there is null, not an empty embed', () => {
	assert.equal(sliceBlock(NOTE, 'nonexistent'), null);
});

test('an id is not matched by a longer one that contains it', () => {
	assert.equal(sliceBlock('Prose. ^abcdef', 'abc'), null);
	assert.equal(sliceBlock('Prose. ^abcdef', 'abcdef'), 'Prose.');
});

test('stripping removes markers in both positions and leaves prose alone', () => {
	assert.equal(stripBlockMarkers('Text. ^one\n\n| a |\n^two'), 'Text.\n\n| a |');
	assert.equal(stripBlockMarkers('The area is x^2'), 'The area is x^2');
});

// ---- the index, which is what completion and navigation read ---------------

const blocksOf = (text) => extractNoteMetadata(text).blocks;

test('the index records every marker with the line to scroll to', () => {
	const blocks = blocksOf(NOTE);
	assert.deepEqual(blocks, [
		{ id: 'ideal-obs', line: 4 },
		// Line 6, the top of the table — NOT line 9, the marker, which would
		// leave the table above the window.
		{ id: 'payoff-table', line: 6 },
		{ id: 'second', line: 12 },
	]);
});

test('a marker under a fenced block points at the fence, not through it', () => {
	// Fences are masked to blanks for scanning; a masked walk backwards would
	// stride over the code block entirely and land on the prose above it.
	const text = [
		'Intro paragraph.',   // 1
		'',                   // 2
		'```js',              // 3
		'',                   // 4
		'const x = 1;',       // 5
		'```',                // 6
		'^snippet',           // 7
	].join('\n');
	assert.deepEqual(blocksOf(text), [{ id: 'snippet', line: 3 }]);
});

test('the index does not mistake superscripts or code for block ids', () => {
	assert.deepEqual(blocksOf('The area is x^2'), []);
	assert.deepEqual(blocksOf('Inline `code ^notanid` here'), []);
	assert.deepEqual(blocksOf('```\nfenced ^notanid\n```'), []);
});

// ---- writing a marker: "Copy link to block" --------------------------------

const LINES = NOTE.split('\n');
const fixedId = () => 'a3f9c1';
// Apply the returned edit so the assertion is about resulting TEXT, not about
// an offset triple that could be right-looking and wrong.
const applyEdit = (lines, edit) => {
	const out = [...lines];
	const line = out[edit.insert.line];
	out[edit.insert.line] = line.slice(0, edit.insert.column) + edit.insert.text
		+ line.slice(edit.insert.column);
	return out.join('\n').split('\n');
};

test('generated ids are six lowercase alphanumerics, as Obsidian writes them', () => {
	for (let i = 0; i < 200; i++) assert.match(generateBlockId(), /^[a-z0-9]{6}$/);
});

test('a paragraph takes the marker at the end of its LAST line', () => {
	const lines = ['A paragraph that runs', 'across two lines.'];
	const edit = blockRefEdit(lines, 0, fixedId);   // cursor on the first line
	assert.equal(edit.id, 'a3f9c1');
	assert.deepEqual(applyEdit(lines, edit),
		['A paragraph that runs', 'across two lines. ^a3f9c1']);
	assert.equal(
		sliceBlock(applyEdit(lines, edit).join('\n'), 'a3f9c1'),
		'A paragraph that runs\nacross two lines.',
	);
});

test('a table gets a marker on a line of its own, which is the form that parses', () => {
	const lines = ['| a | b |', '| --- | --- |', '| 1 | 2 |'];
	const edit = blockRefEdit(lines, 1, fixedId);
	const after = applyEdit(lines, edit);
	assert.deepEqual(after, ['| a | b |', '| --- | --- |', '| 1 | 2 |', '^a3f9c1']);
	// Round trip: what was written must be what sliceBlock reads back.
	assert.equal(sliceBlock(after.join('\n'), 'a3f9c1'), '| a | b |\n| --- | --- |\n| 1 | 2 |');
});

test('a fenced block gets its marker beneath too, never inside the code', () => {
	const lines = ['```js', 'const x = 1;', '```'];
	const after = applyEdit(lines, blockRefEdit(lines, 1, fixedId));
	assert.deepEqual(after, ['```js', 'const x = 1;', '```', '^a3f9c1']);
	assert.equal(sliceBlock(after.join('\n'), 'a3f9c1'), '```js\nconst x = 1;\n```');
});

test("a list marks the cursor's OWN item, not the whole list", () => {
	const lines = ['- first', '- second', '- third'];
	const after = applyEdit(lines, blockRefEdit(lines, 1, fixedId));
	assert.deepEqual(after, ['- first', '- second ^a3f9c1', '- third']);
	assert.equal(sliceBlock(after.join('\n'), 'a3f9c1'), '- second');
});

test('an already-marked block hands back its id and writes nothing', () => {
	// Running the command twice must not litter the note with duplicate ids.
	for (const cursor of [2, 3]) {
		const edit = blockRefEdit(LINES, cursor, fixedId);
		assert.equal(edit.id, 'ideal-obs');
		assert.equal(edit.insert, null);
	}
	// Including the standalone form, where the marker is on the next line.
	const table = blockRefEdit(LINES, 6, fixedId);
	assert.equal(table.id, 'payoff-table');
	assert.equal(table.insert, null);
});

test('a blank line is not a block', () => {
	assert.equal(blockRefEdit(LINES, 4, fixedId), null);
	assert.equal(blockRefEdit(LINES, -1, fixedId), null);
});

test('the copied link uses the bare name, or the path when it is ambiguous', () => {
	const unique = (name) => (name === 'Source' ? 'Notes/Source.md' : null);
	assert.equal(blockRefLink('Notes/Source.md', 'a3f9c1', unique), '[[Source#^a3f9c1]]');
	// Two notes called Source: the basename would resolve to the other one.
	const clashing = () => 'Other/Source.md';
	assert.equal(blockRefLink('Notes/Source.md', 'a3f9c1', clashing), '[[Notes/Source#^a3f9c1]]');
});

// ---- completion ------------------------------------------------------------

test('typing [[Note#^ offers block ids, and [[Note# still offers headings', () => {
	vaultStore.index = {
		'Source.md': {
			headings: [{ text: 'Intro', line: 1 }],
			blocks: [{ id: 'ideal-obs', line: 4 }, { id: 'payoff-table', line: 6 }],
			links: [], tags: [], aliases: [],
		},
	};
	const at = (text) => ({
		pos: text.length, explicit: true,
		state: { doc: { lineAt: () => ({ text, from: 0 }) } },
	});

	const blocks = wikilinkCompletions(at('see [[Source#^'));
	assert.deepEqual(blocks.options.map((o) => o.apply), ['^ideal-obs', '^payoff-table']);
	// The caret is replaced, not appended to, so the result is `#^ideal-obs`.
	assert.equal(blocks.from, 'see [[Source#'.length);

	const headings = wikilinkCompletions(at('see [[Source#'));
	assert.deepEqual(headings.options.map((o) => o.apply), ['Intro']);
});
