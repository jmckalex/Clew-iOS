// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Admonition fences (```ad-*) map onto callout tokens.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { admonitionFence } from '../vendor/clew/engine/admonitions.js';
import { untitledCalloutTitle } from '#jmarkdown/callout-table.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-admonitions-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
const MODULE = new URL('../vendor/clew/engine/admonitions.js', import.meta.url).href;

function tokenize(src) {
	const ctx = {
		lexer: {
			blockTokens: (text, out) => { out.push({ type: 'text', text }); return out; },
			inline: (text, out) => { out.push({ type: 'text', text }); return out; },
		},
	};
	return admonitionFence.tokenizer.call(ctx, src);
}

test('an ad-fence becomes a callout token of the mapped type', () => {
	const token = tokenize('```ad-warning\nMind the gap.\n```\n');
	assert.equal(token.type, 'calloutBlock', 'rendered by callouts.js — one look');
	assert.equal(token.calloutType, 'warning');
	assert.equal(token.title, '');
	assert.equal(token.fold, null);
	assert.equal(token.tokens[0].text, 'Mind the gap.');
});

test('title and collapse options are honoured; icon/color tolerated', () => {
	const token = tokenize('```ad-tip\ntitle: A *good* idea\ncollapse: closed\nicon: star\ncolor: 200,200,0\n\nBody here.\n```\n');
	assert.equal(token.calloutType, 'tip');
	assert.equal(token.title, 'A *good* idea');
	assert.equal(token.fold, '-');
	assert.equal(token.tokens[0].text, 'Body here.');
});

test('collapse: open renders expanded-but-foldable', () => {
	assert.equal(tokenize('```ad-note\ncollapse: open\nx\n```\n').fold, '+');
	assert.equal(tokenize('```ad-note\ncollapse: none\nx\n```\n').fold, null);
});

test('aliases fold like callouts; unknown types become titled notes', () => {
	assert.equal(tokenize('```ad-hint\nx\n```\n').calloutType, 'tip');
	assert.equal(tokenize('```ad-caution\nx\n```\n').calloutType, 'warning');
	const custom = tokenize('```ad-recipe\nStir well.\n```\n');
	assert.equal(custom.calloutType, 'note');
	assert.equal(custom.title, 'Recipe', 'user-defined types keep their name');
});

test('an untitled fence is headed by its type as written, as > [!type] is', () => {
	// The engine's renderer heads an untitled callout with
	// untitledCalloutTitle(token.written); without `written` it drew none.
	const heading = (src) => untitledCalloutTitle(tokenize(src).written);
	assert.equal(heading('```ad-warning\nx\n```\n'), 'Warning');
	assert.equal(heading('```ad-hint\nx\n```\n'), 'Hint', 'an alias, as written — [!CAUTION] is Caution');
	assert.equal(heading('```ad-NOTE\nx\n```\n'), 'Note');
	assert.equal(tokenize('```ad-tip\ntitle: Mine\nx\n```\n').title, 'Mine', 'a title still wins');
});

test('an option-like first content line is not eaten as an option', () => {
	const token = tokenize('```ad-note\nfrom: a friend\n```\n');
	assert.equal(token.tokens[0].text, 'from: a friend');
});

// Which callout table the fence resolves with. The worker's own (beside
// process.argv[1]) when there is one — the engine's instance, which knows
// the custom types — and the package import otherwise, never a file: URL
// beside nothing (in a WebKit worker that import never settles).
const PROBE = `
	const { admonitionFence } = await import(${JSON.stringify(MODULE)});
	const ctx = { lexer: { blockTokens: (t, o) => o, inline: (t, o) => o } };
	console.log(admonitionFence.tokenizer.call(ctx, ${JSON.stringify('```ad-hint\nx\n```\n')}).calloutType);`;

function runAs(script) {
	return execFileSync(process.execPath, script ? [script] : ['--input-type=module', '-e', PROBE], { encoding: 'utf8', timeout: 20000 }).trim();
}

test('a worker script with a callout table beside it: that table is used', () => {
	const dir = fs.mkdtempSync(path.join(tmpRoot, 'worker-'));
	fs.writeFileSync(path.join(dir, 'callout-table.js'), "export const resolveType = (raw) => `beside:${raw}`;\n");
	fs.writeFileSync(path.join(dir, 'worker.mjs'), PROBE);
	assert.equal(runAs(path.join(dir, 'worker.mjs')), 'beside:hint');
});

test('no table beside the script, or no script at all: the package import', () => {
	const dir = fs.mkdtempSync(path.join(tmpRoot, 'bare-'));
	fs.writeFileSync(path.join(dir, 'worker.mjs'), PROBE);
	assert.equal(runAs(path.join(dir, 'worker.mjs')), 'tip');
	// argv[1] absent, as in Clew-iOS's worker (argv ['node']).
	assert.equal(runAs(null), 'tip');
});
