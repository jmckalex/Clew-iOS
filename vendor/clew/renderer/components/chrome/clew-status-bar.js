// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// <clew-status-bar>: word/character count for the active note.
import { ClewElement } from '../base/clew-element.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { editorPool } from '../../editor/pool.js';
import { debounce } from '../../lib/debounce.js';

class ClewStatusBar extends ClewElement {
	#update = debounce(() => this.render(), 200);

	subscribe() {
		this.listen(workspaceStore, 'active-changed', () => this.#update());
		this.listen(workspaceStore, 'layout-changed', () => this.#update());
		this.listen(editorPool, 'doc-changed', ({ tabId }) => {
			if (workspaceStore.activeTab()?.id === tabId) this.#update();
		});
	}

	render() {
		const tab = workspaceStore.activeTab();
		const entry = tab?.kind === 'note' ? editorPool.get(tab.id) : null;
		if (!entry?.view) {
			this.replaceChildren();
			return;
		}
		const text = entry.view.state.doc.toString();
		const words = (text.match(/[\p{L}\p{N}'’-]+/gu) ?? []).length;
		const chars = text.length;

		const wordsEl = document.createElement('span');
		wordsEl.className = 'status-item';
		wordsEl.textContent = `${words} word${words === 1 ? '' : 's'}`;
		const charsEl = document.createElement('span');
		charsEl.className = 'status-item';
		charsEl.textContent = `${chars} character${chars === 1 ? '' : 's'}`;
		this.replaceChildren(wordsEl, charsEl);
	}
}

customElements.define('clew-status-bar', ClewStatusBar);
