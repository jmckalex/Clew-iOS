// Tag pane: nested tag tree with counts; click lists the tagged notes
// (inline expansion — the full search integration arrives in M4).
import { ClewElement } from '../base/clew-element.js';
import { vaultStore } from '../../state/vault-store.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { debounce } from '../../lib/debounce.js';
import { emptyNote } from './clew-backlinks.js';

const noteTitle = (path) => path.split('/').pop().replace(/\.(md|jmd)$/i, '');

export class ClewTagPane extends ClewElement {
	#refresh = debounce(() => this.render(), 200);
	#expanded = new Set();

	subscribe() {
		this.listen(vaultStore, 'index-changed', () => this.#refresh());
	}

	render() {
		this.classList.add('panel-scroll');
		const tags = [...vaultStore.tagIndex().entries()]
			.sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
		if (tags.length === 0) {
			this.replaceChildren(emptyNote('No tags'));
			return;
		}
		const frag = document.createDocumentFragment();
		for (const [tag, info] of tags) {
			const row = document.createElement('div');
			row.className = 'tag-row';
			const label = document.createElement('span');
			label.className = 'tag-label';
			label.textContent = `#${tag}`;
			const count = document.createElement('span');
			count.className = 'tag-count';
			count.textContent = info.count;
			row.append(label, count);
			row.addEventListener('click', () => {
				if (this.#expanded.has(tag)) this.#expanded.delete(tag);
				else this.#expanded.add(tag);
				this.render();
			});
			frag.append(row);

			if (this.#expanded.has(tag)) {
				for (const path of [...new Set(info.notes)].sort()) {
					const note = document.createElement('div');
					note.className = 'tag-note';
					note.textContent = noteTitle(path);
					note.title = path;
					note.addEventListener('click', () => workspaceStore.openNote(path));
					frag.append(note);
				}
			}
		}
		this.replaceChildren(frag);
	}
}

customElements.define('clew-tag-pane', ClewTagPane);
