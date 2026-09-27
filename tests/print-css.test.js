// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The print block of src/engine/preview.css — "Export as PDF (reading
// view)". A stylesheet is not otherwise unit-testable, but ONE rule in it
// is load-bearing in a way nothing else would catch: the body's right
// inset.
//
// Without it a full-width table's right border sits exactly on the page
// clip and is mostly sliced away. Measured 2026-09-25 on A4 at 0.6in
// margins, rasterised at 200 dpi: the left border and the interior column
// separator rendered at mean grey 213 (the border colour), the right
// border at 240 — a sliver, invisible at reading zoom, which is how the
// owner's exported table came to have no right-hand edge. With one point
// of inset all three render at 213.
//
// The smoke recipe that produced those numbers, for whoever doubts this
// test: export a note with a wide table via EXPORT_NOTE's `outFile`
// bypass, then
//   pdftoppm -r 200 -f 1 -l 1 -gray <pdf> g
// and compare the mean grey of the table's left and right border columns.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const css = fs.readFileSync(path.join(root, 'vendor/clew/engine/preview.css'), 'utf8');

/** The `@media print { … }` block, braces balanced. */
function printBlock(source) {
	const start = source.indexOf('@media print');
	assert.notEqual(start, -1, 'preview.css has no @media print block');
	let depth = 0;
	for (let i = source.indexOf('{', start); i < source.length; i++) {
		if (source[i] === '{') depth += 1;
		else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
	}
	throw new Error('unbalanced @media print block');
}

test('the printed page keeps a right inset, or the rightmost border is clipped', () => {
	const block = printBlock(css);
	const body = /body\s*\{([^}]*)\}/.exec(block);
	assert.ok(body, '@media print no longer styles body');
	const padding = /padding:\s*([^;]+);/.exec(body[1]);
	assert.ok(padding, 'the print body sets no padding at all');
	const parts = padding[1].trim().split(/\s+/);
	// `padding: <top> <right> <bottom> <left>` — the right one is what keeps a
	// full-width table's border off the page clip. Anything that reduces it to
	// zero brings back a table with no right-hand edge.
	const right = parts.length >= 2 ? parts[1] : parts[0];
	const value = Number.parseFloat(right);
	assert.ok(value > 0, `print body padding-right is ${right}; it must be > 0`);
	assert.match(right, /^[\d.]+(pt|px|mm)$/, `unexpected unit in padding-right: ${right}`);
});

test('the print block still drops the reading column and its scroll tail', () => {
	// The other two things that block exists for: paper supplies the margins,
	// and 40vh of nothing at the end is a blank final page.
	const body = /body\s*\{([^}]*)\}/.exec(printBlock(css))[1];
	assert.match(body, /max-width:\s*none/);
	assert.match(body, /margin:\s*0/);
	assert.ok(!/40vh/.test(body), 'the scroll-past-end tail must not survive into print');
});
