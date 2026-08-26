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
import * as tree from '../vendor/clew/renderer/workspace/tree.js';

function stateWithNotes(...paths) {
	const state = tree.createInitialState();
	for (const path of paths) {
		tree.openTab(state, state.root.id, tree.createTab('note', path));
	}
	return state;
}

test('openNote reuses an existing tab for the same path', () => {
	const state = stateWithNotes('a.md', 'b.md');
	const group = tree.activeGroup(state);
	assert.equal(group.tabs.length, 2);
	tree.openNote(state, 'a.md');
	assert.equal(group.tabs.length, 2);
	assert.equal(tree.activeTab(state).path, 'a.md');
});

test('openNote navigates the active tab in place and records history', () => {
	const state = stateWithNotes('a.md');
	tree.openNote(state, 'b.md');
	const group = tree.activeGroup(state);
	assert.equal(group.tabs.length, 1);
	const tab = tree.activeTab(state);
	assert.equal(tab.path, 'b.md');
	assert.equal(tab.history.back.length, 1);
	assert.ok(tree.goBack(state, tab.id));
	assert.equal(tab.path, 'a.md');
	assert.ok(tree.goForward(state, tab.id));
	assert.equal(tab.path, 'b.md');
});

test('anchor jumps are history too, browser-style', () => {
	const state = stateWithNotes('a.md');
	const tab = tree.activeTab(state);
	assert.ok(tree.recordAnchorJump(state, tab.id, 12, 340));
	assert.equal(tab.path, 'a.md', 'same note');
	assert.equal(tab.view.cursorLine, 340, 'the view moved to the target');
	assert.ok(tree.goBack(state, tab.id));
	assert.equal(tab.path, 'a.md');
	assert.equal(tab.view.cursorLine, 12, 'Back restores the departure line');
	assert.ok(tree.goForward(state, tab.id));
	assert.equal(tab.view.cursorLine, 340, 'Forward re-jumps');
	// A jump after going back prunes the forward stack, like a browser.
	assert.ok(tree.goBack(state, tab.id));
	assert.ok(tree.recordAnchorJump(state, tab.id, 12, 64));
	assert.equal(tab.history.forward.length, 0);
});

test('openNote with newTab opens a second tab', () => {
	const state = stateWithNotes('a.md');
	tree.openNote(state, 'b.md', { newTab: true });
	assert.equal(tree.activeGroup(state).tabs.length, 2);
});

test('closing the last tab keeps a (single, empty) group', () => {
	const state = stateWithNotes('a.md');
	tree.closeTab(state, tree.activeTab(state).id);
	assert.equal(state.root.type, 'tabs');
	assert.equal(state.root.tabs.length, 0);
	assert.equal(state.activeGroupId, state.root.id);
});

test('splitGroup right creates a row split; closing collapses it back', () => {
	const state = stateWithNotes('a.md');
	const originalGroup = state.root.id;
	const newGroup = tree.splitGroup(state, originalGroup, 'right', tree.createTab('note', 'b.md'));
	assert.equal(state.root.type, 'split');
	assert.equal(state.root.dir, 'row');
	assert.equal(state.root.children.length, 2);
	assert.equal(state.activeGroupId, newGroup.id);

	tree.closeTab(state, newGroup.tabs[0].id);
	assert.equal(state.root.type, 'tabs');
	assert.equal(state.root.id, originalGroup);
});

test('same-direction splits flatten into one n-ary split', () => {
	const state = stateWithNotes('a.md');
	tree.splitGroup(state, state.root.id, 'right', tree.createTab('note', 'b.md'));
	const middle = state.root.children[1];
	tree.splitGroup(state, middle.id, 'right', tree.createTab('note', 'c.md'));
	tree.normalize(state);
	assert.equal(state.root.children.length, 3);
	assert.ok(state.root.children.every((c) => c.type === 'tabs'));
	const total = state.root.sizes.reduce((a, b) => a + b, 0);
	assert.ok(Math.abs(total - 1) < 1e-9);
});

test('splitWithTab moves the tab and prunes an emptied source group', () => {
	const state = stateWithNotes('a.md');
	const groupA = state.root.id;
	const groupB = tree.splitGroup(state, groupA, 'right', tree.createTab('note', 'b.md'));
	// Move b.md below groupA; groupB empties and is pruned.
	tree.splitWithTab(state, groupA, 'bottom', groupB.tabs[0].id);
	assert.equal(state.root.type, 'split');
	assert.equal(state.root.dir, 'col');
	assert.equal(tree.allGroups(state.root).length, 2);
	const paths = tree.allGroups(state.root).flatMap((g) => g.tabs.map((t) => t.path));
	assert.deepEqual(paths.sort(), ['a.md', 'b.md']);
});

test('moveTab between groups activates at the destination', () => {
	const state = stateWithNotes('a.md', 'b.md');
	const groupA = state.root.id;
	const groupB = tree.splitGroup(state, groupA, 'right', tree.createTab('note', 'c.md'));
	const tabA = tree.findGroup(state.root, groupA).tabs[0];
	tree.moveTab(state, tabA.id, groupB.id, 0);
	assert.equal(tree.findGroup(state.root, groupB.id).tabs.length, 2);
	assert.equal(tree.findGroup(state.root, groupB.id).activeTabId, tabA.id);
	assert.equal(tree.findGroup(state.root, groupA).tabs.length, 1);
});

test('serialize/deserialize round-trips and drops dead note paths', () => {
	const state = stateWithNotes('a.md', 'gone.md');
	tree.splitGroup(state, state.root.id, 'bottom', tree.createTab('note', 'b.md'));
	const json = tree.serialize(state);
	const restored = tree.deserialize(json, { noteExists: (p) => p !== 'gone.md' });
	const paths = tree.allGroups(restored.root).flatMap((g) => g.tabs.map((t) => t.path));
	assert.deepEqual(paths.sort(), ['a.md', 'b.md']);
	// New ids never collide with restored ones.
	const fresh = tree.createTab('note', 'x.md');
	assert.ok(!tree.findTab(restored.root, fresh.id));
});

test('deserialize rejects junk', () => {
	assert.equal(tree.deserialize(null), null);
	assert.equal(tree.deserialize({ version: 99 }), null);
});

test('pinned tabs sort first and never navigate away', () => {
	const state = stateWithNotes('a.md', 'b.md', 'c.md');
	const group = tree.activeGroup(state);
	const tabC = group.tabs[2];
	tree.pinTab(state, tabC.id, true);
	assert.equal(group.tabs[0].id, tabC.id); // pinned moved to the front
	assert.equal(tabC.pinned, true);

	// Opening a note while the pinned tab is active opens a NEW tab.
	tree.activateTab(state, tabC.id);
	const before = group.tabs.length;
	tree.openNote(state, 'd.md');
	assert.equal(group.tabs.length, before + 1);
	assert.equal(tabC.path, 'c.md');

	// History is frozen while pinned.
	assert.equal(tree.goBack(state, tabC.id), false);

	// Unpinning restores normal behavior and clears the flag.
	tree.pinTab(state, tabC.id, false);
	assert.equal('pinned' in tabC, false);
});

test('moveTab keeps the pinned region at the front', () => {
	const state = stateWithNotes('a.md', 'b.md', 'c.md');
	const group = tree.activeGroup(state);
	tree.pinTab(state, group.tabs[0].id, true); // pin a.md
	const tabB = group.tabs.find((t) => t.path === 'b.md');
	tree.moveTab(state, tabB.id, group.id, 0); // try to drop before the pin
	assert.equal(group.tabs[0].path, 'a.md'); // pin stays first
});

test('defaultMode applies to new note tabs only', () => {
	const state = tree.createInitialState();
	const created = tree.openNote(state, 'a.md', { defaultMode: 'reading' });
	assert.equal(created.view.mode, 'reading');
	// Navigation-in-place inherits the pane's current mode…
	const same = tree.openNote(state, 'b.md', { defaultMode: 'source' });
	assert.equal(same.id, created.id);
	assert.equal(same.view.mode, 'reading');
	// …and activating an existing tab never touches its mode.
	tree.openNote(state, 'c.md', { newTab: true, defaultMode: 'source' });
	const back = tree.openNote(state, 'b.md', { defaultMode: 'source' });
	assert.equal(back.view.mode, 'reading');
});
