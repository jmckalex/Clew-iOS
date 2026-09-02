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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../vendor/clew/main/fs-utils.js';

function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'clew-atomic-'));
}

test('creates a new file, string and Buffer alike', () => {
	const dir = tempDir();
	writeFileAtomic(path.join(dir, 'note.md'), '# Hello\n');
	assert.equal(fs.readFileSync(path.join(dir, 'note.md'), 'utf8'), '# Hello\n');
	writeFileAtomic(path.join(dir, 'bytes.bin'), Buffer.from([0, 1, 2, 255]));
	assert.deepEqual([...fs.readFileSync(path.join(dir, 'bytes.bin'))], [0, 1, 2, 255]);
});

test('replaces an existing file and leaves no temp behind', () => {
	const dir = tempDir();
	const file = path.join(dir, 'note.md');
	fs.writeFileSync(file, 'old');
	writeFileAtomic(file, 'new content');
	assert.equal(fs.readFileSync(file, 'utf8'), 'new content');
	assert.deepEqual(fs.readdirSync(dir), ['note.md']);
});

test('writes through a symlink instead of replacing it', () => {
	const dir = tempDir();
	const real = path.join(dir, 'real.md');
	const link = path.join(dir, 'link.md');
	fs.writeFileSync(real, 'old');
	fs.symlinkSync(real, link);
	writeFileAtomic(link, 'via link');
	assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
	assert.equal(fs.readFileSync(real, 'utf8'), 'via link');
});

test('preserves the target permissions across the inode swap', () => {
	const dir = tempDir();
	const file = path.join(dir, 'script.sh');
	fs.writeFileSync(file, '#!/bin/sh\n');
	fs.chmodSync(file, 0o755);
	writeFileAtomic(file, '#!/bin/sh\necho hi\n');
	assert.equal(fs.statSync(file).mode & 0o777, 0o755);
});

test('a temp orphaned by a crash is swept by the next save', () => {
	const dir = tempDir();
	const file = path.join(dir, 'note.md');
	fs.writeFileSync(path.join(dir, '.note.md.clew-tmp'), 'half-written garb');
	writeFileAtomic(file, 'fresh');
	assert.equal(fs.readFileSync(file, 'utf8'), 'fresh');
	assert.deepEqual(fs.readdirSync(dir), ['note.md']);
});

test('the temp name is a dotfile, so vault walks and the watcher skip it', () => {
	// Locks in the naming contract the watcher-invisibility argument rests
	// on: if the prefix ever changes, this fails before the UI flickers.
	const dir = tempDir();
	const seen = [];
	const orig = fs.renameSync;
	fs.renameSync = (from, to) => { seen.push(path.basename(from)); return orig(from, to); };
	try {
		writeFileAtomic(path.join(dir, 'note.md'), 'x');
	} finally {
		fs.renameSync = orig;
	}
	assert.equal(seen.length, 1);
	assert.ok(seen[0].startsWith('.'), `temp ${seen[0]} must be a dotfile`);
});
