// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Ranking for `[[` completion: which note a half-typed query finds, and what
// gets inserted when it is chosen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankLinkCandidates } from '../vendor/clew/renderer/editor/complete/wikilinks.js';

const note = (path, label = null) => ({
	path,
	label: label ?? path.split('/').pop().replace(/\.(md|jmd)$/i, ''),
	isAlias: false,
});

const VAULT = [
	note('Guide/Links and Embeds.md'),
	note('Guide/Reading Mode.md'),
	note('Teaching Notes/Summer Term 2026/Marking Rubric.md'),
	note('Teaching Notes/Summer Term 2026/Reading List.md'),
	note('Inbox.md'),
	{ path: 'Guide/Reading Mode.md', label: 'How rendering works', isAlias: true },
];

const labels = (query, vault = VAULT) => rankLinkCandidates(query, vault).map((o) => o.label);
const applies = (query, vault = VAULT) => rankLinkCandidates(query, vault).map((o) => o.apply);

test('a bare name still matches the way it always did', () => {
	assert.equal(labels('Inbox')[0], 'Inbox');
	assert.equal(labels('Links')[0], 'Links and Embeds');
	// …and inserts the bare name, so shortest-path resolution applies.
	assert.equal(applies('Links')[0], 'Links and Embeds');
});

test('a query naming a folder finds notes inside it', () => {
	// The reported bug: this used to return nothing, because candidates were
	// scored against the basename only.
	assert.equal(labels('Guide/Li')[0], 'Links and Embeds');
	assert.equal(labels('Guide/Read')[0], 'Reading Mode');
});

test('folder names with spaces work, and so do partial ones', () => {
	assert.equal(labels('Teaching Notes/Marking')[0], 'Marking Rubric');
	assert.equal(labels('Summer Term 2026/Reading')[0], 'Reading List');
	assert.equal(labels('Teaching/Rubric')[0], 'Marking Rubric');
});

test('letters need not be contiguous — a subsequence is enough', () => {
	// "mkrbrc" ⊂ "Marking Rubric"; nothing else in the vault contains it.
	assert.equal(labels('mkrbrc')[0], 'Marking Rubric');
	// A subsequence spanning the folder AND the filename.
	assert.equal(labels('TchngMrkng')[0], 'Marking Rubric');
	// A subsequence that matches nothing returns nothing.
	assert.deepEqual(labels('zzqq'), []);
});

test('choosing a path-shaped match inserts the path, not the bare name', () => {
	// Typing a folder means you want that file — not whatever the basename
	// resolves to elsewhere in the vault.
	assert.equal(applies('Guide/Li')[0], 'Guide/Links and Embeds');
	assert.equal(applies('Teaching Notes/Marking')[0],
		'Teaching Notes/Summer Term 2026/Marking Rubric');
	// The extension never appears in a link.
	assert.ok(!applies('Guide/Li')[0].endsWith('.md'));
});

test('the note CALLED x outranks one merely sitting in a folder called x', () => {
	const vault = [note('Guide.md'), note('Guide/Reading Mode.md')];
	assert.equal(labels('Guide', vault)[0], 'Guide');
});

test('an alias inserts its own name, even when the path matched', () => {
	const options = rankLinkCandidates('Guide/Read', VAULT);
	const alias = options.find((o) => o.label === 'How rendering works');
	assert.ok(alias, 'the alias is offered for a path query too');
	assert.equal(alias.apply, 'How rendering works');
	assert.equal(alias.detail, '→ Guide/Reading Mode.md');
});

test('an empty query lists everything, capped', () => {
	assert.equal(labels('').length, VAULT.length);
	const many = Array.from({ length: 500 }, (_, i) => note(`Folder/Note ${i}.md`));
	assert.equal(rankLinkCandidates('', many, 80).length, 80);
});

test('duplicate name+path pairs are offered once', () => {
	const twice = [note('Inbox.md'), note('Inbox.md')];
	assert.deepEqual(labels('Inbox', twice), ['Inbox']);
});
