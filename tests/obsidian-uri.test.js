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
import { planObsidianUri } from '../vendor/clew/shared/obsidian-uri.js';

test('non-obsidian URLs are not claimed', () => {
	assert.equal(planObsidianUri('https://example.com'), null);
	assert.equal(planObsidianUri('not a url'), null);
	assert.equal(planObsidianUri('mailto:x@y.z'), null);
});

test('open: file, path, and the vault shorthand', () => {
	assert.deepEqual(planObsidianUri('obsidian://open?vault=Main&file=Projects%2FAlpha'),
		{ kind: 'open', file: 'Projects/Alpha' });
	assert.deepEqual(planObsidianUri('obsidian://open?path=Notes%2FDeep%20Work.md'),
		{ kind: 'open', file: 'Notes/Deep Work.md' });
	assert.deepEqual(planObsidianUri('obsidian://vault/My%20Vault/Daily/2024-01-01'),
		{ kind: 'open', file: 'Daily/2024-01-01' });
	assert.equal(planObsidianUri('obsidian://open').kind, 'unsupported');
});

test('search and show-plugin map to Clew equivalents', () => {
	assert.deepEqual(planObsidianUri('obsidian://search?query=deep%20work'),
		{ kind: 'search', query: 'deep work' });
	// bramses' README recommends Full Calendar exactly this way.
	assert.deepEqual(planObsidianUri('obsidian://show-plugin?id=obsidian-full-calendar'),
		{ kind: 'web', url: 'https://obsidian.md/plugins?id=obsidian-full-calendar' });
});

test('everything else is unsupported BY NAME', () => {
	assert.deepEqual(planObsidianUri('obsidian://new?vault=X&name=Y'),
		{ kind: 'unsupported', action: 'new' });
	assert.equal(planObsidianUri('obsidian://hook-get-address').action, 'hook-get-address');
});
