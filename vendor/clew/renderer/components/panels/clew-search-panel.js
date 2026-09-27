// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Global search panel (Cmd+Shift+F): debounced full-text search with
// operators (path:, file:, tag:, "phrases"), results grouped by note with
// highlighted snippets; click jumps to the match line.
import { ClewElement } from '../base/clew-element.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { ipc, CH } from '../../ipc.js';
import { debounce } from '../../lib/debounce.js';
import { openNoteAtLine } from '../../commands/actions.js';
import { emptyNote } from './clew-backlinks.js';

const noteTitle = (path) => path.split('/').pop().replace(/\.(md|jmd)$/i, '');

export class ClewSearchPanel extends ClewElement {
	#query = '';
	#results = null;
	#run = debounce(async () => {
		if (!this.#query.trim()) {
			this.#results = null;
			this.#renderResults();
			return;
		}
		this.#results = await ipc.invoke(CH.SEARCH, { query: this.#query }).catch(() => []);
		this.#renderResults();
	}, 250);

	render() {
		this.innerHTML = `
			<div class="search-header">
				<input class="search-input" type="text"
					placeholder='Search (path: file: tag: "phrase")' spellcheck="false">
			</div>
			<div class="search-results panel-scroll"></div>
		`;
		const input = this.querySelector('.search-input');
		input.value = this.#query;
		input.addEventListener('input', () => {
			this.#query = input.value;
			this.#run();
		});
		input.addEventListener('keydown', (e) => e.stopPropagation());
		this.#renderResults();
	}

	focusInput() {
		this.querySelector('.search-input')?.focus();
	}

	/** Replace the query and run it (a tag clicked in live edit). */
	setQuery(query) {
		this.#query = String(query ?? '');
		const input = this.querySelector('.search-input');
		if (input) input.value = this.#query;
		this.#run();
	}

	#renderResults() {
		const container = this.querySelector('.search-results');
		if (!container) return;
		if (this.#results === null) {
			container.replaceChildren();
			return;
		}
		if (this.#results.length === 0) {
			container.replaceChildren(emptyNote('No results'));
			return;
		}
		const frag = document.createDocumentFragment();
		const count = document.createElement('div');
		count.className = 'search-count';
		count.textContent = `${this.#results.length} note${this.#results.length === 1 ? '' : 's'}`;
		frag.append(count);

		for (const result of this.#results) {
			const group = document.createElement('div');
			group.className = 'link-group';
			const title = document.createElement('div');
			title.className = 'link-group-title';
			title.textContent = noteTitle(result.path);
			title.title = result.path;
			title.addEventListener('click', () => workspaceStore.openNote(result.path));
			group.append(title);

			for (const match of result.matches) {
				const row = document.createElement('div');
				row.className = 'link-context';
				const snippet = match.snippet;
				const before = snippet.slice(0, match.column);
				const hit = snippet.slice(match.column, match.column + match.length);
				const after = snippet.slice(match.column + match.length);
				if (hit) {
					const mark = document.createElement('mark');
					mark.textContent = hit;
					row.append(before, mark, after);
				} else {
					row.textContent = snippet;
				}
				row.addEventListener('click', () => openNoteAtLine(result.path, match.line));
				group.append(row);
			}
			frag.append(group);
		}
		container.replaceChildren(frag);
	}
}

customElements.define('clew-search-panel', ClewSearchPanel);
