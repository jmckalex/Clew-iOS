// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The two exclusion lists in vault-settings.json (src/main/vault-excludes.js)
// — `unindexed` (listed and openable, but not indexed and not watched) and
// `hidden` (not there at all). The owner's ask, 2026-09-25: a vault can
// contain anything, so a vault must be able to say which parts of itself
// Clew should leave alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileExcludes, compilePattern, relativeTo, BUILTIN_HIDDEN } from '../vendor/clew/main/vault-excludes.js';

test('a plain path means that path and everything under it', () => {
	const re = compilePattern('Archive/2019');
	assert.ok(re.test('Archive/2019'));
	assert.ok(re.test('Archive/2019/January/note.md'));
	assert.ok(!re.test('Archive/2018'));
	assert.ok(!re.test('Archive'));            // the parent is not excluded
	assert.ok(!re.test('Other/Archive/2019')); // patterns are vault-relative
});

test('* stays inside one segment; ** crosses any number, including none', () => {
	const one = compilePattern('*/libs');
	assert.ok(one.test('econ-and-id/libs'));
	assert.ok(one.test('voting-theory/libs/css/theme.css'));
	assert.ok(!one.test('libs'));                        // needs its one segment
	assert.ok(!one.test('a/b/libs'));                    // and only one

	const any = compilePattern('**/node_modules');
	assert.ok(any.test('node_modules'), 'a top-level node_modules must match');
	assert.ok(any.test('libs/v2026/node_modules'));
	assert.ok(any.test('a/b/c/node_modules/pkg/index.js'));
	assert.ok(!any.test('my_node_modules'));
});

test('a file pattern works as well as a folder one', () => {
	const logs = compilePattern('*.log');
	assert.ok(logs.test('build.log'));
	assert.ok(!logs.test('Notes/build.log'));  // one segment, as written
	assert.ok(compilePattern('**/*.log').test('Notes/deep/build.log'));
});

test('a line that means nothing is dropped rather than obeyed', () => {
	// A stray or dangerous line in a hand-edited file must not take the
	// whole vault with it.
	for (const bad of ['', '   ', '/', '/etc', '../outside', '..', null, undefined]) {
		assert.equal(compilePattern(bad), null, JSON.stringify(bad));
	}
	assert.ok(compilePattern('./Archive').test('Archive/x.md'), 'a leading ./ is tolerated');
	assert.ok(compilePattern('Archive/').test('Archive/x.md'), 'so is a trailing slash');
});

test('the built-ins hold whatever the vault says', () => {
	const { isHidden } = compileExcludes({});
	for (const dir of BUILTIN_HIDDEN) {
		assert.ok(isHidden(`${dir}/thing`), dir);
		assert.ok(isHidden(`Notes/${dir}/thing`), `nested ${dir}`);
	}
	assert.ok(isHidden('.DS_Store'));
	assert.ok(isHidden('Notes/.hidden/file.md'));
	assert.ok(!isHidden('Notes/Ordinary.md'));
});

test('unindexed: listed, so not hidden — but never indexed', () => {
	const { isHidden, isUnindexed } = compileExcludes({ unindexed: ['*/libs'] });
	assert.equal(isHidden('econ-and-id/libs/css/theme.css'), false, 'still listed in the explorer');
	assert.equal(isUnindexed('econ-and-id/libs/css/theme.css'), true, 'but not indexed or watched');
	assert.equal(isUnindexed('econ-and-id/Notes.md'), false);
});

test('hidden implies unindexed — what is not there cannot be indexed', () => {
	const { isHidden, isUnindexed } = compileExcludes({ hidden: ['Archive'] });
	assert.ok(isHidden('Archive/old.md'));
	assert.ok(isUnindexed('Archive/old.md'), 'one call answers for the walks that only care about this');
});

test('the two lists compose, and neither touches the rest of the vault', () => {
	const { isHidden, isUnindexed } = compileExcludes({
		hidden: ['**/node_modules', 'Archive/2019'],
		unindexed: ['*/libs', 'Scans'],
	});
	assert.ok(isHidden('libs/v2026/node_modules/x.js'));
	assert.ok(isHidden('Archive/2019/jan.md'));
	assert.ok(!isHidden('Scans/page1.png'));
	assert.ok(isUnindexed('Scans/page1.png'));
	assert.ok(!isUnindexed('Notes/Real Note.md'));
	assert.ok(!isHidden('Notes/Real Note.md'));
});

test('junk in the settings file cannot break a vault open', () => {
	for (const settings of [null, undefined, {}, { hidden: 'nope' }, { unindexed: [null, 42, ''] }]) {
		const { isHidden, isUnindexed } = compileExcludes(settings);
		assert.equal(isHidden('Notes/Note.md'), false);
		assert.equal(isUnindexed('Notes/Note.md'), false);
		assert.equal(isHidden('.git/HEAD'), true, 'the built-ins still hold');
	}
});

test('relativeTo: the watcher asks in absolute paths', () => {
	assert.equal(relativeTo('/vault', '/vault/Notes/a.md'), 'Notes/a.md');
	assert.equal(relativeTo('/vault', '/vault'), null);          // the root itself
	assert.equal(relativeTo('/vault', '/elsewhere/a.md'), null); // outside
});
