// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// main/callout-types.js is SHAREABLE — Clew-iOS runs it in a page with no
// Node — so it reads nothing from disk and names no Node built-in; the
// desktop's disk side is main/callout-files.js.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvedCallouts, calloutsEnv, hasCustomCallouts } from '../vendor/clew/main/callout-types.js';
import { iconTable } from '../vendor/clew/main/callout-files.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-callout-types-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const MODULE = new URL('../vendor/clew/main/callout-types.js', import.meta.url);
const PENCIL = [512, 512, 'M0 0L10 10Z'];
const TABLE = { version: 'test', icons: { 'solid:pencil': PENCIL } };

test('the shareable module names no Node built-in and no process', () => {
	const source = fs.readFileSync(MODULE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	assert.doesNotMatch(source, /from\s+['"]node:|require\(/);
	assert.doesNotMatch(source, /\bprocess\b/);
});

test('it imports and resolves where there is no process at all', () => {
	// A page has no `process`; delete Node's before the import, in a child so
	// the test runner keeps its own.
	const script = `
		delete globalThis.process;
		const m = await import(${JSON.stringify(MODULE.href)});
		const env = m.calloutsEnv([{ name: 'remark', icon: 'pencil' }], [], ${JSON.stringify(TABLE)});
		console.log(typeof globalThis.process, JSON.parse(env).remark.icon[2]);`;
	const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
	assert.equal(out.trim(), 'undefined M0 0L10 10Z');
});

test('no definitions: nothing resolved and the table is never asked for', () => {
	let asked = 0;
	const load = () => { asked += 1; return TABLE; };
	assert.equal(hasCustomCallouts(undefined, []), false);
	assert.equal(hasCustomCallouts(null, [{ name: 'x' }]), true);
	assert.deepEqual(resolvedCallouts(undefined, [], load), { custom: {}, problems: [] });
	assert.equal(calloutsEnv([], null, load), '');
	assert.equal(asked, 0);
});

test('a definition asks for the table once; the same lists are memoised', () => {
	let asked = 0;
	const load = () => { asked += 1; return TABLE; };
	const global = [{ name: 'remark', title: 'Remark', icon: 'pencil', color: '#2e8b57', aliases: ['rem'] }];
	const first = resolvedCallouts(global, undefined, load);
	assert.deepEqual(first.custom.remark, { label: 'Remark', color: '#2e8b57', icon: PENCIL, aliases: ['rem'], scope: 'global' });
	assert.equal(resolvedCallouts(global, undefined, load), first);
	assert.equal(asked, 1);
	// The vault's list wins field by field, the table given as an object.
	const merged = resolvedCallouts(global, [{ name: 'remark', color: 'teal' }], TABLE);
	assert.equal(merged.custom.remark.color, 'teal');
	assert.equal(merged.custom.remark.label, 'Remark');
	assert.equal(asked, 1);
});

test('an icon the table lacks is a problem by name, and nothing breaks', () => {
	const { custom, problems } = resolvedCallouts([{ name: 'idea', icon: 'lightbulb' }], [], { icons: {} });
	assert.equal(custom.idea, undefined);
	assert.equal(problems.length, 1);
	assert.match(problems[0].reason, /lightbulb/);
	assert.equal(resolvedCallouts([{ name: 'plain' }], [], null).custom.plain.label, 'Plain');
});

test('the desktop table is read once, from the file it is given', () => {
	const file = path.join(tmpRoot, 'fa-icons.json');
	fs.writeFileSync(file, JSON.stringify(TABLE));
	const table = iconTable(file);
	assert.deepEqual(table, TABLE);
	fs.rmSync(file);
	assert.equal(iconTable(file), table);
});

test('a missing desktop table is an empty one, not a throw', async () => {
	const { iconTable: fresh } = await import(`${pathToFileURL(path.resolve('vendor/clew/main/callout-files.js')).href}?missing`);
	const warn = console.warn;
	console.warn = () => {};
	try {
		assert.deepEqual(fresh(path.join(tmpRoot, 'nowhere.json')), { version: null, icons: {} });
	} finally {
		console.warn = warn;
	}
});
