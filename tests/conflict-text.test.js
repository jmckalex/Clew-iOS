// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The text side of edit-conflict safety (src/shim/conflict-text.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyStamp, conflictSiblingPath, findDropboxCopies, hasGitConflictMarkers, lineDiff } from '../vendor/clew/shared/conflict-text.js';

test('history stamps use history.js\'s naming, so the note-history browser lists them', () => {
	const ms = new Date(2026, 9, 3, 7, 5, 9).getTime();
	assert.equal(historyStamp(ms), '2026-10-03 07.05.09');
	assert.match(historyStamp(Date.now()), /^\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}$/);
});

test('the "(conflict date)" sibling sits beside the note and never takes an existing name', () => {
	const d = new Date(2026, 9, 3);
	assert.equal(conflictSiblingPath('Notes/Plan.md', () => false, d), 'Notes/Plan (conflict 2026-10-03).md');
	const taken = new Set(['Plan (conflict 2026-10-03).md', 'Plan (conflict 2026-10-03 2).md']);
	assert.equal(conflictSiblingPath('Plan.md', (p) => taken.has(p), d), 'Plan (conflict 2026-10-03 3).md');
	assert.equal(conflictSiblingPath('README', () => false, d), 'README (conflict 2026-10-03)');
});

test('Dropbox conflicted copies are paired with their notes, by name, in their folder', () => {
	const paths = [
		'Plan.md',
		"Plan (Jason's conflicted copy 2026-10-03).md",
		'Ideas/Draft.md',
		'Ideas/Draft (Ann’s conflicted copy).md',
		"Gone (Bob's conflicted copy 2026-10-01 (1)).md",   // its note no longer exists
		'Not a copy (just parentheses).md',
	];
	const found = findDropboxCopies(paths);
	assert.deepEqual(found.map((f) => [f.base, f.who, f.date]), [
		['Plan.md', 'Jason', '2026-10-03'],
		['Ideas/Draft.md', 'Ann', null],
	]);
});

test('git conflict markers: all three, each at a line start', () => {
	assert.equal(hasGitConflictMarkers('a\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> origin/main\nb'), true);
	assert.equal(hasGitConflictMarkers('a\n=======\nb'), false, 'a setext rule alone is not a conflict');
	assert.equal(hasGitConflictMarkers('text <<<<<<< HEAD inline'), false);
});

test('the line diff: common head and tail, the changes between, null past the cap', () => {
	const d = lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne');
	assert.deepEqual(d.map((x) => x.op + x.text), [' a', '-b', '+B', ' c', ' d', '+e']);
	assert.deepEqual(lineDiff('same', 'same').map((x) => x.op), [' ']);
	const big = Array.from({ length: 3000 }, (_, i) => `x${i}`).join('\n');
	assert.equal(lineDiff(big, big.replace(/x/g, 'y')), null, 'too large to compare line by line');
});
