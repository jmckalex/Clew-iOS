// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Upstream's suite, over the vendored module on a real filesystem: proves the
// reference implementation the iOS mirror runs verbatim (services.test.js
// proves the same calls land on disk through the bridge).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	isTracked, snapshotBeforeWrite, listSnapshots, readSnapshot, renameHistory,
} from '../vendor/clew/main/history.js';

function makeVault() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-history-'));
	fs.mkdirSync(path.join(root, 'Sub'));
	fs.writeFileSync(path.join(root, 'A.md'), 'version one\n');
	fs.writeFileSync(path.join(root, 'Sub', 'B.md'), 'b text\n');
	return root;
}

/** Backdate a file so interval gating sees an old mtime. */
function backdate(abs, minutesAgo) {
	const t = new Date(Date.now() - minutesAgo * 60_000);
	fs.utimesSync(abs, t, t);
}

test('tracked extensions are notes and canvases, not binaries', () => {
	assert.equal(isTracked('A.md'), true);
	assert.equal(isTracked('a/b/C.jmd'), true);
	assert.equal(isTracked('Board.canvas'), true);
	assert.equal(isTracked('paper.pdf'), false);
	assert.equal(isTracked('deck.pptx'), false);
});

test('first overwrite snapshots the pre-image; a new note does not', () => {
	const root = makeVault();
	assert.equal(snapshotBeforeWrite(root, 'Nope.md', undefined), null);
	const id = snapshotBeforeWrite(root, 'A.md', undefined);
	assert.ok(id, 'existing note snapshots');
	const list = listSnapshots(root, 'A.md');
	assert.equal(list.length, 1);
	assert.equal(readSnapshot(root, 'A.md', list[0].id), 'version one\n');
});

test('snapshots are stamped with the content mtime, not the displacement time', () => {
	const root = makeVault();
	backdate(path.join(root, 'A.md'), 90);
	snapshotBeforeWrite(root, 'A.md', undefined);
	const [snap] = listSnapshots(root, 'A.md');
	assert.ok(Math.abs(snap.time - (Date.now() - 90 * 60_000)) < 2000);
});

test('interval gating: close saves collapse; force and elapsed time do not', () => {
	const root = makeVault();
	const abs = path.join(root, 'A.md');
	backdate(abs, 30);
	assert.ok(snapshotBeforeWrite(root, 'A.md', undefined));
	// Newer content written 14 minutes after the last snapshot: > 5 min.
	fs.writeFileSync(abs, 'version two\n');
	backdate(abs, 16);
	assert.ok(snapshotBeforeWrite(root, 'A.md', undefined), 'beyond the interval');
	// Two minutes later: inside the interval, skipped…
	fs.writeFileSync(abs, 'version three\n');
	backdate(abs, 14);
	assert.equal(snapshotBeforeWrite(root, 'A.md', undefined), null, 'inside the interval');
	// …unless forced (the restore path).
	assert.ok(snapshotBeforeWrite(root, 'A.md', undefined, { force: true }));
	assert.equal(listSnapshots(root, 'A.md').length, 3);
});

test('identical content is never snapshotted twice, even forced', () => {
	const root = makeVault();
	backdate(path.join(root, 'A.md'), 20);
	assert.ok(snapshotBeforeWrite(root, 'A.md', undefined));
	assert.equal(snapshotBeforeWrite(root, 'A.md', undefined, { force: true }), null);
	assert.equal(listSnapshots(root, 'A.md').length, 1);
});

test('history: false disables everything', () => {
	const root = makeVault();
	assert.equal(snapshotBeforeWrite(root, 'A.md', false), null);
	assert.deepEqual(listSnapshots(root, 'A.md'), []);
});

test('pruning drops beyond maxVersions and maxAgeDays, sparing the newest', () => {
	const root = makeVault();
	const abs = path.join(root, 'A.md');
	const opts = { minIntervalMinutes: 0, maxVersions: 3, maxAgeDays: 1 };
	for (let i = 0; i < 5; i++) {
		fs.writeFileSync(abs, `content ${i}\n`);
		backdate(abs, 50 - i);
		assert.ok(snapshotBeforeWrite(root, 'A.md', opts));
	}
	assert.equal(listSnapshots(root, 'A.md').length, 3, 'count cap');
	// Age cap: a single ancient snapshot survives as the fallback version.
	const root2 = makeVault();
	const abs2 = path.join(root2, 'A.md');
	backdate(abs2, 3 * 24 * 60);
	assert.ok(snapshotBeforeWrite(root2, 'A.md', opts));
	fs.writeFileSync(abs2, 'newer\n');
	backdate(abs2, 2 * 24 * 60);
	assert.ok(snapshotBeforeWrite(root2, 'A.md', opts));
	const left = listSnapshots(root2, 'A.md');
	assert.equal(left.length, 1, 'aged snapshots pruned');
	assert.equal(readSnapshot(root2, 'A.md', left[0].id), 'newer\n', 'newest spared');
});

test('renameHistory moves a note directory and a whole folder alike', () => {
	const root = makeVault();
	backdate(path.join(root, 'Sub', 'B.md'), 20);
	snapshotBeforeWrite(root, 'Sub/B.md', undefined);
	renameHistory(root, 'Sub/B.md', 'Sub/C.md');
	assert.equal(listSnapshots(root, 'Sub/B.md').length, 0);
	assert.equal(listSnapshots(root, 'Sub/C.md').length, 1);
	renameHistory(root, 'Sub', 'Moved');
	assert.equal(listSnapshots(root, 'Moved/C.md').length, 1);
});

test('readSnapshot refuses ids that are not bare snapshot names', () => {
	const root = makeVault();
	backdate(path.join(root, 'A.md'), 20);
	snapshotBeforeWrite(root, 'A.md', undefined);
	assert.throws(() => readSnapshot(root, 'A.md', '../../A.md'));
	assert.throws(() => readSnapshot(root, 'A.md', 'junk.md'));
});
