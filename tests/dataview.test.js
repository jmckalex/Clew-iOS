// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseExpression, evaluate, parseDuration, coerceDate, display } from '../vendor/clew/engine/dv-expr.js';
import { FUNCTIONS } from '../vendor/clew/engine/dv-functions.js';
import { scanPages, resetCache, currentPage, fileFields, linkKey, makeLink } from '../vendor/clew/engine/vault-model.js';
import {
	parseQuery, splitClauses, splitTopLevel, parseSource, unsupportedIn,
	runQuery, renderQuery, dataviewJsFence, dataviewInline,
} from '../vendor/clew/engine/dataview.js';

// ---- a fixture vault --------------------------------------------------------

let root;

const NOTES = {
	'Method.md': [
		'---', 'tags: [theory]', 'aliases: [Methodology]', '---',
		'# Method', '', 'Ideal observers are a convenience.', '',
		'Links to [[Signals]].',
	].join('\n'),
	'Signals.md': [
		'---', 'status: active', 'rating: 5', 'completed: 2024-03-01', '---',
		'# Signals', '', 'A note about [[Method]]. #project/clew', '',
		'- [ ] write the thing', '- [x] read the paper',
	].join('\n'),
	'Projects/Alpha.md': [
		'---', 'status: active', 'rating: 3', '---',
		'Alpha project. Cites [[Method]].', '', 'Effort:: 12',
	].join('\n'),
	'Projects/Beta.md': [
		'---', 'status: done', 'rating: 1', '---',
		'Beta project.', '', 'Effort:: 4',
	].join('\n'),
	'Archive/Old.md': '---\nstatus: done\n---\nAn archived note.\n',
	'Scratchpad.md': 'Nothing here.\n',
};

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-dv-'));
	for (const [rel, text] of Object.entries(NOTES)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, text);
	}
	process.env.CLEW_VAULT_ROOT = root;
	resetCache();
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
	delete process.env.CLEW_VAULT_ROOT;
	delete global.current_file;
	resetCache();
});

const pages = () => scanPages().pages;
const pageNamed = (name) => pages().find((p) => p.name === name);
const inside = (rel) => { global.current_file = path.join(root, rel); };
// FROM tests get pages; runQuery tests get { page, extra } rows — the helper
// reads whichever it was handed.
const names = (rows) => rows.map((r) => (r.page ?? r).name).sort();

// ---- the expression language ------------------------------------------------

const ctx = (page, self = page) => ({
	functions: FUNCTIONS,
	linkKey,
	makeLink,
	resolve(name) {
		if (name === 'file') return fileFields(page);
		if (name === 'note') return page.fields;
		if (name === 'this') return { file: fileFields(self), ...self.fields };
		return page.fields[name];
	},
});
const evalIn = (src, page, self) => evaluate(parseExpression(src), ctx(page, self));

test('comparisons, and/or, and negation', () => {
	const p = pageNamed('Signals');
	assert.equal(evalIn('rating > 3', p), true);
	assert.equal(evalIn('rating > 10', p), false);
	assert.equal(evalIn('status = "active"', p), true);
	assert.equal(evalIn('status != "done"', p), true);
	assert.equal(evalIn('rating > 3 and status = "active"', p), true);
	assert.equal(evalIn('rating > 10 or status = "active"', p), true);
	assert.equal(evalIn('!(status = "done")', p), true);
});

test('a missing field is undefined, never a throw', () => {
	const p = pageNamed('Scratchpad');
	assert.equal(evalIn('nonexistent', p), undefined);
	assert.equal(evalIn('nonexistent.deeper.still', p), undefined);
	assert.equal(evalIn('nonexistent > 3', p), false);
	assert.equal(evalIn('contains(nonexistent, "x")', p), false);
});

test('the file.* namespace', () => {
	const p = pageNamed('Alpha');
	assert.equal(evalIn('file.name', p), 'Alpha');
	assert.equal(evalIn('file.folder', p), 'Projects');
	assert.equal(evalIn('file.path', p), 'Projects/Alpha.md');
	assert.equal(evalIn('file.ext', p), 'md');
	assert.deepEqual(evalIn('file.aliases', pageNamed('Method')), ['Methodology']);
	assert.ok(evalIn('file.tags', pageNamed('Signals')).includes('#project/clew'));
});

test('inline Key:: fields are queryable like frontmatter', () => {
	assert.equal(evalIn('Effort', pageNamed('Alpha')), 12);
	assert.equal(evalIn('Effort > 10', pageNamed('Alpha')), true);
	assert.equal(evalIn('Effort > 10', pageNamed('Beta')), false);
});

test('the link graph resolves both ways', () => {
	const method = pageNamed('Method');
	// Signals and Alpha both link to Method.
	assert.deepEqual(method.inlinks.map((l) => l.path).sort(), ['Projects/Alpha.md', 'Signals.md']);
	assert.deepEqual(method.outlinks.map((l) => l.path), ['Signals.md']);
});

test('links compare by target, not by how they were written', () => {
	const method = pageNamed('Method');
	assert.equal(evalIn('contains(this.file.inlinks, file.link)', pageNamed('Signals'), method), true);
	assert.equal(evalIn('contains(this.file.inlinks, file.link)', pageNamed('Beta'), method), false);
});

test('durations and date arithmetic', () => {
	assert.equal(parseDuration('84 days').ms, 84 * 864e5);
	assert.equal(parseDuration('60d').ms, 60 * 864e5);
	assert.equal(parseDuration('2 weeks 3 days').ms, (14 + 3) * 864e5);
	assert.equal(parseDuration('nonsense'), null);

	const p = pageNamed('Signals');
	const result = evalIn('date("2024-03-10") - dur(9 days)', p);
	assert.equal(display(result), '2024-03-01');
	assert.equal(evalIn('date(completed) >= date("2024-01-01")', p), true);
	assert.equal(evalIn('date(completed) >= date("2025-01-01")', p), false);
});

test('now() - "60d" works, which is how Bases writes a window', () => {
	const p = pageNamed('Signals');
	const cutoff = evalIn('now() - "60d"', p);
	assert.ok(cutoff instanceof Date);
	assert.ok(Date.now() - cutoff.getTime() > 59 * 864e5);
});

test('the measured function set behaves', () => {
	const p = pageNamed('Signals');
	assert.equal(evalIn('contains(file.name, "ign")', p), true);
	assert.equal(evalIn('icontains(file.name, "SIGN")', p), true);
	assert.equal(evalIn('choice(rating > 3, "high", "low")', p), 'high');
	assert.equal(evalIn('choice(rating > 30, "high", "low")', p), 'low');
	assert.equal(evalIn('regexmatch("\\w+", "abc")', p), true);
	assert.equal(evalIn('regexmatch("\\d+", "abc")', p), false);
	assert.equal(evalIn('lower(file.name)', p), 'signals');
	assert.equal(evalIn('length(file.tags) > 0', p), true);
	assert.equal(evalIn('default(missing, "fallback")', p), 'fallback');
	assert.equal(evalIn('round(3.14159, 2)', p), 3.14);
	assert.equal(evalIn('dateformat(date("2024-03-01"), "yyyy-MM")', p), '2024-03');
});

test('an external link renders as an anchor, not as text', () => {
	const p = pageNamed('Signals');
	const value = evalIn('elink("https://example.com", "Example")', p);
	assert.equal(value.__extlink, true);
	assert.equal(value.url, 'https://example.com');
});

// ---- query parsing -----------------------------------------------------------

test('clauses are found by keyword, so a query may wrap across lines', () => {
	const q = parseQuery('TABLE WITHOUT ID\n\tfile.link as "Note",\n\trating\nFROM "Projects"\nWHERE rating > 1\nSORT rating DESC\nLIMIT 5');
	assert.equal(q.type, 'TABLE');
	assert.equal(q.withoutId, true);
	assert.deepEqual(q.columns.map((c) => c.alias ?? c.source), ['Note', 'rating']);
	assert.equal(q.from, '"Projects"');
	assert.deepEqual(q.where, ['rating > 1']);
	assert.deepEqual(q.sort, [{ source: 'rating', desc: true }]);
	assert.equal(q.limit, 5);
});

test('repeated WHERE clauses are ANDed, as Dataview does', () => {
	const q = parseQuery('table x\nfrom "A"\nwhere a = 1\nwhere b = 2');
	assert.deepEqual(q.where, ['a = 1', 'b = 2']);
});

test('commas inside a function call do not split columns', () => {
	assert.deepEqual(
		splitTopLevel('choice(a, b, c) as "X", rating'),
		['choice(a, b, c) as "X"', 'rating'],
	);
});

test('lowercase DQL parses — real vaults write it both ways', () => {
	const q = parseQuery('list from "Inbox"\nwhere contains(file.name, "x")');
	assert.equal(q.type, 'LIST');
	assert.equal(q.from, '"Inbox"');
});

// ---- FROM as a set expression -------------------------------------------------

const from = (src) => pages().filter(parseSource(src));

test('FROM selects by folder, including subfolders', () => {
	assert.deepEqual(names(from('"Projects"')), ['Alpha', 'Beta']);
	assert.deepEqual(names(from('""')), names(pages()));
});

test('FROM selects by tag, nested tags included', () => {
	assert.deepEqual(names(from('#theory')), ['Method']);
	assert.deepEqual(names(from('#project')), ['Signals'], 'a parent tag matches its children');
});

test('FROM combines and negates', () => {
	assert.deepEqual(names(from('"Projects" or "Archive"')), ['Alpha', 'Beta', 'Old']);
	assert.deepEqual(names(from('!"Projects"')), ['Method', 'Old', 'Scratchpad', 'Signals']);
	assert.deepEqual(names(from('-"Projects"')), ['Method', 'Old', 'Scratchpad', 'Signals']);
});

test('FROM [[Note]] finds the pages that link TO it', () => {
	assert.deepEqual(names(from('[[Method]]')), ['Alpha', 'Signals']);
});

// ---- the queries real vaults actually contain ---------------------------------

const run = (src, self) => runQuery(parseQuery(src), pages(), self);

test('corpus shape 1: LIST FROM … WHERE contains(file.name, this.file.name)', () => {
	// bramses' daily note, four occurrences.
	const rows = run('LIST FROM "Projects"\nWHERE contains(file.name, this.file.name)', pageNamed('Alpha'));
	assert.deepEqual(names(rows), ['Alpha']);
});

test('corpus shape 2: repeated `where file.name != …` exclusions', () => {
	const rows = run([
		'table rating',
		'from "Projects"',
		'where file.name != "Beta"',
	].join('\n'));
	assert.deepEqual(names(rows), ['Alpha']);
});

test('corpus shape 3: date window with dur()', () => {
	const rows = run([
		'table completed',
		'where date(completed) >= (date("2024-03-05") - dur(84 days))',
	].join('\n'));
	assert.deepEqual(names(rows), ['Signals']);
});

test('corpus shape 4: TABLE WITHOUT ID … WHERE contains(this.file.inlinks, file.link)', () => {
	// The OB_Template backlink table, eight occurrences.
	const rows = run([
		'TABLE WITHOUT ID',
		'\tlink(file.link, file.name) as "Subject"',
		'\tFROM !"Archive"',
		'\tWHERE contains(this.file.inlinks, file.link)',
		'SORT file.name ASC',
	].join('\n'), pageNamed('Method'));
	assert.deepEqual(names(rows), ['Alpha', 'Signals']);
});

test('SORT orders, and multiple keys break ties', () => {
	const rows = run('table rating\nfrom "Projects"\nsort rating desc');
	assert.deepEqual(rows.map((r) => r.page.name), ['Alpha', 'Beta']);
	const asc = run('table rating\nfrom "Projects"\nsort rating asc');
	assert.deepEqual(asc.map((r) => r.page.name), ['Beta', 'Alpha']);
});

test('LIMIT truncates after sorting, not before', () => {
	const rows = run('table rating\nsort rating desc\nlimit 1');
	assert.deepEqual(rows.map((r) => r.page.name), ['Signals']);
});

// ---- the pipeline: FLATTEN, GROUP BY, lambdas -----------------------------------

test('FLATTEN expands a list into one row per element, bound by name', () => {
	const rows = run('TABLE n\nFROM "Projects"\nFLATTEN list(1, 2) AS n');
	assert.equal(rows.length, 4);
	assert.deepEqual(rows.map((r) => r.extra.n), [1, 2, 1, 2]);
	assert.deepEqual(rows.map((r) => r.page.name), ['Alpha', 'Alpha', 'Beta', 'Beta']);
});

test('clauses run in written order: WHERE after FLATTEN sees the binding', () => {
	const rows = run('LIST\nFROM "Projects"\nFLATTEN list(1, 2, 3) AS n\nWHERE n = 2');
	assert.equal(rows.length, 2);
	assert.ok(rows.every((r) => r.extra.n === 2));
});

test('SORT after FLATTEN orders by the binding', () => {
	const rows = run('LIST\nFROM "Projects"\nFLATTEN list(1, 2) AS n\nSORT n DESC\nLIMIT 1');
	assert.equal(rows[0].extra.n, 2);
});

test('lambdas: filter and map take (x) => …', () => {
	const rows = run('LIST\nFROM "Projects"\nWHERE length(filter(list(1, 2, 3), (x) => x > 1)) = 2');
	assert.equal(rows.length, 2, 'the lambda filter kept 2 of 3 elements for every row');
	const mapped = run('LIST\nFROM "Projects"\nFLATTEN map(list(1, 2), (x) => x * 10) AS n\nSORT n ASC');
	assert.deepEqual(mapped.map((r) => r.extra.n), [10, 10, 20, 20]);
});

test('any/all/none: bare truthiness, or a lambda verdict', () => {
	const rows = run([
		'LIST\nFROM "Projects"',
		'WHERE any(list(0, 2), (x) => x > 1) AND all(list(2, 3), (x) => x > 1)'
		+ ' AND none(list(0, false)) AND any(list(0, 1))',
	].join('\n'));
	assert.equal(rows.length, 2);
});

test('DQL list() CONSTRUCTS (the LET idiom); an empty flatten drops the row', () => {
	// list(<a list>) wraps it, so FLATTEN unwraps exactly once — a per-row LET.
	const rows = run('TABLE big\nFROM "Projects"\nFLATTEN list(filter(list(1, 2, 3, 4), (x) => x > 2)) AS big');
	assert.equal(rows.length, 2, 'one row per page — the wrap kept the list whole');
	assert.deepEqual(rows[0].extra.big, [3, 4]);
	const dropped = run('LIST\nFROM "Projects"\nFLATTEN list(filter(list(1), (x) => x > 5)) AS none\nFLATTEN none AS n');
	assert.equal(dropped.length, 0, 'flattening an empty list removes the row');
});

test('GROUP BY has real semantics: one row per group, with key and rows', () => {
	const rows = run('TABLE length(rows) AS N\nFROM "Projects"\nGROUP BY status');
	assert.equal(rows.length, 2);
	assert.deepEqual(rows.map((r) => r.extra.key), ['active', 'done']);
	assert.deepEqual(rows.map((r) => r.extra.rows.length), [1, 1]);
	assert.equal(rows[0].extra.rows[0].file.name, 'Alpha', 'rows carries the member pages');
});

test('rows spreads in expressions, and FLATTEN rows AS R ungroups', () => {
	inside('Method.md');
	const html = renderQuery('TABLE rows.file.name AS Members\nFROM "Projects"\nGROUP BY status');
	assert.match(html, /<th>Group<\/th><th>Members<\/th>/);
	assert.match(html, /Alpha/);
	assert.match(html, /Beta/);
	const rows = run('LIST R.file.name\nFROM "Projects"\nGROUP BY status\nFLATTEN rows AS R');
	assert.equal(rows.length, 2);
	assert.deepEqual(rows.map((r) => r.extra.R.file.name).sort(), ['Alpha', 'Beta']);
});

test('the wild shape: FLATTEN list(filter(x, (t) => …)) AS name renders', () => {
	inside('Method.md');
	const html = renderQuery([
		'TABLE length(Open) AS Open',
		'FROM "Projects"',
		'FLATTEN list(filter(list(1, 2, 3), (t) => t > 1)) AS Open',
	].join('\n'));
	assert.doesNotMatch(html, /is-unsupported/);
	assert.match(html, /<td[^>]*>2<\/td>/, 'length(Open) is 2 in every row');
});

// ---- honest refusal ------------------------------------------------------------

test('unsupported constructs are named, not silently dropped', () => {
	assert.deepEqual(unsupportedIn('TABLE x\nFLATTEN file.lists'), ['file.lists / file.day']);
	assert.deepEqual(unsupportedIn('CALENDAR file.day'), ['CALENDAR queries', 'file.lists / file.day']);
	assert.deepEqual(unsupportedIn('TABLE meta(x)'), ['the function meta()']);
	const taskFlatten = parseQuery('TASK\nFLATTEN tags AS t');
	assert.deepEqual(unsupportedIn('TASK\nFLATTEN tags AS t', taskFlatten), ['FLATTEN in TASK queries']);
	assert.deepEqual(unsupportedIn('TABLE rating FROM "A" WHERE contains(x, "y")'), []);
});

test('a refused query says so instead of rendering wrong numbers', () => {
	const html = renderQuery('TABLE file.lists\nWHERE file.lists');
	assert.match(html, /is-unsupported/);
	assert.match(html, /file\.lists/);
	assert.doesNotMatch(html, /<table/, 'no table is rendered from a query we cannot run');
});

test('dataviewjs is refused by name and its source shown', () => {
	const html = dataviewJsFence.renderer({ text: 'dv.table([], [])' });
	assert.match(html, /not run/);
	assert.match(html, /vault<\/code> global/);
	assert.match(html, /dv\.table/, 'the block is shown, so nothing is lost');
});

// ---- rendering -------------------------------------------------------------------

test('TABLE renders headers, aliases and links', () => {
	inside('Method.md');
	const html = renderQuery('TABLE rating AS "Score", status\nFROM "Projects"\nSORT file.name ASC');
	assert.match(html, /<th>File<\/th><th>Score<\/th><th>status<\/th>/);
	assert.match(html, /data-href="Projects\/Alpha"/);
	assert.match(html, /data-edit-field="rating"[^>]*>3</, 'the value lands in its cell');
});

test('TABLE WITHOUT ID drops the file column', () => {
	inside('Method.md');
	const html = renderQuery('TABLE WITHOUT ID rating\nFROM "Projects"');
	assert.doesNotMatch(html, /<th>File<\/th>/);
	assert.match(html, /<th>rating<\/th>/);
});

test('a bare-field column is editable; an expression column is not', () => {
	inside('Method.md');
	const html = renderQuery('TABLE status, upper(status)\nFROM "Projects"');
	assert.match(html, /data-edit-field="status"/, 'a real stored field can be edited in place');
	const cells = html.match(/<td[^>]*>/g) ?? [];
	const editable = cells.filter((c) => c.includes('data-edit-field'));
	assert.equal(editable.length, 2, 'one editable cell per row, not two');
});

test('LIST renders links, with an optional trailing expression', () => {
	inside('Method.md');
	assert.match(renderQuery('LIST FROM "Projects"'), /<ul class="clew-query clew-dataview">/);
	assert.match(renderQuery('LIST rating FROM "Projects"'), /: 3/);
});

test('TASK renders checkboxes wired back to their source line', () => {
	inside('Method.md');
	const html = renderQuery('TASK FROM "Signals"');
	assert.match(html, /data-task-path="Signals\.md"/);
	assert.match(html, /data-task-line="\d+"/);
	assert.match(html, /write the thing/);
});

test('a query matching nothing says so', () => {
	inside('Method.md');
	assert.match(renderQuery('LIST FROM "NoSuchFolder"'), /is-empty/);
});

test('inline `= expr` evaluates against the note it sits in', () => {
	inside('Signals.md');
	resetCache();
	scanPages();
	const token = dataviewInline.tokenizer('`= this.file.name` and more');
	assert.equal(token.expr, 'this.file.name');
	assert.match(dataviewInline.renderer(token), /Signals/);
});

test('inline queries do not claim ordinary code spans', () => {
	assert.equal(dataviewInline.tokenizer('`not a query`'), undefined);
	assert.equal(dataviewInline.tokenizer('`=noSpace`'), undefined);
});
