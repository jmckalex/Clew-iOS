// Outline panel: heading tree of the active note (from the index; the index
// updates on save, which auto-save keeps within ~a second of typing).
import { ClewElement } from '../base/clew-element.js';
import { vaultStore } from '../../state/vault-store.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { debounce } from '../../lib/debounce.js';
import { openNoteAtLine } from '../../commands/actions.js';
import { emptyNote } from './clew-backlinks.js';

export class ClewOutline extends ClewElement {
	#refresh = debounce(() => this.render(), 150);

	subscribe() {
		this.listen(workspaceStore, 'active-changed', () => this.#refresh());
		this.listen(workspaceStore, 'layout-changed', () => this.#refresh());
		this.listen(vaultStore, 'index-changed', () => this.#refresh());
	}

	render() {
		const path = workspaceStore.activeTab()?.path;
		this.classList.add('panel-scroll');
		if (!path) {
			this.replaceChildren(emptyNote('No active note'));
			return;
		}
		const headings = vaultStore.headingsFor(path);
		if (headings.length === 0) {
			this.replaceChildren(emptyNote('No headings'));
			return;
		}
		const minLevel = Math.min(...headings.map((h) => h.level));
		const frag = document.createDocumentFragment();
		for (const heading of headings) {
			const row = document.createElement('div');
			row.className = 'outline-row';
			row.style.paddingLeft = `${10 + (heading.level - minLevel) * 14}px`;
			row.textContent = heading.text;
			row.addEventListener('click', () => openNoteAtLine(path, heading.line));
			frag.append(row);
		}
		this.replaceChildren(frag);
	}
}

customElements.define('clew-outline', ClewOutline);
