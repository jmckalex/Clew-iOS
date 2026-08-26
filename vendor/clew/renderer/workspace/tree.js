// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The workspace layout: an n-ary tree of splits whose leaves are tab groups.
// Pure(ish) helpers that mutate a state object in place; the workspace store
// wraps them and emits events. State is JSON-safe by construction.
//
//   SplitNode    { type:'split', id, dir:'row'|'col', sizes:[…], children:[…] }
//   TabGroupNode { type:'tabs',  id, tabs:[Tab], activeTabId }
//   Tab          { id, kind:'note'|…, path?, view:{mode,cursor?,scrollTop?},
//                  history:{back:[], forward:[]} }

let idCounter = 1;
const nextId = (prefix) => `${prefix}${idCounter++}`;

const HISTORY_LIMIT = 50;

export function createTab(kind, path = null) {
	return {
		id: nextId('t'),
		kind,
		path,
		view: { mode: 'source' },
		history: { back: [], forward: [] },
	};
}

export function createGroup(tabs = []) {
	return { type: 'tabs', id: nextId('g'), tabs, activeTabId: tabs[0]?.id ?? null };
}

export function createInitialState() {
	const group = createGroup();
	return {
		version: 1,
		root: group,
		activeGroupId: group.id,
		sidebars: {
			left: { open: true, width: 260, activeTool: 'files' },
			right: { open: true, width: 290, activeTool: 'backlinks' },
		},
	};
}

// ---- lookups --------------------------------------------------------------

export function allGroups(node, out = []) {
	if (node.type === 'tabs') out.push(node);
	else for (const child of node.children) allGroups(child, out);
	return out;
}

export function findGroup(root, groupId) {
	return allGroups(root).find((g) => g.id === groupId) ?? null;
}

/** @returns {{group, tab, index} | null} */
export function findTab(root, tabId) {
	for (const group of allGroups(root)) {
		const index = group.tabs.findIndex((t) => t.id === tabId);
		if (index !== -1) return { group, tab: group.tabs[index], index };
	}
	return null;
}

/** @returns {{parent: SplitNode|null, index: number}} parent split of a node. */
export function findParent(root, nodeId, parent = null) {
	if (root.id === nodeId) return { parent, index: parent ? parent.children.indexOf(root) : -1 };
	if (root.type === 'split') {
		for (const child of root.children) {
			const found = findParent(child, nodeId, root);
			if (found) return found;
		}
	}
	return null;
}

export function activeGroup(state) {
	return findGroup(state.root, state.activeGroupId) ?? allGroups(state.root)[0];
}

export function activeTab(state) {
	const group = activeGroup(state);
	return group?.tabs.find((t) => t.id === group.activeTabId) ?? null;
}

// ---- tab operations -------------------------------------------------------

export function openTab(state, groupId, tab, { activate = true } = {}) {
	const group = findGroup(state.root, groupId) ?? activeGroup(state);
	group.tabs.push(tab);
	if (activate || group.tabs.length === 1) {
		group.activeTabId = tab.id;
		state.activeGroupId = group.id;
	}
	return tab;
}

/**
 * Open a note the Obsidian way: activate an existing tab for the path in the
 * active group; otherwise navigate the active note tab in place (pushing
 * history); otherwise open a new tab. `newTab: true` always opens a tab.
 */
export function openNote(state, path, opts = {}) {
	return openPath(state, path, 'note', opts);
}

/** Open a non-note file (image/PDF/media) in a viewer tab, same rules. */
export function openFile(state, path, opts = {}) {
	return openPath(state, path, 'file', opts);
}

/** Open a .canvas file in a canvas tab, same rules. */
export function openCanvasFile(state, path, opts = {}) {
	return openPath(state, path, 'canvas', opts);
}

function openPath(state, path, kind, { newTab = false, defaultMode = null } = {}) {
	const group = activeGroup(state);
	const existing = group.tabs.find((t) => t.kind === kind && t.path === path);
	if (existing) {
		group.activeTabId = existing.id;
		state.activeGroupId = group.id;
		return existing;
	}
	const current = activeTab(state);
	// A pinned tab never navigates away from its path.
	if (!newTab && (current?.kind === 'note' || current?.kind === 'file') && !current.pinned) {
		navigateTab(state, current.id, path, kind);
		return current;
	}
	const tab = createTab(kind, path);
	// The new-tab default mode applies only to freshly created note tabs;
	// navigation-in-place inherits the pane's mode, and explicit per-call
	// modes are applied by the caller (openWikilink, the note API).
	if (kind === 'note' && defaultMode) tab.view.mode = defaultMode;
	return openTab(state, group.id, tab);
}

// ---- pinning ---------------------------------------------------------------

/** Keep every group's pinned tabs at the front, in stable order. */
function partitionPinned(group) {
	const pinned = group.tabs.filter((t) => t.pinned);
	if (pinned.length === 0) return;
	group.tabs = [...pinned, ...group.tabs.filter((t) => !t.pinned)];
}

export function pinTab(state, tabId, pinned) {
	const found = findTab(state.root, tabId);
	if (!found) return;
	if (pinned) found.tab.pinned = true;
	else delete found.tab.pinned;
	partitionPinned(found.group);
}

export function closeTab(state, tabId) {
	const found = findTab(state.root, tabId);
	if (!found) return;
	const { group, index } = found;
	group.tabs.splice(index, 1);
	if (group.activeTabId === tabId) {
		group.activeTabId = (group.tabs[index] ?? group.tabs[index - 1])?.id ?? null;
	}
	normalize(state);
}

export function activateTab(state, tabId) {
	const found = findTab(state.root, tabId);
	if (!found) return;
	found.group.activeTabId = tabId;
	state.activeGroupId = found.group.id;
}

export function moveTab(state, tabId, toGroupId, index = Infinity) {
	const found = findTab(state.root, tabId);
	const target = findGroup(state.root, toGroupId);
	if (!found || !target) return;
	const { group, tab } = found;
	if (group === target) {
		const from = group.tabs.indexOf(tab);
		group.tabs.splice(from, 1);
		if (index > from) index--;
	} else {
		group.tabs.splice(group.tabs.indexOf(tab), 1);
		if (group.activeTabId === tabId) group.activeTabId = group.tabs[0]?.id ?? null;
	}
	const at = Math.max(0, Math.min(index, target.tabs.length));
	target.tabs.splice(at, 0, tab);
	partitionPinned(target);
	target.activeTabId = tab.id;
	state.activeGroupId = target.id;
	normalize(state);
}

/** Split alongside `groupId` on the given edge, seeding the new group with `tab`. */
export function splitGroup(state, groupId, edge, tab) {
	const dir = edge === 'left' || edge === 'right' ? 'row' : 'col';
	const before = edge === 'left' || edge === 'top';
	const group = findGroup(state.root, groupId);
	if (!group) return null;
	const newGroup = createGroup(tab ? [tab] : []);
	const { parent } = findParent(state.root, groupId) ?? { parent: null };

	if (parent && parent.dir === dir) {
		const i = parent.children.indexOf(group);
		const size = parent.sizes[i] / 2;
		parent.sizes[i] = size;
		parent.children.splice(before ? i : i + 1, 0, newGroup);
		parent.sizes.splice(before ? i : i + 1, 0, size);
	} else {
		const split = {
			type: 'split',
			id: nextId('s'),
			dir,
			sizes: [0.5, 0.5],
			children: before ? [newGroup, group] : [group, newGroup],
		};
		if (parent) {
			parent.children[parent.children.indexOf(group)] = split;
		} else {
			state.root = split;
		}
	}
	state.activeGroupId = newGroup.id;
	return newGroup;
}

/**
 * Split with a CLONE of `tabId` (Obsidian semantics): the original stays
 * where it is, the new pane opens a fresh tab on the same path with the
 * same view mode. This is what the split commands use — moving the only
 * tab out of a pane would just collapse the split it came from.
 */
export function splitWithClone(state, targetGroupId, edge, tabId) {
	const found = findTab(state.root, tabId);
	if (!found) return null;
	const source = found.tab;
	const clone = createTab(source.kind, source.path);
	clone.view = { ...clone.view, mode: source.view?.mode ?? clone.view.mode };
	const newGroup = splitGroup(state, targetGroupId, edge, clone);
	normalize(state);
	return newGroup;
}

/** Close a whole tab group (split pane); normalize collapses the split. */
export function closeGroup(state, groupId) {
	const group = findGroup(state.root, groupId);
	if (!group) return [];
	const closed = group.tabs.map((t) => t.id);
	group.tabs = [];
	group.activeTabId = null;
	normalize(state);
	return closed;
}

/** Move an existing tab into a fresh split on `edge` of `targetGroupId`. */
export function splitWithTab(state, targetGroupId, edge, tabId) {
	const found = findTab(state.root, tabId);
	if (!found) return null;
	const { group, tab, index } = found;
	group.tabs.splice(index, 1);
	if (group.activeTabId === tabId) group.activeTabId = group.tabs[0]?.id ?? null;
	const newGroup = splitGroup(state, targetGroupId, edge, tab);
	normalize(state);
	return newGroup;
}

export function setSplitSizes(state, splitId, sizes) {
	const walk = (node) => {
		if (node.type !== 'split') return false;
		if (node.id === splitId) { node.sizes = sizes; return true; }
		return node.children.some(walk);
	};
	walk(state.root);
}

// ---- per-tab navigation history ------------------------------------------

function snapshot(tab) {
	return { path: tab.path, kind: tab.kind, view: { ...tab.view } };
}

function restore(tab, entry) {
	tab.path = entry.path;
	tab.kind = entry.kind ?? 'note';
	tab.view = { ...entry.view };
}

export function navigateTab(state, tabId, path, kind = 'note') {
	const found = findTab(state.root, tabId);
	if (!found) return;
	const { tab } = found;
	tab.history.back.push(snapshot(tab));
	if (tab.history.back.length > HISTORY_LIMIT) tab.history.back.shift();
	tab.history.forward = [];
	tab.path = path;
	tab.kind = kind;
	tab.view = { mode: tab.view.mode };
}

/**
 * An in-document jump (a TOC/anchor click in reading mode): browser-style,
 * the spot the reader left becomes a Back entry. Same path, same kind —
 * only the remembered line differs, which restore() carries in `view`.
 */
export function recordAnchorJump(state, tabId, fromLine, toLine) {
	const found = findTab(state.root, tabId);
	if (!found || found.tab.pinned) return false;
	const { tab } = found;
	tab.history.back.push({ path: tab.path, kind: tab.kind, view: { ...tab.view, cursorLine: fromLine } });
	if (tab.history.back.length > HISTORY_LIMIT) tab.history.back.shift();
	tab.history.forward = [];
	tab.view = { ...tab.view, cursorLine: toLine };
	return true;
}

export function goBack(state, tabId) {
	const found = findTab(state.root, tabId);
	if (!found || found.tab.pinned || found.tab.history.back.length === 0) return false;
	const { tab } = found;
	tab.history.forward.push(snapshot(tab));
	restore(tab, tab.history.back.pop());
	return true;
}

export function goForward(state, tabId) {
	const found = findTab(state.root, tabId);
	if (!found || found.tab.pinned || found.tab.history.forward.length === 0) return false;
	const { tab } = found;
	tab.history.back.push(snapshot(tab));
	restore(tab, tab.history.forward.pop());
	return true;
}

// ---- normalization --------------------------------------------------------

/**
 * Restore the tree's invariants after an operation: drop empty tab groups
 * (unless the tree would become empty), collapse single-child splits, flatten
 * same-direction nesting, renormalize sizes, and repair activeGroupId.
 */
export function normalize(state) {
	const prune = (node) => {
		if (node.type === 'tabs') {
			return node.tabs.length > 0 ? node : null;
		}
		const kept = [];
		const sizes = [];
		node.children.forEach((child, i) => {
			const result = prune(child);
			if (!result) return;
			if (result.type === 'split' && result.dir === node.dir) {
				// Flatten same-direction nesting, scaling child sizes into our slot.
				result.children.forEach((grand, j) => {
					kept.push(grand);
					sizes.push(node.sizes[i] * result.sizes[j]);
				});
			} else {
				kept.push(result);
				sizes.push(node.sizes[i]);
			}
		});
		if (kept.length === 0) return null;
		if (kept.length === 1) return kept[0];
		const total = sizes.reduce((a, b) => a + b, 0) || 1;
		node.children = kept;
		node.sizes = sizes.map((s) => s / total);
		return node;
	};

	state.root = prune(state.root) ?? createGroup();
	if (!findGroup(state.root, state.activeGroupId)) {
		state.activeGroupId = allGroups(state.root)[0].id;
	}
}

// ---- persistence ----------------------------------------------------------

export function serialize(state) {
	return JSON.parse(JSON.stringify(state));
}

/**
 * Rebuild state from persisted JSON. Note tabs whose path fails `noteExists`
 * are dropped. Seeds the id counter past every restored id.
 */
export function deserialize(json, { noteExists = () => true } = {}) {
	if (!json || json.version !== 1 || !json.root) return null;
	const state = JSON.parse(JSON.stringify(json));
	let maxId = 0;
	const scanId = (id) => {
		const n = parseInt(String(id).replace(/^[a-z]+/, ''), 10);
		if (Number.isFinite(n) && n > maxId) maxId = n;
	};
	const walk = (node) => {
		scanId(node.id);
		if (node.type === 'tabs') {
			node.tabs = node.tabs.filter((t) => {
				scanId(t.id);
				return t.path == null || noteExists(t.path);
			});
			if (!node.tabs.some((t) => t.id === node.activeTabId)) {
				node.activeTabId = node.tabs[0]?.id ?? null;
			}
		} else {
			node.children.forEach(walk);
		}
	};
	walk(state.root);
	idCounter = maxId + 1;
	normalize(state);
	state.sidebars ??= {};
	state.sidebars.left ??= { open: true, width: 260, activeTool: 'files' };
	state.sidebars.left.activeTool ??= 'files';
	state.sidebars.right ??= { open: true, width: 290, activeTool: 'backlinks' };
	return state;
}
