// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// <clew-split>: one split node rendered as a flex row/column with draggable
// resizer gutters between children.
import { ClewElement } from '../base/clew-element.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { syncNode, place } from './clew-workspace.js';

class ClewSplit extends ClewElement {
	#node = null;

	subscribe() {
		this.listen(workspaceStore, 'sizes-changed', ({ splitId }) => {
			if (splitId === this.#node?.id) this.#applySizes();
		});
	}

	#resizers = [];

	/**
	 * Called by the reconciler, once this split is in place, with the current
	 * split node: place the children (clew-workspace.js#place — only what is
	 * out of place moves), then sync the splits among them. The resizers are
	 * KEPT across syncs, one per gap: made afresh each time, they never
	 * matched the old ones, and every sync re-appended every pane.
	 */
	syncChildren(node, existing, after) {
		this.#node = node;
		this.classList.toggle('dir-row', node.dir === 'row');
		this.classList.toggle('dir-col', node.dir === 'col');

		const panes = node.children.map((child) => syncNode(child, existing));
		this.#resizers.length = Math.max(0, panes.length - 1);
		const desired = [];
		panes.forEach((el, i) => {
			desired.push(el);
			if (i < panes.length - 1) desired.push(this.#resizers[i] ??= this.#makeResizer(i));
		});
		place(this, desired, after);
		node.children.forEach((child, i) => {
			if (child.type !== 'tabs') panes[i].syncChildren(child, existing, after);
		});
		this.#applySizes();
	}

	#applySizes() {
		if (!this.#node) return;
		let childIndex = 0;
		for (const el of this.children) {
			if (el.classList.contains('clew-resizer')) continue;
			el.style.flex = `${this.#node.sizes[childIndex] ?? 1} 1 0`;
			childIndex++;
		}
	}

	#makeResizer(index) {
		const el = document.createElement('div');
		el.className = 'clew-resizer';
		el.addEventListener('pointerdown', (e) => this.#startResize(e, index, el));
		return el;
	}

	#startResize(e, index, handle) {
		e.preventDefault();
		const node = this.#node;
		const panes = [...this.children].filter((el) => !el.classList.contains('clew-resizer'));
		const a = panes[index];
		const b = panes[index + 1];
		const horizontal = node.dir === 'row';
		const totalPx = horizontal
			? a.getBoundingClientRect().width + b.getBoundingClientRect().width
			: a.getBoundingClientRect().height + b.getBoundingClientRect().height;
		const startPos = horizontal ? e.clientX : e.clientY;
		const startSizes = [...node.sizes];
		const pair = startSizes[index] + startSizes[index + 1];
		const minFrac = pair * Math.min(0.45, 80 / totalPx); // ≥80px per pane

		handle.setPointerCapture(e.pointerId);
		const onMove = (ev) => {
			const delta = ((horizontal ? ev.clientX : ev.clientY) - startPos) / totalPx * pair;
			const sizes = [...startSizes];
			sizes[index] = Math.max(minFrac, Math.min(pair - minFrac, startSizes[index] + delta));
			sizes[index + 1] = pair - sizes[index];
			workspaceStore.setSplitSizes(node.id, sizes);
		};
		const onUp = () => {
			handle.removeEventListener('pointermove', onMove);
			handle.removeEventListener('pointerup', onUp);
		};
		handle.addEventListener('pointermove', onMove);
		handle.addEventListener('pointerup', onUp);
	}
}

customElements.define('clew-split', ClewSplit);
