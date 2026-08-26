// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Meta Bind widgets: the declaration parser and the rendered HTML.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseInputDeclaration, inputHtml, viewHtml, metaBindInline, metaBindFence } from '../vendor/clew/engine/meta-bind.js';
import { resetCache } from '../vendor/clew/engine/vault-model.js';

let root;

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-mb-'));
	fs.writeFileSync(path.join(root, 'Habits.md'),
		'---\ndone: true\nrating: 7\nstatus: review\nsubtitle: morning pages\n---\nThe note.\n');
	fs.writeFileSync(path.join(root, 'Other.md'), '---\nflag: false\n---\nOther.\n');
	process.env.CLEW_VAULT_ROOT = root;
	global.current_file = path.join(root, 'Habits.md');
	resetCache();
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
	delete process.env.CLEW_VAULT_ROOT;
	delete global.current_file;
	resetCache();
});

test('declarations parse: types, arguments, options, bind targets', () => {
	assert.deepEqual(parseInputDeclaration('toggle:done').type, 'toggle');
	const slider = parseInputDeclaration('slider(minValue(0), maxValue(10), stepSize(1)):rating');
	assert.equal(slider.min, 0);
	assert.equal(slider.max, 10);
	assert.equal(slider.prop, 'rating');
	const select = parseInputDeclaration('inlineSelect(option(draft), option(review, In review)):status');
	assert.deepEqual(select.options, [
		{ value: 'draft', label: 'draft' }, { value: 'review', label: 'In review' }]);
	const other = parseInputDeclaration('toggle:[[Other]]#flag');
	assert.equal(other.file, '[[Other]]');
	assert.equal(other.prop, 'flag');
});

test('what has no widget is refused BY NAME', () => {
	assert.match(parseInputDeclaration('progressBar:rating').error, /no Clew widget for INPUT\[progressBar\]/);
	assert.match(parseInputDeclaration('toggle').error, /no bound property/);
	assert.match(parseInputDeclaration('toggle:a.b.c').error, /nested paths/);
	assert.match(inputHtml('toggle:[[Nowhere]]#x'), /clew-mb-refused/);
	assert.match(viewHtml('{a} + {b}'), /only a single \{property\}/);
});

test('widgets render bound to the note, carrying the edit contract', () => {
	const toggle = inputHtml('toggle:done');
	assert.match(toggle, /type="checkbox"[^>]*checked/);
	assert.match(toggle, /data-edit-path="Habits\.md"/);
	assert.match(toggle, /data-edit-field="done"/);
	assert.match(toggle, /data-edit-source="fm"/);

	const slider = inputHtml('slider(minValue(0), maxValue(10)):rating');
	assert.match(slider, /type="range"[^>]*min="0" max="10"[^>]*value="7"/);
	assert.match(slider, /clew-mb-value">7</);

	const select = inputHtml('inlineSelect(option(draft), option(review)):status');
	assert.match(select, /<option value="review" selected>/);

	const text = inputHtml('text:subtitle');
	assert.match(text, /value="morning pages"/);

	const remote = inputHtml('toggle:[[Other]]#flag');
	assert.match(remote, /data-edit-path="Other\.md"/);
	assert.doesNotMatch(remote, /checked/);
});

test('VIEW shows the bound value; the inline tokenizer claims the syntax', () => {
	assert.match(viewHtml('{rating}'), /clew-mb-view">7</);
	const token = metaBindInline.tokenizer('INPUT[toggle:[[Other]]#flag] rest');
	assert.equal(token.raw, 'INPUT[toggle:[[Other]]#flag]');
	assert.equal(metaBindInline.tokenizer('no widgets here'), undefined);
});

test('button and scripting fences are refused by name', () => {
	const button = metaBindFence.renderer({ flavor: '-button', body: 'x' });
	assert.match(button, /does not run meta-bind-button/);
	const plain = metaBindFence.renderer({ flavor: '', body: 'INPUT[toggle:done]' });
	assert.match(plain, /clew-mb-block/);
	assert.match(plain, /type="checkbox"/);
});
