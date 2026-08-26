// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Obsidian Kanban-plugin board notes: the on-disk format, read faithfully.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isKanbanBoard, parseBoard, renderBoard, cardHtml } from '../vendor/clew/engine/kanban-board.js';

// The shape bramses' real boards take (kanban-plugin: basic, a Complete
// lane, the settings block at the end).
const BOARD = [
	'---',
	'tags: []',
	'kanban-plugin: basic',
	'title: Kanban',
	'---',
	'',
	'## To Do',
	'- [ ] a task for [[Test Project|the project]]!',
	'',
	'- [ ] another card',
	'',
	'## Done',
	'',
	'**Complete**',
	'- [x] shipped it',
	'',
	'***',
	'',
	'## Archive',
	'- [x] long gone',
	'',
	'%% kanban:settings',
	'```',
	'{"kanban-plugin":"basic"}',
	'```',
	'%%',
].join('\n');

test('a note is a board exactly when its frontmatter says so', () => {
	assert.equal(isKanbanBoard(BOARD), true);
	assert.equal(isKanbanBoard('---\ntitle: X\n---\n## Not a board\n'), false);
	assert.equal(isKanbanBoard('## No frontmatter at all\n'), false);
	assert.equal(isKanbanBoard('kanban-plugin: basic\n'), false, 'the key must be IN frontmatter');
});

test('lanes, cards, the Complete marker, and true source lines', () => {
	const board = parseBoard(BOARD);
	assert.deepEqual(board.lanes.map((l) => l.title), ['To Do', 'Done', 'Archive']);
	const [todo, done, archive] = board.lanes;
	assert.equal(todo.cards.length, 2);
	assert.equal(todo.cards[0].line, 8, 'card lines are 1-based file lines');
	assert.equal(todo.cards[0].done, false);
	assert.equal(done.complete, true);
	assert.deepEqual(done.cards.map((c) => [c.text, c.done]), [['shipped it', true]]);
	assert.equal(archive.archived, true, 'lanes after *** are the archive');
});

test('the settings block is the plugin\'s alone', () => {
	const board = parseBoard(BOARD);
	for (const lane of board.lanes) {
		assert.ok(!lane.cards.some((c) => /kanban-plugin/.test(c.text)));
	}
});

test('renderBoard: columns, working checkboxes, hidden archive', () => {
	const html = renderBoard(parseBoard(BOARD));
	assert.match(html, /clew-kanban clew-kanban-note/);
	assert.match(html, /kanban-col-title">To Do <span class="kanban-count">2<\/span>/);
	assert.match(html, /data-source-line="8"><input type="checkbox" disabled> /);
	assert.match(html, /checkbox" disabled checked> shipped it/);
	assert.doesNotMatch(html, /long gone/, 'the archive stays out of the board');
	assert.doesNotMatch(html, /kanban:settings/);
});

test('card text renders wikilinks as internal links, all else literal', () => {
	assert.equal(cardHtml('see [[Note|the note]] & <b>x</b>'),
		'see <a class="internal-link" href="#" data-href="Note">the note</a> &amp; &lt;b&gt;x&lt;/b&gt;');
});
