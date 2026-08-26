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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admonitionFence } from '../vendor/clew/engine/admonitions.js';

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

test('an option-like first content line is not eaten as an option', () => {
	const token = tokenize('```ad-note\nfrom: a friend\n```\n');
	assert.equal(token.tokens[0].text, 'from: a friend');
});
