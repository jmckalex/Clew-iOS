// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Bookmarks panel: the pinned-notes list.
import { ClewElement } from '../base/clew-element.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { bookmarkStore } from '../../state/bookmark-store.js';
import { showMenu } from '../chrome/menu.js';
import { emptyNote } from './clew-backlinks.js';

const noteTitle = (path) => path.split('/').pop().replace(/\.(md|jmd)$/i, '');

export class ClewBookmarks extends ClewElement {
	subscribe() {
		this.listen(bookmarkStore, 'bookmarks-changed', () => this.render());
	}

	render() {
		this.classList.add('panel-scroll');
		if (bookmarkStore.paths.length === 0) {
			this.replaceChildren(emptyNote('No bookmarks — use “Bookmark this note” from the palette'));
			return;
		}
		const frag = document.createDocumentFragment();
		for (const path of bookmarkStore.paths) {
			const row = document.createElement('div');
			row.className = 'tree-item is-file';
			const name = document.createElement('span');
			name.className = 'tree-name';
			name.textContent = noteTitle(path);
			name.title = path;
			row.append(name);
			row.addEventListener('click', (e) => {
				workspaceStore.openNote(path, { newTab: e.metaKey || e.ctrlKey });
			});
			row.addEventListener('contextmenu', (e) => {
				e.preventDefault();
				showMenu(e.clientX, e.clientY, [
					{ label: 'Remove bookmark', click: () => bookmarkStore.toggle(path) },
				]);
			});
			frag.append(row);
		}
		this.replaceChildren(frag);
	}
}

customElements.define('clew-bookmarks', ClewBookmarks);
