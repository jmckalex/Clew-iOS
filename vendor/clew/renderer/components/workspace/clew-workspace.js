// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// <clew-workspace> renders the layout tree. Reconciliation is keyed by node
// id: existing elements (and therefore the editor DOM inside them) are moved,
// not recreated, when the tree changes shape — and a pane whose place did not
// change is not touched AT ALL (2026-10-02). Until then every layout change
// in a split re-appended every pane (clew-split.js rebuilt its resizers, so
// its children never compared equal), which disconnected and reconnected
// every pane's view: a mode switch in one pane reloaded the frames of all the
// others, and the editor view dropped its toolbar. A pane that does move goes
// by `moveBefore` — Chromium's state-preserving move: its frames do not
// reload, its focus and scroll stay, and components see
// `connectedMoveCallback` (clew-element.js) instead of a disconnect.
// Placement is TOP-DOWN, each parent placed before its children, so a pane
// moving into a new split is moved there directly rather than detached first;
// what is left over is removed only once the whole pass is done.
import { ClewElement } from '../base/clew-element.js';
import { workspaceStore } from '../../state/workspace-store.js';

/** Collect existing rendered nodes, keyed by layout-node id. */
function collectExisting(rootEl) {
	const map = new Map();
	for (const el of rootEl.querySelectorAll('[data-node-id]')) {
		map.set(el.dataset.nodeId, el);
	}
	return map;
}

const canMove = typeof Element.prototype.moveBefore === 'function';

/**
 * Make `parent`'s first children exactly `desired`, touching only what is out
 * of place: a connected element is MOVED there (moveBefore, so nothing in it
 * reloads), a new one inserted. Children past the end are left for `after` —
 * a deeper level may still be about to move one of them out.
 */
export function place(parent, desired, after) {
	desired.forEach((el, i) => {
		const at = parent.children[i] ?? null;
		if (at === el) return;
		if (canMove && el.isConnected && parent.isConnected) {
			try {
				parent.moveBefore(el, at);
				return;
			} catch {
				// Not movable here (a different root): the plain insert below.
			}
		}
		parent.insertBefore(el, at);
	});
	after.push(() => {
		while (parent.children.length > desired.length) parent.lastElementChild.remove();
	});
}

/** The element rendering `node`, reused from `existing` when there is one.
 *  A split's children are synced by the caller once the split is placed. */
export function syncNode(node, existing) {
	let el = existing.get(node.id);
	if (node.type === 'tabs') {
		if (!el || el.tagName !== 'CLEW-TAB-GROUP') {
			el = document.createElement('clew-tab-group');
			el.dataset.nodeId = node.id;
		}
		el.groupId = node.id;
	} else if (!el || el.tagName !== 'CLEW-SPLIT') {
		el = document.createElement('clew-split');
		el.dataset.nodeId = node.id;
	}
	// Reused elements are moved, not rebuilt, so one may still carry the
	// `flex` its former parent split gave it. Clear it: ClewSplit#applySizes
	// re-sets it immediately for anything that is still a split child, and
	// anything that is not must fall back to the stylesheet. Sizes are
	// fractions summing to 1, so a promoted pane keeping `flex: 0.5 1 0`
	// grows into only half the free space and leaves the rest void.
	el.style.flex = '';
	return el;
}

class ClewWorkspace extends ClewElement {
	subscribe() {
		this.listen(workspaceStore, 'layout-changed', () => this.render());
		this.listen(workspaceStore, 'active-changed', () => this.#updateActive());
	}

	render() {
		const existing = collectExisting(this);
		const root = workspaceStore.root;
		const rootEl = syncNode(root, existing);
		const after = [];
		place(this, [rootEl], after);
		if (root.type !== 'tabs') rootEl.syncChildren(root, existing, after);
		for (const cleanup of after.reverse()) cleanup();
		this.#updateActive();
	}

	#updateActive() {
		const activeId = workspaceStore.activeGroupId;
		for (const el of this.querySelectorAll('clew-tab-group')) {
			el.classList.toggle('is-active', el.dataset.nodeId === activeId);
			el.refreshActive?.();
		}
	}
}

customElements.define('clew-workspace', ClewWorkspace);
