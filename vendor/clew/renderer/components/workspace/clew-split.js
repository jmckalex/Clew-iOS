// <clew-split>: one split node rendered as a flex row/column with draggable
// resizer gutters between children.
import { ClewElement } from '../base/clew-element.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { syncNode } from './clew-workspace.js';

class ClewSplit extends ClewElement {
	#node = null;

	subscribe() {
		this.listen(workspaceStore, 'sizes-changed', ({ splitId }) => {
			if (splitId === this.#node?.id) this.#applySizes();
		});
	}

	/** Called by the reconciler with the current split node. */
	syncChildren(node, existing) {
		this.#node = node;
		this.classList.toggle('dir-row', node.dir === 'row');
		this.classList.toggle('dir-col', node.dir === 'col');

		const desired = [];
		node.children.forEach((child, i) => {
			desired.push(syncNode(child, existing));
			if (i < node.children.length - 1) {
				desired.push(this.#makeResizer(i));
			}
		});
		// Replace children only if the sequence differs (replaceChildren moves
		// reused elements rather than recreating them).
		const changed = desired.length !== this.children.length
			|| desired.some((el, i) => this.children[i] !== el);
		if (changed) this.replaceChildren(...desired);
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
