// Owns the workspace layout state; wraps the pure tree helpers and emits
// events. Persists (debounced) to <vault>/.clew/workspace.json via IPC.
import { Emitter } from '../lib/emitter.js';
import { debounce } from '../lib/debounce.js';
import { ipc, CH } from '../ipc.js';
import * as tree from '../workspace/tree.js';
import { settingsStore } from './settings-store.js';

class WorkspaceStore extends Emitter {
	state = tree.createInitialState();
	#persist = debounce(() => {
		ipc.invoke(CH.WORKSPACE_SAVE, tree.serialize(this.state)).catch(() => {});
	}, 500);

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
		this.emit('layout-changed');
	}

	reset() {
		this.state = tree.createInitialState();
		this.emit('layout-changed');
	}

	// ---- mutations (each emits and schedules persistence) ----
	#commit(event = 'layout-changed', payload) {
		this.emit(event, payload);
		this.#persist();
	}

	openNote(path, opts) {
		const defaultMode = settingsStore.get('newTabMode') === 'reading' ? 'reading' : null;
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

	closeTab(tabId) {
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

	/** Close a whole split pane; returns the closed tab ids. */
	closeGroup(groupId) {
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
		if (!found || found.tab.view.mode === mode) return;
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
