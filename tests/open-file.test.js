// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The guards on handing a file to the OS: pathFromFileUrl's parsing, and
// planOpen's refusals. planOpen decides; ipc.js performs the shell.openPath,
// so every security-relevant choice is pure and testable under plain node.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathFromFileUrl, planOpen } from '../vendor/clew/main/open-file.js';

// One temp root for this file, removed when it is done: fixtures used to
// be left in the system's temp folder, thousands of them over the runs.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-open-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test('file:// URLs become local paths; anything else is refused', () => {
	assert.equal(pathFromFileUrl('file:///Users/x/paper.pdf'), '/Users/x/paper.pdf');
	assert.equal(pathFromFileUrl('file://localhost/Users/x/paper.pdf'), '/Users/x/paper.pdf');
	// Percent-encoding is undone — a space in a filename is the common case.
	assert.equal(pathFromFileUrl('file:///Users/x/my%20paper.pdf'), '/Users/x/my paper.pdf');
	// A remote host is not a local file, whatever it looks like.
	assert.equal(pathFromFileUrl('file://evil.example.com/share/x.pdf'), null);
	assert.equal(pathFromFileUrl('https://example.com/x.pdf'), null);
	assert.equal(pathFromFileUrl('not a url'), null);
	assert.equal(pathFromFileUrl(''), null);
});

test('refusals: missing files, escapes, and executables', () => {
	const open = planOpen;
	const root = fs.mkdtempSync(path.join(tmpRoot, 'clew-open-'));
	fs.writeFileSync(path.join(root, 'paper.pdf'), '%PDF-1.4\n');
	fs.writeFileSync(path.join(root, 'macro.exe'), 'MZ');
	fs.mkdirSync(path.join(root, 'Thing.app'));
	const vaults = {
		isOpen: true,
		resolve(rel) {
			const abs = path.resolve(root, rel);
			if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('escape');
			return abs;
		},
	};

	assert.match(open(vaults, { rel: 'nope.pdf' }).reason, /Not found/);
	assert.match(open(vaults, { rel: '../outside.pdf' }).reason, /escapes the vault/);
	assert.match(open(vaults, { abs: path.join(root, 'nope.pdf') }).reason, /Not found/);
	assert.equal(open(vaults, {}).reason, 'Nothing to open');

	// Programs are refused BY NAME, in both shapes — a .app is a directory,
	// so the extension check has to run on directories too.
	assert.match(open(vaults, { rel: 'macro.exe' }).reason, /does not open \.exe/);
	assert.match(open(vaults, { abs: path.join(root, 'macro.exe') }).reason, /does not open \.exe/);
	assert.match(open(vaults, { rel: 'Thing.app' }).reason, /does not open \.app/);

	// A vault-relative open with no vault has nowhere to resolve against.
	assert.match(open({ isOpen: false }, { rel: 'paper.pdf' }).reason, /No vault open/);

	// And the allowed case resolves to the file the caller should open.
	const ok = open(vaults, { rel: 'paper.pdf' });
	assert.equal(ok.ok, true);
	assert.equal(ok.target, path.join(root, 'paper.pdf'));
	assert.equal(open(vaults, { abs: path.join(root, 'paper.pdf') }).ok, true);

	fs.rmSync(root, { recursive: true, force: true });
});
