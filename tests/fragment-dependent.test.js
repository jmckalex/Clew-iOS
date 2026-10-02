// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Which fragment renders read OTHER files (src/shared/fragment-deps.js): those
// must not be served from the hash cache once a file changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDependentFragment } from '../vendor/clew/shared/fragment-deps.js';

test('embeds of every kind are dependent', () => {
	for (const text of ['![[Note]]', 'See ![[Note#Part|quiet]] here', '![[board.canvas]]', '![[Books.base#Table]]', '![[paper.pdf]]']) {
		assert.equal(isDependentFragment(text), true, text);
	}
});

test('vault-reading fences are dependent', () => {
	for (const lang of ['query', 'tasks', 'kanban', 'dataview', 'dataviewjs', 'base', 'leaflet']) {
		assert.equal(isDependentFragment(`\`\`\`${lang}\nx\n\`\`\``), true, lang);
	}
	assert.equal(isDependentFragment('~~~ dataview\nx\n~~~'), true);
});

test('Meta Bind widgets and @reveal are dependent', () => {
	assert.equal(isDependentFragment('Rating: INPUT[slider:rating]'), true);
	assert.equal(isDependentFragment('VIEW[{rating} * 2]'), true);
	assert.equal(isDependentFragment('@reveal[Decks/intro/]'), true);
});

test('a citation is dependent: it reads the bibliography', () => {
	for (const text of ['A \\cite{x}.', '\\citep[p. 5]{a, b}', '\\fullcite{k}', '\\citeauthor{k}', '\\cite*{k}', '\\textcite{k}']) {
		assert.equal(isDependentFragment(text), true, text);
	}
	assert.equal(isDependentFragment('They excite {nothing}; recite{x}'), false);
});

test('self-contained text is not', () => {
	for (const text of [
		'Plain *prose* with [[a link]] and a #tag.',
		'```mermaid\ngraph TD\n```',
		'```js\nconst query = 1;\n```',
		'$$E = mc^2$$',
		'[[Note]] is a link, not an embed',
		'',
	]) {
		assert.equal(isDependentFragment(text), false, JSON.stringify(text));
	}
});
