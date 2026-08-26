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
import { readFrontmatter, readInlineFields, resolveDateExpr, parseQueryConfig, parseKanbanConfig, runQuery, parseTasksConfig, extractTasks, taskMeta, parseObsidianTasksQuery, parseSearchQuery, runSearchQuery } from '../vendor/clew/engine/query-fences.js';

// ---- core Obsidian's ```query (embedded search) -----------------------------

const SEARCH_NOTES = [
	{ path: 'Daily/2024-01-01.md', name: '2024-01-01', text: 'Went for deep work at the library. #focus\n- [ ] plan', fm: {} },
	{ path: 'Areas/Health.md', name: 'Health', text: 'Sleep more. #habit/sleep', fm: { status: 'active' } },
	{ path: 'Inbox.md', name: 'Inbox', text: 'A stray thought about libraries.', fm: {} },
];

test('search: terms AND, phrases, tag/path/file operators, negation, OR', () => {
	const hits = (q) => runSearchQuery(parseSearchQuery(q), SEARCH_NOTES).map((r) => r.note.name).sort();
	assert.deepEqual(hits('library'), ['2024-01-01']);
	assert.deepEqual(hits('"deep work"'), ['2024-01-01']);
	assert.deepEqual(hits('tag:#focus'), ['2024-01-01']);
	assert.deepEqual(hits('tag:habit'), ['Health'], 'nested tags match their parent');
	assert.deepEqual(hits('path:Areas'), ['Health']);
	assert.deepEqual(hits('file:Inbox'), ['Inbox']);
	assert.deepEqual(hits('librar -thought'), ['2024-01-01']);
	assert.deepEqual(hits('tag:#focus OR path:Areas'), ['2024-01-01', 'Health']);
	assert.deepEqual(hits('[status:active]'), ['Health']);
	assert.deepEqual(hits('[status]'), ['Health']);
});

test('search: matching lines become excerpts', () => {
	const [hit] = runSearchQuery(parseSearchQuery('"deep work"'), SEARCH_NOTES);
	assert.equal(hit.excerpts.length, 1);
	assert.match(hit.excerpts[0], /deep work at the library/);
});

test('search: what Clew does not run is refused by name', () => {
	assert.deepEqual(parseSearchQuery('line:(foo bar)').refused, ['line:(…) scoped search']);
	assert.deepEqual(parseSearchQuery('/rege*x/').refused, ['regular expressions']);
	assert.deepEqual(parseSearchQuery('(a OR b) c').refused, ['grouping with parentheses']);
});

// ---- the Tasks PLUGIN's dialect ---------------------------------------------

test('taskMeta: emoji dates, priority, recurrence — parsed and stripped', () => {
	const { meta, clean } = taskMeta('write the thing ⏫ 🔁 every week 📅 2024-03-01 ⏳ 2024-02-20 #work');
	assert.equal(meta.due, '2024-03-01');
	assert.equal(meta.scheduled, '2024-02-20');
	assert.equal(meta.priority, 'high');
	assert.equal(meta.recurring, 'every week');
	assert.equal(clean, 'write the thing #work');
	assert.equal(taskMeta('plain task').meta.priority, 'none');
});

const T = (over = {}) => ({
	done: false, clean: 'a task', heading: 'Inbox', notePath: 'Daily/2024.md',
	noteName: '2024', tags: ['#work'], meta: { priority: 'none' }, line: 1, ...over,
});

test('Tasks-dialect filters: status, includes, dates, priority', () => {
	const q = parseObsidianTasksQuery('not done\npath includes daily\nheading includes inbox');
	assert.equal(q.refused.length, 0);
	assert.ok(q.filters.every((f) => f(T())));
	assert.ok(!q.filters.every((f) => f(T({ done: true }))));
	assert.ok(!q.filters.every((f) => f(T({ notePath: 'Projects/x.md' }))));

	const due = parseObsidianTasksQuery('due before 2024-06-01');
	assert.ok(due.filters[0](T({ meta: { priority: 'none', due: '2024-05-01' } })));
	assert.ok(!due.filters[0](T({ meta: { priority: 'none', due: '2024-07-01' } })));
	assert.ok(!due.filters[0](T()), 'no due date never matches a due comparison');

	const has = parseObsidianTasksQuery('has due date');
	assert.ok(has.filters[0](T({ meta: { priority: 'none', due: '2024-05-01' } })));
	assert.ok(!has.filters[0](T()));

	const pri = parseObsidianTasksQuery('priority is above none');
	assert.ok(pri.filters[0](T({ meta: { priority: 'high' } })));
	assert.ok(!pri.filters[0](T({ meta: { priority: 'low' } })));
});

test('Tasks-dialect sort, group, limit and layout lines parse', () => {
	const q = parseObsidianTasksQuery('sort by priority\ngroup by heading\nlimit 5\nhide backlink\nshort mode');
	assert.equal(q.refused.length, 0);
	assert.equal(q.sorts.length, 1);
	assert.equal(q.limit, 5);
	assert.ok(q.hide.has('backlink'));
	assert.ok(q.hide.has('due date'), 'short mode hides the badges');
	assert.equal(q.group(T()), 'Inbox');
});

test('what the Tasks dialect cannot run is refused by name', () => {
	const fn = parseObsidianTasksQuery('not done\nfilter by function task.status.type === "TODO"');
	assert.equal(fn.refused.length, 1);
	assert.match(fn.refused[0], /JavaScript/);
	const junk = parseObsidianTasksQuery('utter nonsense line');
	assert.equal(junk.refused.length, 1);
	assert.match(junk.refused[0], /utter nonsense line/);
	const bool = parseObsidianTasksQuery('(done) AND (path includes x)');
	assert.match(bool.refused[0], /boolean/);
});

test('frontmatter reader: scalars, arrays, block lists', () => {
	const fm = readFrontmatter('---\nstatus: active\npriority: 2\ndone: false\ntags: [a, b]\nlist:\n  - x\n  - y\n---\nbody');
	assert.deepEqual(fm, { status: 'active', priority: 2, done: false, tags: ['a', 'b'], list: ['x', 'y'] });
	assert.deepEqual(readFrontmatter('no fm'), {});
});

const notes = [
	{ path: 'Projects/A.md', name: 'A', modified: 3, text: '', fm: { status: 'active', priority: 2, tags: ['work'] } },
	{ path: 'Projects/B.md', name: 'B', modified: 2, text: '', fm: { status: 'done', priority: 1 } },
	{ path: 'Ideas/C.md', name: 'C', modified: 1, text: '', fm: { status: 'active', tags: ['work', 'fun'] } },
];

test('query: from, tag, where, sort, limit', () => {
	const q = (body) => runQuery(parseQueryConfig(body), notes).map((n) => n.name);
	assert.deepEqual(q('from: Projects'), ['A', 'B']);
	assert.deepEqual(q('tag: #work'), ['A', 'C']);
	assert.deepEqual(q('where: status = active'), ['A', 'C']);
	assert.deepEqual(q('where: status != done\nwhere: priority'), ['A']);
	assert.deepEqual(q('where: priority >= 1\nsort: priority desc'), ['A', 'B']);
	assert.deepEqual(q('where: tags contains fun'), ['C']);
	assert.deepEqual(q('sort: modified desc\nlimit: 2'), ['A', 'B']);
	assert.deepEqual(q('table: status, priority').length ? parseQueryConfig('table: status, priority').columns : null, ['status', 'priority']);
});

test('tasks: extraction masks fences, config parses', () => {
	const text = '# T\n- [ ] open one\n- [x] closed\n```\n- [ ] not a task (fenced)\n```\n  - [ ] indented open\nplain line';
	const tasks = extractTasks(text);
	assert.deepEqual(tasks.map(({ line, done, text: t }) => ({ line, done, text: t })), [
		{ line: 2, done: false, text: 'open one' },
		{ line: 3, done: true, text: 'closed' },
		{ line: 7, done: false, text: 'indented open' },
	]);
	assert.equal(tasks[0].heading, 'T', 'each task knows its nearest heading');
	assert.equal(parseTasksConfig('done\nfrom: X/').status, 'done');
	assert.equal(parseTasksConfig('all\ngroup: none').group, 'none');
	assert.equal(parseTasksConfig('').status, 'todo');
});

// ---- the writable-database layer ----

test('inline fields: own-line and bracketed, with line numbers', () => {
	const text = '# T\nRating:: 8\nSome prose with [chapter:: 5] inline.\n```\nMasked:: 1\n```\n';
	const { fields, lines } = readInlineFields(text);
	assert.deepEqual(fields, { Rating: 8, chapter: 5 });
	assert.deepEqual(lines, { Rating: 2, chapter: 3 });
});

test('date expressions resolve', () => {
	const now = new Date(2026, 7, 22); // 22 Aug 2026
	assert.equal(resolveDateExpr('today', now), '2026-08-22');
	assert.equal(resolveDateExpr('today + 7d', now), '2026-08-29');
	assert.equal(resolveDateExpr('today - 2w', now), '2026-08-08');
	assert.equal(resolveDateExpr('today + 1m', now), '2026-09-22');
	assert.equal(resolveDateExpr('2026-01-01', now), null);
});

test('where clauses with date expressions filter ISO dates', () => {
	const config = parseQueryConfig('where: due < today + 31d\nwhere: due');
	assert.equal(config.where[0].op, '<');
	assert.match(String(config.where[0].value), /^\d{4}-\d{2}-\d{2}$/);
});

test('group clause parses and kanban config parses', () => {
	assert.equal(parseQueryConfig('group: status').group, 'status');
	const k = parseKanbanConfig('group: status\nfrom: Papers/\ncolumns: a, b\nshow: due, venue');
	assert.deepEqual(k, { group: 'status', from: 'Papers', tag: null, columns: ['a', 'b'], show: ['due', 'venue'] });
});
