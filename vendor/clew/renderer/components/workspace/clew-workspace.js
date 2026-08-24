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
// not recreated, when the tree changes shape.
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

/** Return an element rendering `node`, reusing elements from `existing`. */
export function syncNode(node, existing) {
	let el = existing.get(node.id);
	if (node.type === 'tabs') {
		if (!el || el.tagName !== 'CLEW-TAB-GROUP') {
			el = document.createElement('clew-tab-group');
			el.dataset.nodeId = node.id;
		}
		el.groupId = node.id;
	} else {
		if (!el || el.tagName !== 'CLEW-SPLIT') {
			el = document.createElement('clew-split');
			el.dataset.nodeId = node.id;
		}
		el.syncChildren(node, existing);
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
		const rootEl = syncNode(workspaceStore.root, existing);
		if (this.firstElementChild !== rootEl) {
			this.replaceChildren(rootEl);
		}
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
