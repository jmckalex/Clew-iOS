// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Drawings are first-class in Clew's index: the words inside them reach
// search, and the links inside them reach the graph — whichever extension the
// file happens to carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDrawingMetadata } from '../vendor/clew/shared/note-metadata.js';
import { compressScene } from '../vendor/clew/shared/excalidraw-file.js';

const scene = (elements) => ({ type: 'excalidraw', version: 2, elements, appState: {}, files: {} });

const TEXTY = scene([
	{ type: 'text', text: 'See [[Welcome]] for context' },
	{ type: 'rectangle', x: 0, y: 0 },
	{ type: 'text', text: 'Status #todo and [[Clew Design|the design]]' },
]);

const asObsidianMd = (s) => '---\n\nexcalidraw-plugin: parsed\ntags: [diagram]\n\n---\n'
	+ '# Excalidraw Data\n\n## Text Elements\n\n'
	+ `## Drawing\n\`\`\`compressed-json\n${compressScene(JSON.stringify(s, null, 2))}\n\`\`\`\n%%`;

test('links written inside a drawing become real links', () => {
	const meta = extractDrawingMetadata(asObsidianMd(TEXTY), 'D.excalidraw.md');
	const targets = meta.links.map((l) => l.target);
	assert.ok(targets.includes('Welcome'), `expected Welcome in ${JSON.stringify(targets)}`);
	assert.ok(targets.includes('Clew Design'));
});

test('tags written inside a drawing are indexed', () => {
	const meta = extractDrawingMetadata(asObsidianMd(TEXTY), 'D.excalidraw.md');
	assert.ok(meta.tags.some((t) => t.tag === 'todo'));
	// …as are the wrapper's frontmatter tags, when there is a wrapper.
	assert.ok(meta.tags.some((t) => t.tag === 'diagram'));
});

test('a plain .excalidraw indexes exactly as well as the markdown form', () => {
	const md = extractDrawingMetadata(asObsidianMd(TEXTY), 'D.excalidraw.md');
	const json = extractDrawingMetadata(JSON.stringify(TEXTY), 'D.excalidraw');
	assert.deepEqual(json.links.map((l) => l.target), md.links.map((l) => l.target));
	assert.ok(json.tags.some((t) => t.tag === 'todo'));
	// The only difference is the wrapper's own frontmatter tags.
	assert.equal(json.tags.some((t) => t.tag === 'diagram'), false);
});

test('the base64 blob is NOT scanned as prose', () => {
	// Before drawings were understood, a .excalidraw.md was read as raw markdown
	// and its compressed payload mined for anything that looked like a tag.
	const meta = extractDrawingMetadata(asObsidianMd(scene([])), 'D.excalidraw.md');
	assert.deepEqual(meta.links, []);
	assert.deepEqual(meta.tags.map((t) => t.tag), ['diagram']);
});

test('a file with no scene falls through rather than throwing', () => {
	assert.equal(extractDrawingMetadata('just prose\n', 'D.excalidraw.md'), null);
});
