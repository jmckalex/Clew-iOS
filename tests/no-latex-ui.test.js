// What needs LaTeX is not offered on the iPad: the build patches
// (scripts/build.js) take it out of the app bundle, and this reads the built
// bundle to prove they did. The refusals behind them are services.test.js's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundle = fs.readFileSync(path.join(root, 'dist', 'webroot', 'bundle.js'), 'utf8');

test('Proof this chapter (Clew-app ef22b0b): no palette command, and the Book panel\'s row is never built', () => {
	assert.ok(!bundle.includes('export:book-proof'), 'the palette command is dropped');
	const row = bundle.indexOf('book-proof-row');
	assert.ok(row > 0, 'the panel code is still bundled');
	// The row is built under `if (at >= 0 …)`, and the patch makes `at` -1.
	assert.match(bundle.slice(row - 160, row), /=-1;if\(\w+>=0&&/, 'its guard is always false');
});

test('the palette\'s book exports: the print alone; PDF via LaTeX, LaTeX and HTML are not registered', () => {
	// books.js registers `export:book-${format}` for each format in one
	// loop, so the ids never appear whole in the bundle: the loop's list is
	// what the patch narrows, and what decides which commands exist.
	const at = bundle.indexOf('export:book-${');
	assert.ok(at > 0, 'the book export commands are still registered from their loop');
	const loop = bundle.slice(at - 120, at);
	assert.match(loop, /of\["print"\]\)/, 'the loop registers the print alone');
	for (const format of ['pdf', 'latex', 'html']) {
		assert.ok(!loop.includes(`"${format}"`), `no export:book-${format} ("Export book as ${format === 'pdf' ? 'PDF (via LaTeX)' : format.toUpperCase().replace('LATEX', 'LaTeX')}")`);
	}
	assert.ok(bundle.includes('PDF (reading view)'), '"Export book as PDF (reading view)" keeps its words');
});

test('the exports\' figure-engine setting (Clew-app 2cc6d89) has no Settings row', () => {
	// (The key itself stays in the shim's defaults, src/shim/settings.js.)
	assert.ok(!bundle.includes('TikZ and MetaPost figures in exports'));
	assert.ok(!bundle.includes('Your TeX installation') && !bundle.includes('built-in TeX'), 'nor its choices');
});

test('Clew\'s LaTeX export style (Clew-app 3bfc0b6, 41f8713) has no Settings row', () => {
	// (The key itself stays in the shim's defaults, src/shim/settings.js.)
	assert.ok(!bundle.includes('Style of LaTeX and PDF via LaTeX exports'));
	assert.ok(!bundle.includes('Clew (EB Garamond)') && !bundle.includes('Your jmarkdown configuration only'), 'nor its choices');
});
