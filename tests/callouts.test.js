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
// The ENGINE's callouts since jmarkdown a7de8c6 (Clew's own copy retired).
import { resolveType, calloutBlock, untitledCalloutTitle } from '#jmarkdown/callouts.js';

test('type resolution is case-insensitive, which GFM alerts are not', () => {
	assert.equal(resolveType('NOTE'), 'note');
	assert.equal(resolveType('note'), 'note');
	assert.equal(resolveType('Note'), 'note');
	assert.equal(resolveType('  WaRnInG  '), 'warning');
});

test('aliases fold onto their canonical type', () => {
	assert.equal(resolveType('tldr'), 'abstract');
	assert.equal(resolveType('summary'), 'abstract');
	assert.equal(resolveType('hint'), 'tip');
	assert.equal(resolveType('important'), 'tip');
	assert.equal(resolveType('caution'), 'warning');
	assert.equal(resolveType('error'), 'danger');
	assert.equal(resolveType('cite'), 'quote');
	assert.equal(resolveType('faq'), 'question');
});

test('an unknown type is not in the table', () => {
	// resolveType names KNOWN types only; the tokenizer draws an unknown one
	// as a note (below).
	assert.equal(resolveType('nonsense'), null);
	assert.equal(resolveType(''), null);
	assert.equal(resolveType(undefined), null);
});

test('every GFM alert type is covered, so nothing regresses', () => {
	for (const t of ['note', 'tip', 'important', 'warning', 'caution']) {
		assert.ok(resolveType(t), `${t} should resolve`);
	}
});

// The tokenizer needs a lexer; a stub is enough to check what it PARSES,
// which is the part with the fiddly regex.
function tokenize(src) {
	const ctx = {
		lexer: { blockTokens: (text, out) => { out.push({ type: 'text', text }); return out; },
			inline: (text, out) => { out.push({ type: 'text', text }); return out; } },
	};
	return calloutBlock.tokenizer.call(ctx, src);
}

test('bare, titled, and both fold markers all parse', () => {
	assert.equal(tokenize('> [!note]\n> body\n').fold, null);
	assert.equal(tokenize('> [!note]\n> body\n').title, '');

	const titled = tokenize('> [!warning] Mind the gap\n> body\n');
	assert.equal(titled.calloutType, 'warning');
	assert.equal(titled.title, 'Mind the gap');
	assert.equal(titled.fold, null);

	assert.equal(tokenize('> [!question]- Later\n> body\n').fold, '-');
	assert.equal(tokenize('> [!question]+ Now\n> body\n').fold, '+');
	assert.equal(tokenize('> [!question]+ Now\n> body\n').title, 'Now');
});

test('the token consumes the whole blockquote and nothing after it', () => {
	const token = tokenize('> [!note] T\n> one\n> two\n\nAfter the callout.\n');
	assert.ok(token.raw.includes('two'), 'body consumed');
	assert.ok(!token.raw.includes('After the callout'), 'stopped at the blank line');
});

test('a blockquote that is not a callout is declined', () => {
	assert.equal(tokenize('> just a quote\n'), undefined);
});

test('an unknown type is a callout drawn as a note, titled as written (Obsidian\'s rule)', () => {
	const token = tokenize('> [!Nonsense]\n> body\n');
	assert.equal(token.calloutType, 'nonsense');
	assert.equal(untitledCalloutTitle('Nonsense'), 'Nonsense');
});

test('an untitled callout is headed by its type as written', () => {
	assert.equal(untitledCalloutTitle('note'), 'Note');
	assert.equal(untitledCalloutTitle('NOTE'), 'Note');
	assert.equal(untitledCalloutTitle('CAUTION'), 'Caution');   // an alias of warning
	assert.equal(untitledCalloutTitle('tldr'), 'Tldr');
	assert.equal(untitledCalloutTitle('my-type'), 'My-type');
	assert.equal(untitledCalloutTitle('suggestion'), 'Suggestion');
});
