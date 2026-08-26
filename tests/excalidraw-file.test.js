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
import {
	isExcalidrawPath, isExcalidrawMarkdown, compressScene, decompressScene,
	parseExcalidraw, serializeExcalidraw, emptyScene, newMarkdownFile, drawingText,
} from '../vendor/clew/shared/excalidraw-file.js';

const SCENE = {
	type: 'excalidraw',
	version: 2,
	source: 'https://excalidraw.com',
	elements: [{ id: 'a1', type: 'rectangle', x: 10, y: 20, width: 100, height: 60, strokeColor: '#1e1e1e' }],
	appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
	files: {},
};

/** A file in the shape Obsidian's plugin actually writes. */
function obsidianFile(scene, { compressed = true, extra = '' } = {}) {
	const json = JSON.stringify(scene, null, 2);
	const body = compressed
		? `\`\`\`compressed-json\n${compressScene(json)}\n\`\`\`\n%%`
		: `\`\`\`json\n${json}\n\`\`\`\n%%`;
	return '---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n'
		+ (extra ? `${extra}\n\n` : '')
		+ '# Excalidraw Data\n\n## Text Elements\nlabel one ^abc123\n\n'
		+ `## Drawing\n${body}`;
}

test('isExcalidrawPath recognises both shapes, and only those', () => {
	assert.equal(isExcalidrawPath('Drawing.excalidraw'), true);
	assert.equal(isExcalidrawPath('folder/Drawing.excalidraw.md'), true);
	assert.equal(isExcalidrawPath('Drawing.EXCALIDRAW.MD'), true);
	assert.equal(isExcalidrawPath('Notes.md'), false);
	assert.equal(isExcalidrawPath('excalidraw.md'), false); // a note ABOUT excalidraw
	assert.equal(isExcalidrawMarkdown('a.excalidraw.md'), true);
	assert.equal(isExcalidrawMarkdown('a.excalidraw'), false);
});

test('compression round-trips, and chunks the way the plugin does', () => {
	const json = JSON.stringify(SCENE, null, 2);
	const packed = compressScene(json);
	assert.equal(decompressScene(packed), json);
	// 256-char lines separated by a blank line — this is what keeps the file
	// diffable, and rewriting it differently would churn every line in git.
	for (const line of packed.split('\n').filter(Boolean)) {
		assert.ok(line.length <= 256, `line of ${line.length} chars exceeds the 256 chunk`);
	}
	assert.ok(!packed.includes('\n\n\n'), 'no triple newline');
	assert.equal(packed.trim(), packed, 'no leading or trailing whitespace');
});

test('a long scene actually spans several chunks', () => {
	const big = { ...SCENE, elements: Array.from({ length: 200 }, (_, i) => ({ ...SCENE.elements[0], id: `e${i}` })) };
	const packed = compressScene(JSON.stringify(big));
	assert.ok(packed.split('\n\n').length > 1, 'expected multiple chunks');
	assert.deepEqual(JSON.parse(decompressScene(packed)), big);
});

test('parses a compressed Obsidian file', () => {
	const parsed = parseExcalidraw(obsidianFile(SCENE), 'D.excalidraw.md');
	assert.equal(parsed.format, 'md-compressed');
	assert.deepEqual(parsed.scene, SCENE);
});

test('parses an uncompressed Obsidian file', () => {
	const parsed = parseExcalidraw(obsidianFile(SCENE, { compressed: false }), 'D.excalidraw.md');
	assert.equal(parsed.format, 'md-json');
	assert.deepEqual(parsed.scene, SCENE);
});

test('parses a legacy .excalidraw JSON file', () => {
	const parsed = parseExcalidraw(JSON.stringify(SCENE), 'D.excalidraw');
	assert.equal(parsed.format, 'json');
	assert.deepEqual(parsed.scene, SCENE);
});

test('a .excalidraw.md with no drawing section is not a drawing', () => {
	assert.equal(parseExcalidraw('---\ntags: [x]\n---\n\nJust prose.\n', 'D.excalidraw.md'), null);
	assert.equal(parseExcalidraw('not json at all', 'D.excalidraw'), null);
});

test('saving changes ONLY the drawing — frontmatter and prose survive', () => {
	const extra = 'My own notes about this drawing.\n\n[[A linked note]]';
	const original = obsidianFile(SCENE, { extra });
	const parsed = parseExcalidraw(original, 'D.excalidraw.md');

	const edited = structuredClone(SCENE);
	edited.elements.push({ id: 'b2', type: 'ellipse', x: 0, y: 0, width: 40, height: 40 });
	const out = serializeExcalidraw(parsed, edited);

	assert.ok(out.startsWith('---\n\nexcalidraw-plugin: parsed'), 'frontmatter intact');
	assert.ok(out.includes(extra), "the user's own content survived");
	assert.ok(out.includes('## Text Elements\nlabel one ^abc123'), 'Text Elements survived');
	assert.ok(out.includes('```compressed-json'), 'still compressed');
	assert.ok(out.trimEnd().endsWith('%%'), 'the %% marker survived');
	assert.deepEqual(parseExcalidraw(out, 'D.excalidraw.md').scene, edited);
});

test('an unchanged scene re-serialises byte-for-byte', () => {
	// The strongest compatibility guarantee: open a file, save without editing,
	// and git shows nothing. LZString is deterministic, so this must hold.
	const original = obsidianFile(SCENE, { extra: 'prose' });
	const parsed = parseExcalidraw(original, 'D.excalidraw.md');
	assert.equal(serializeExcalidraw(parsed, parsed.scene), original);
});

test('an uncompressed file stays uncompressed when saved', () => {
	const original = obsidianFile(SCENE, { compressed: false });
	const parsed = parseExcalidraw(original, 'D.excalidraw.md');
	const out = serializeExcalidraw(parsed, parsed.scene);
	assert.ok(out.includes('```json'), 'still plain json');
	assert.ok(!out.includes('compressed-json'), 'not silently compressed');
	assert.equal(out, original);
});

test('a sections-only file with no user prose round-trips too', () => {
	const original = obsidianFile(SCENE);
	const parsed = parseExcalidraw(original, 'D.excalidraw.md');
	assert.equal(serializeExcalidraw(parsed, parsed.scene), original);
});

test('newMarkdownFile is a file we can read back', () => {
	const text = newMarkdownFile();
	const parsed = parseExcalidraw(text, 'New.excalidraw.md');
	assert.equal(parsed.format, 'md-compressed');
	assert.deepEqual(parsed.scene, emptyScene());
	// The frontmatter key is what makes Obsidian's plugin claim the file.
	assert.ok(text.includes('excalidraw-plugin: parsed'));
});

test('drawingText pulls the words out of a scene, skipping deleted', () => {
	const scene = { elements: [
		{ type: 'text', text: 'Hello [[Welcome]]' },
		{ type: 'rectangle' },
		{ type: 'text', text: 'gone', isDeleted: true },
		{ type: 'text', text: '#todo later' },
	] };
	assert.equal(drawingText(scene), 'Hello [[Welcome]]\n#todo later');
	assert.equal(drawingText({}), '');
	assert.equal(drawingText(null), '');
});
