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

import { dataArray, renderDataviewJs, jsEnabled } from '../vendor/clew/engine/dataview-js.js';
import { dataviewJsFence } from '../vendor/clew/engine/dataview.js';
import { resetCache } from '../vendor/clew/engine/vault-model.js';

let root;

const NOTES = {
	'Projects/Alpha.md': '---\nstatus: active\neffort: 8\n---\nAlpha.\n',
	'Projects/Beta.md': '---\nstatus: done\neffort: 3\n---\nBeta.\n',
	'Projects/Gamma.md': '---\nstatus: active\neffort: 5\n---\nGamma.\n- [ ] a task\n',
	'Index.md': 'The index.\n',
};

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-dvjs-'));
	for (const [rel, text] of Object.entries(NOTES)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, text);
	}
	fs.mkdirSync(path.join(root, 'views'), { recursive: true });
	fs.writeFileSync(path.join(root, 'views/greet.js'),
		'dv.header(3, "Greetings " + (input && input.who));\ndv.list(["one", "two"]);\n');
	process.env.CLEW_VAULT_ROOT = root;
	process.env.CLEW_DATAVIEW_JS = '1';
	global.current_file = path.join(root, 'Index.md');
	resetCache();
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
	delete process.env.CLEW_VAULT_ROOT;
	delete process.env.CLEW_DATAVIEW_JS;
	delete global.current_file;
	resetCache();
});

// ---- DataArray ----------------------------------------------------------------

test('the chain Dataview scripts are actually written in', () => {
	const arr = dataArray([{ n: 3 }, { n: 1 }, { n: 2 }]);
	assert.equal(arr.length, 3);
	assert.deepEqual(arr.where((x) => x.n > 1).sort((x) => x.n).array().map((x) => x.n), [2, 3]);
	assert.deepEqual(arr.sort((x) => x.n, 'desc').array().map((x) => x.n), [3, 2, 1]);
	assert.equal(arr.limit(2).length, 2);
	assert.equal(arr.first().n, 3);
	assert.equal(arr[1].n, 1, 'numeric indexing works');
});

test('reading a property off the array reads it off every element', () => {
	// Dataview's field spreading: `pages.file.name` is a list of names.
	const arr = dataArray([{ file: { name: 'A' } }, { file: { name: 'B' } }]);
	assert.deepEqual(arr.file.name.array(), ['A', 'B']);
});

test('groupBy returns keys with their rows', () => {
	const arr = dataArray([{ k: 'x', n: 1 }, { k: 'y', n: 2 }, { k: 'x', n: 3 }]);
	const groups = arr.groupBy((v) => v.k).array();
	assert.deepEqual(groups.map((g) => g.key), ['x', 'y']);
	assert.equal(groups[0].rows.length, 2);
});

test('a throwing callback drops the row rather than the note', () => {
	const arr = dataArray([{ n: 1 }, null, { n: 2 }]);
	assert.equal(arr.where((x) => x.n > 0).length, 2);
});

// ---- the dv object ---------------------------------------------------------------

const render = (code) => renderDataviewJs(code);

test('dv.pages queries the vault, and the source syntax is the same as DQL', () => {
	const html = render('dv.list(dv.pages(\'"Projects"\').map(p => p.file.name).array())');
	assert.match(html, /Alpha/);
	assert.match(html, /Beta/);
	assert.doesNotMatch(html, />Index</);
});

test('frontmatter fields are readable straight off a page', () => {
	const html = render([
		'const active = dv.pages(\'"Projects"\').where(p => p.status === "active");',
		'dv.table(["Note", "Effort"], active.map(p => [p.file.link, p.effort]).array());',
	].join('\n'));
	assert.match(html, /<th>Note<\/th><th>Effort<\/th>/);
	assert.match(html, /data-href="Projects\/Alpha"/);
	assert.match(html, /<td>8<\/td>/);
	assert.doesNotMatch(html, /Beta/, 'the where() actually filtered');
});

test('dv.current is the note the block sits in', () => {
	assert.match(render('dv.paragraph(dv.current().file.name)'), /<p>Index<\/p>/);
});

test('output appears in call order', () => {
	const html = render('dv.header(2, "First"); dv.paragraph("Second"); dv.list(["Third"]);');
	assert.ok(html.indexOf('First') < html.indexOf('Second'));
	assert.ok(html.indexOf('Second') < html.indexOf('Third'));
	assert.match(html, /<h2>First<\/h2>/);
});

test('dv.taskList wires checkboxes back to their source line', () => {
	const html = render([
		'const tasks = [];',
		'for (const p of dv.pages(\'"Projects"\')) {',
		'  for (const t of p.file.tasks) tasks.push({ ...t, path: p.file.path });',
		'}',
		'dv.taskList(tasks);',
	].join('\n'));
	assert.match(html, /data-task-path="Projects\/Gamma\.md"/);
	assert.match(html, /a task/);
});

test('dv.tryQuery runs real DQL from inside a script', () => {
	const html = render('dv.list(dv.tryQuery(\'LIST FROM "Projects"\').map(p => p.file.name).array())');
	assert.match(html, /Alpha/);
	assert.match(html, /Gamma/);
});

test('dv.view loads and runs another script from the vault', () => {
	const html = render('dv.view("views/greet", { who: "world" })');
	assert.match(html, /<h3>Greetings world<\/h3>/);
	assert.match(html, /<li>one<\/li>/);
});

test('a missing view is named, not silently skipped', () => {
	const html = render('dv.view("views/nope")');
	assert.match(html, /did not finish/);
	assert.match(html, /no such view script/);
});

// ---- honest failure ----------------------------------------------------------------

test('dv.app, dv.io and dv.luxon say what they are and why they are missing', () => {
	for (const [member, phrase] of [
		['app', /internal application object/],
		['io', /asynchronous/],
		['luxon', /Luxon/],
	]) {
		const html = render(`dv.paragraph(String(dv.${member}))`);
		assert.match(html, /did not finish/);
		assert.match(html, new RegExp(`dv\\.${member}`));
		assert.match(html, phrase);
	}
});

test('a block that throws keeps what it had already drawn', () => {
	const html = render('dv.header(2, "Made it this far"); throw new Error("boom");');
	assert.match(html, /Made it this far/, 'partial output is not discarded');
	assert.match(html, /did not finish/);
	assert.match(html, /boom/);
});

test('top-level await is reported as such rather than half-run', () => {
	const html = render('const x = await dv.pages(); dv.list([x.length]);');
	assert.match(html, /asynchronous/i);
	assert.doesNotMatch(html, /<ul/);
});

test('a block producing nothing says so instead of rendering blank', () => {
	assert.match(render('const unused = 1;'), /is-empty/);
});

test('an error in a script never escapes into the build', () => {
	// Every shape of failure returns HTML rather than throwing.
	for (const code of ['syntax ( error', 'null.foo()', 'dv.nonexistent()', '']) {
		assert.equal(typeof render(code), 'string');
	}
});

// ---- the gate -------------------------------------------------------------------

test('without the vault opt-in the block is refused and shown', () => {
	delete process.env.CLEW_DATAVIEW_JS;
	try {
		assert.equal(jsEnabled(), false);
		const html = dataviewJsFence.renderer({ text: 'dv.list([1,2,3])' });
		assert.match(html, /not run in this vault/);
		assert.match(html, /Run dataviewjs blocks/);
		assert.match(html, /dv\.list/, 'the source is still visible');
		assert.doesNotMatch(html, /<ul class="clew-query/, 'and it did NOT run');
	} finally {
		process.env.CLEW_DATAVIEW_JS = '1';
	}
});

test('with the opt-in the same block runs', () => {
	assert.equal(jsEnabled(), true);
	const html = dataviewJsFence.renderer({ text: 'dv.list(["ran"])' });
	assert.match(html, /<li>ran<\/li>/);
});
