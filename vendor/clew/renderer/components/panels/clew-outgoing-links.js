// Outgoing links panel: resolved and unresolved links from the active note;
// clicking an unresolved one creates the note (Obsidian behavior).
import { ClewElement } from '../base/clew-element.js';
import { vaultStore } from '../../state/vault-store.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { debounce } from '../../lib/debounce.js';
import { openWikilink } from '../../commands/actions.js';
import { emptyNote } from './clew-backlinks.js';

export class ClewOutgoingLinks extends ClewElement {
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
		const links = vaultStore.outgoingFor(path).filter((l) => l.target);
		if (links.length === 0) {
			this.replaceChildren(emptyNote('No outgoing links'));
			return;
		}

		const resolved = links.filter((l) => l.resolved);
		const unresolved = links.filter((l) => !l.resolved);
		const frag = document.createDocumentFragment();

		const section = (titleText, list, cls) => {
			if (list.length === 0) return;
			const title = document.createElement('div');
			title.className = 'link-group-title is-static';
			title.textContent = `${titleText} (${list.length})`;
			frag.append(title);
			for (const link of list) {
				const row = document.createElement('div');
				row.className = `outgoing-link ${cls}`;
				row.textContent = link.alias ? `${link.alias} (${link.target})` : link.target;
				row.addEventListener('click', () =>
					openWikilink(link.target + (link.heading ? `#${link.heading}` : '')));
				frag.append(row);
			}
		};
		section('Links', resolved, 'is-resolved');
		section('Unresolved', unresolved, 'is-unresolved');
		this.replaceChildren(frag);
	}
}

customElements.define('clew-outgoing-links', ClewOutgoingLinks);
