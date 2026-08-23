// M1: the jmarkdown engine, bundled for a Web Worker with the Node shims,
// renders real demo-vault notes. Each case spawns tools/render-note.mjs in
// a child process (the bundle installs its own `process` global, which must
// not clobber the test runner's) and asserts on the emitted HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const render = (note, ...flags) => execFileSync(
	process.execPath, [path.join(root, 'tools', 'render-note.mjs'), path.join(root, 'seed-vault'), note, ...flags],
	{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('worker bundle exists (run scripts/build.js first)', () => {
	assert.ok(fs.existsSync(path.join(root, 'dist', 'engine-worker.js')));
});

test('Welcome.md: full document with resolved wikilinks and source lines', () => {
	const html = render('Welcome.md');
	assert.match(html, /<!DOCTYPE html>/i);
	assert.match(html, /class="internal-link" href="#" data-href="Editing"/);
	assert.match(html, /data-source-line="\d+"/);
	assert.ok(!html.includes('internal-link unresolved'), 'no unresolved links in the demo vault hub');
});

test('dialect: /italics/, *strong*, **intense**, ==highlight== render', () => {
	const html = render('Projects/Dialect Demo.md');
	assert.match(html, /<em[^>]*>italics<\/em>/);
	assert.match(html, /<strong[^>]*>strong<\/strong>/);
	assert.match(html, /class="intense">intense/);
	assert.match(html, /class="highlight">highlighted/);
	// Math survives marked untouched, for browser-side MathJax.
	assert.ok(html.includes('e^{i\\pi}+1=0'));
});

test('query fences scan the vault at render time', () => {
	const html = render('Features/Queries.md');
	assert.match(html, /clew-query/);
	assert.match(html, /<table/);
});

test('embeds: media embeds and block transclusion markup', () => {
	assert.match(render('Guide/Links and Embeds.md'), /internal-media/);
	assert.match(render('Welcome.md'), /internal-embed|internal-media/);
});

test('fragment mode: body-only render (canvas cards)', () => {
	const html = render('Welcome.md', '--fragment');
	assert.ok(!/<!DOCTYPE html>/i.test(html), 'fragment has no document shell');
	assert.match(html, /internal-link/);
});
