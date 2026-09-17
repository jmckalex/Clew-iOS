// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Indexer#embeddersOf — who has to be re-rendered when a note changes.
// Works off the notes map alone, so no vault is needed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Indexer } from '../vendor/clew/main/indexer.js';

/** links: [[fromPath, toPath, embed?], …] */
function indexWith(...links) {
	const indexer = new Indexer();
	for (const [from, to, embed = true] of links) {
		if (!indexer.notes.has(from)) indexer.notes.set(from, { links: [] });
		if (!indexer.notes.has(to)) indexer.notes.set(to, { links: [] });
		indexer.notes.get(from).links.push({ target: to, resolved: to, embed });
	}
	return indexer;
}

test('a note that embeds the changed one is an embedder', () => {
	const indexer = indexWith(['Parent.md', 'Child.md']);
	assert.deepEqual([...indexer.embeddersOf('Child.md')], ['Parent.md']);
});

test('embedders are transitive — a chain of transclusions all goes stale', () => {
	const indexer = indexWith(['A.md', 'B.md'], ['B.md', 'C.md']);
	assert.deepEqual([...indexer.embeddersOf('C.md')].sort(), ['A.md', 'B.md']);
});

test('an ordinary link is not an embed and never goes stale', () => {
	const indexer = indexWith(['Linker.md', 'Child.md', false]);
	assert.deepEqual([...indexer.embeddersOf('Child.md')], []);
});

test('a changed note is never its own embedder', () => {
	const indexer = indexWith(['Self.md', 'Self.md']);
	assert.deepEqual([...indexer.embeddersOf('Self.md')], []);
});

test('an embed cycle terminates instead of walking forever', () => {
	const indexer = indexWith(['A.md', 'B.md'], ['B.md', 'A.md']);
	assert.deepEqual([...indexer.embeddersOf('A.md')], ['B.md']);
	assert.deepEqual([...indexer.embeddersOf('B.md')], ['A.md']);
});

test('an unresolved embed points at nothing and claims nothing', () => {
	const indexer = new Indexer();
	indexer.notes.set('Parent.md', { links: [{ target: 'Gone', resolved: null, embed: true }] });
	assert.deepEqual([...indexer.embeddersOf('Gone.md')], []);
});

test('several notes embedding the same one all come back', () => {
	const indexer = indexWith(['One.md', 'Shared.md'], ['Two.md', 'Shared.md']);
	assert.deepEqual([...indexer.embeddersOf('Shared.md')].sort(), ['One.md', 'Two.md']);
});
