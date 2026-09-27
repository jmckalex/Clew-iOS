// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// A fragment build (live-edit block, canvas card) renders a temp file; the
// `<key>.source` sidecar render-service leaves beside it names the note it
// belongs to, and engine/vault-model.js#currentFilePath answers with that
// note — so Dataview `this` in a block is the note, as in reading mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentFilePath } from '../vendor/clew/engine/vault-model.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-frag-'));
const dir = path.join(root, '.clew', 'cache', 'fragments');
fs.mkdirSync(dir, { recursive: true });
process.env.CLEW_VAULT_ROOT = root;

test('an ordinary build: the file being built', () => {
	global.current_file = path.join(root, 'Notes', 'A.md');
	assert.equal(currentFilePath(), path.join(root, 'Notes', 'A.md'));
});

test('a fragment with a sidecar: the note it belongs to', () => {
	fs.writeFileSync(path.join(dir, 'abc.md'), 'x');
	fs.writeFileSync(path.join(dir, 'abc.source'), 'Projects/Plan.md');
	global.current_file = path.join(dir, 'abc.md');
	assert.equal(currentFilePath(), path.join(root, 'Projects', 'Plan.md'));
});

test('a fragment without one: the temp file, as before', () => {
	fs.writeFileSync(path.join(dir, 'def.md'), 'x');
	global.current_file = path.join(dir, 'def.md');
	assert.equal(currentFilePath(), path.join(dir, 'def.md'));
});

test('stdin is nothing', () => {
	global.current_file = '<stdin>';
	assert.equal(currentFilePath(), null);
});
