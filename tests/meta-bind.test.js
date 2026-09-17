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
		'---\ndone: true\nrating: 7\nstatus: review\nsubtitle: morning pages\n'
		+ 'stars: 3\ndue: 2026-09-15\nurl: https://clew-app.com\nink: "#8b7ec8"\n---\nThe note.\n\n'
		+ 'A motto worth editing. ^motto\n\n```\nnot a block ^fenced\n```\n');
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
	assert.match(parseInputDeclaration('editor:notes').error, /no Clew widget for INPUT\[editor\]/);
	assert.match(parseInputDeclaration('toggle').error, /no bound property/);
	assert.match(parseInputDeclaration('toggle:a.b.c').error, /nested paths/);
	assert.match(inputHtml('toggle:[[Nowhere]]#x'), /clew-mb-refused/);
	assert.match(viewHtml('{a} + {b}'), /only \{property\}/);
	assert.match(viewHtml('sparkline:{rating}'), /no “sparkline” view/);
});

test('widgets render as Web Awesome elements carrying the edit contract', () => {
	const toggle = inputHtml('toggle:done');
	assert.match(toggle, /<wa-switch[^>]* checked/);
	assert.match(toggle, /data-edit-path="Habits\.md"/);
	assert.match(toggle, /data-edit-field="done"/);
	assert.match(toggle, /data-edit-source="fm"/);

	const slider = inputHtml('slider(minValue(0), maxValue(10)):rating');
	assert.match(slider, /<wa-slider[^>]*min="0" max="10"[^>]*value="7"/);
	assert.match(slider, /clew-mb-value">7</);

	const select = inputHtml('inlineSelect(option(draft), option(review)):status');
	assert.match(select, /<wa-option value="review" selected>/);
	assert.match(select, /<wa-select[^>]*value="review"/);

	assert.match(inputHtml('text:subtitle'), /<wa-input type="text"[^>]*value="morning pages"/);
	assert.match(inputHtml('number:rating'), /<wa-number-input[^>]*value="7"/);
	assert.match(inputHtml('textArea:subtitle'), /<wa-textarea[^>]*value="morning pages"/);

	const remote = inputHtml('toggle:[[Other]]#flag');
	assert.match(remote, /data-edit-path="Other\.md"/);
	assert.doesNotMatch(remote, /checked/);
});

test('the Tier-2 and Clew-native types: date, time, rating, color, progress', () => {
	assert.match(inputHtml('datePicker:due'), /<wa-input type="date"[^>]*value="2026-09-15"/);
	assert.match(inputHtml('time:due'), /<wa-time-input/);
	const rating = inputHtml('rating:stars');
	assert.match(rating, /<wa-rating[^>]*value="3" max="5" precision="1"/);
	assert.match(inputHtml('rating(maxValue(10), stepSize(0.5)):stars'), /max="10" precision="0.5"/);
	assert.match(inputHtml('color:ink'), /<wa-color-picker[^>]*value="#8b7ec8"/);
	const bar = inputHtml('progressBar(minValue(0), maxValue(10)):rating');
	assert.match(bar, /<wa-progress-bar class="clew-mb-display" value="70"/);
	assert.doesNotMatch(bar, /data-edit/, 'a progress bar is a display, not an editor');
});

test('class(…) is honored: author classes land on the element', () => {
	assert.deepEqual(parseInputDeclaration('number(class(narrow)):rating').classes, ['narrow']);
	assert.deepEqual(
		parseInputDeclaration('number(class(a b), class(c)):rating').classes,
		['a', 'b', 'c'], 'several class(…) arguments accumulate');
	assert.deepEqual(
		parseInputDeclaration('number(class(ok, "><script), class(2bad)):rating').classes,
		['ok'], 'only CSS-identifier-shaped tokens reach the attribute');
	assert.match(inputHtml('number(class(narrow)):rating'), /class="clew-mb narrow"/);
	assert.match(inputHtml('toggle(class(big)):done'), /class="clew-mb big"/);
	assert.match(inputHtml('progressBar(class(fat)):rating'), /class="clew-mb-display fat"/);
	// No class(…) still renders the bare hook classes.
	assert.match(inputHtml('number:rating'), /class="clew-mb"/);
});

test('VIEW: bare value, and the formatter kinds', () => {
	assert.match(viewHtml('{rating}'), /clew-mb-view">7</);
	assert.match(viewHtml('badge:{status}'), /<wa-badge variant="brand">review</);
	assert.match(viewHtml('formatNumber:{rating}'), /<wa-format-number value="7"/);
	assert.match(viewHtml('qr:{url}'), /<wa-qr-code value="https:\/\/clew-app\.com"/);
	assert.match(viewHtml('relativeTime:{due}'), /<wa-relative-time date="2026-09-15T00:00:00" sync/);
	assert.match(viewHtml('formatDate:{due}'), /<wa-format-date date="2026-09-15T00:00:00"/);
	assert.match(viewHtml('qr:{subtitleMissing}'), /nothing to encode/);
});

test('block bindings: a text widget edits the PROSE a ^marker names', () => {
	const input = inputHtml('text:^motto');
	assert.match(input, /value="A motto worth editing\."/);
	assert.match(input, /data-edit-field="\^motto"/);
	assert.match(input, /data-edit-source="block"/);
	assert.match(inputHtml('toggle:^motto'), /only text and textArea bind to a \^block/);
	assert.match(inputHtml('text:^fenced'), /no \^fenced block/, 'markers inside fences are not blocks');
	assert.match(inputHtml('text:^nowhere'), /no \^nowhere block/);
});

test('the inline tokenizer claims the syntax; fences behave', () => {
	const token = metaBindInline.tokenizer('INPUT[toggle:[[Other]]#flag] rest');
	assert.equal(token.raw, 'INPUT[toggle:[[Other]]#flag]');
	assert.equal(metaBindInline.tokenizer('no widgets here'), undefined);
	const button = metaBindFence.renderer({ flavor: '-button', body: 'x' });
	assert.match(button, /does not run meta-bind-button/);
	const plain = metaBindFence.renderer({ flavor: '', body: 'INPUT[toggle:done]' });
	assert.match(plain, /clew-mb-block/);
	assert.match(plain, /<wa-switch/);
});
