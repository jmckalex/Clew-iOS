// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Owns the workspace layout state; wraps the pure tree helpers and emits
// events. Persists (debounced) to <vault>/.clew/workspace.json via IPC.
import { Emitter } from '../lib/emitter.js';
import { debounce } from '../lib/debounce.js';
import { ipc, CH } from '../ipc.js';
import * as tree from '../workspace/tree.js';
import { settingsStore } from './settings-store.js';

class WorkspaceStore extends Emitter {
	state = tree.createInitialState();
	#closeGuards = [];
	#persist = debounce(() => {
		ipc.invoke(CH.WORKSPACE_SAVE, tree.serialize(this.state)).catch(() => {});
	}, 500);

	/**
	 * Close guards let a tab owner intercept its close (the office dock uses
	 * this for its Save / Discard / Cancel moment — nothing else auto-saves
	 * too late to matter). A guard returns null to wave the close through,
	 * or a Promise<boolean> to take it over: the close is abandoned NOW and
	 * re-issued with force once the promise says the user chose to proceed.
	 */
	registerCloseGuard(fn) {
		this.#closeGuards.push(fn);
	}

	#guardClose(tabs) {
		for (const tab of tabs) {
			for (const guard of this.#closeGuards) {
				const claim = guard(tab);
				if (claim) return claim;
			}
		}
		return null;
	}

	// ---- queries ----
	get root() { return this.state.root; }
	get activeGroupId() { return this.state.activeGroupId; }
	activeGroup() { return tree.activeGroup(this.state); }
	activeTab() { return tree.activeTab(this.state); }
	findTab(tabId) { return tree.findTab(this.state.root, tabId); }
	allGroups() { return tree.allGroups(this.state.root); }

	/** Every open tab id (for the editor pool to reap against). */
	openTabIds() {
		return new Set(this.allGroups().flatMap((g) => g.tabs.map((t) => t.id)));
	}

	// ---- lifecycle ----
	async restore(noteExists) {
		const saved = await ipc.invoke(CH.WORKSPACE_LOAD).catch(() => null);
		this.state = tree.deserialize(saved, { noteExists }) ?? tree.createInitialState();
		this.emit('workspace-restored');
		this.emit('layout-changed');
	}

	reset() {
		this.state = tree.createInitialState();
		this.emit('workspace-restored');
		this.emit('layout-changed');
	}

	// ---- mutations (each emits and schedules persistence) ----
	#commit(event = 'layout-changed', payload) {
		this.emit(event, payload);
		this.#persist();
	}

	openNote(path, opts) {
		const setting = settingsStore.get('newTabMode');
		const defaultMode = setting === 'reading' || setting === 'live' ? setting : null;
		const tab = tree.openNote(this.state, path, { defaultMode, ...opts });
		this.#commit();
		return tab;
	}

	openFile(path, opts) {
		const tab = tree.openFile(this.state, path, opts);
		this.#commit();
		return tab;
	}

	openCanvas(path, opts) {
		const tab = tree.openCanvasFile(this.state, path, opts);
		this.#commit();
		return tab;
	}

	openTab(groupId, tab, opts) {
		tree.openTab(this.state, groupId, tab, opts);
		this.#commit();
		return tab;
	}

	closeTab(tabId, { force = false } = {}) {
		if (!force) {
			const found = this.findTab(tabId);
			const claim = found && this.#guardClose([found.tab]);
			if (claim) {
				claim.then((proceed) => {
					if (proceed) this.closeTab(tabId, { force: true });
				});
				return;
			}
		}
		tree.closeTab(this.state, tabId);
		this.#commit();
	}

	activateTab(tabId) {
		tree.activateTab(this.state, tabId);
		this.#commit('active-changed');
	}

	setActiveGroup(groupId) {
		if (this.state.activeGroupId === groupId) return;
		this.state.activeGroupId = groupId;
		this.#commit('active-changed');
	}

	moveTab(tabId, toGroupId, index) {
		tree.moveTab(this.state, tabId, toGroupId, index);
		this.#commit();
	}

	splitGroup(groupId, edge, tab) {
		const group = tree.splitGroup(this.state, groupId, edge, tab);
		this.#commit();
		return group;
	}

	splitWithTab(targetGroupId, edge, tabId) {
		const group = tree.splitWithTab(this.state, targetGroupId, edge, tabId);
		this.#commit();
		return group;
	}

	splitWithClone(targetGroupId, edge, tabId) {
		const group = tree.splitWithClone(this.state, targetGroupId, edge, tabId);
		this.#commit();
		return group;
	}

	/** Close a whole split pane; returns the closed tab ids ([] when a close
	 *  guard deferred the close — orphaned editors are reaped either way). */
	closeGroup(groupId, { force = false } = {}) {
		if (!force) {
			const group = this.allGroups().find((g) => g.id === groupId);
			const claim = group && this.#guardClose(group.tabs);
			if (claim) {
				claim.then((proceed) => {
					if (proceed) this.closeGroup(groupId, { force: true });
				});
				return [];
			}
		}
		const closed = tree.closeGroup(this.state, groupId);
		this.#commit();
		return closed;
	}

	setSplitSizes(splitId, sizes) {
		tree.setSplitSizes(this.state, splitId, sizes);
		this.#commit('sizes-changed', { splitId, sizes });
	}

	navigate(tabId, path, kind = 'note') {
		tree.navigateTab(this.state, tabId, path, kind);
		this.#commit();
	}

	recordAnchorJump(tabId, fromLine, toLine, options) {
		if (tree.recordAnchorJump(this.state, tabId, fromLine, toLine, options)) this.#commit();
	}

	goBack(tabId) {
		if (tree.goBack(this.state, tabId)) this.#commit();
	}

	goForward(tabId) {
		if (tree.goForward(this.state, tabId)) this.#commit();
	}

	pinTab(tabId, pinned) {
		tree.pinTab(this.state, tabId, pinned);
		this.#commit();
	}

	setTabMode(tabId, mode) {
		const found = this.findTab(tabId);
		if (!found) return;
		// Remember the editing mode, so ⌘E from reading returns to it.
		const editChanged = mode !== 'reading' && found.tab.view.editMode !== mode;
		if (editChanged) found.tab.view.editMode = mode;
		if (found.tab.view.mode === mode) {
			if (editChanged) this.#persist();
			return;
		}
		found.tab.view.mode = mode;
		this.#commit();
	}

	/** Update a tab's persisted view state (cursor, scroll, mode) silently. */
	updateTabView(tabId, patch) {
		const found = this.findTab(tabId);
		if (!found) return;
		Object.assign(found.tab.view, patch);
		this.#persist();
	}

	/**
	 * The file explorer's closed folders. Silent like updateTabView: the
	 * explorer has already redrawn itself by the time it tells us, and a
	 * layout-changed here would put every other panel through a render for a
	 * disclosure triangle.
	 */
	get collapsedFolders() {
		return this.state.collapsedFolders ?? [];
	}

	setCollapsedFolders(paths) {
		this.state.collapsedFolders = [...paths];
		this.#persist();
	}

	/** The shell panel's state — open/closed and its height. */
	get shell() {
		return this.state.shell ?? { open: false, height: 220 };
	}

	setShell(patch) {
		this.state.shell = { ...this.shell, ...patch };
		this.#commit('shell-changed');
	}

	setSidebar(side, patch) {
		Object.assign(this.state.sidebars[side], patch);
		this.#commit('sidebar-changed', side);
	}

	/** Rewrite tab paths after a file rename/move. */
	remapPaths(fromPath, toPath) {
		let touched = false;
		for (const group of this.allGroups()) {
			for (const tab of group.tabs) {
				if (tab.kind !== 'note') continue;
				if (tab.path === fromPath) { tab.path = toPath; touched = true; }
				else if (tab.path?.startsWith(fromPath + '/')) {
					tab.path = toPath + tab.path.slice(fromPath.length);
					touched = true;
				}
			}
		}
		if (touched) this.#commit();
	}
}

export const workspaceStore = new WorkspaceStore();
