// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Backlinks panel: linked mentions (notes linking to the active note, with
// context snippets) plus unlinked mentions (word-bounded occurrences of the
// note's name or aliases outside any wikilink, each with a Link button that
// converts the occurrence into a wikilink in place).
import { ClewElement } from '../base/clew-element.js';
import { vaultStore } from '../../state/vault-store.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { ipc, CH } from '../../ipc.js';
import { debounce } from '../../lib/debounce.js';
import { openNoteAtLine, linkMention } from '../../commands/actions.js';
import { icon } from '../../lib/icons.js';

const noteTitle = (path) => path.split('/').pop().replace(/\.(md|jmd)$/i, '');

export class ClewBacklinks extends ClewElement {
	#refresh = debounce(() => this.render(), 150);
	#unlinkedOpen = true;

	subscribe() {
		this.listen(workspaceStore, 'active-changed', () => this.#refresh());
		this.listen(workspaceStore, 'layout-changed', () => this.#refresh());
		this.listen(vaultStore, 'index-changed', () => this.#refresh());
	}

	async render() {
		const path = workspaceStore.activeTab()?.path;
		this.classList.add('panel-scroll');
		if (!path) {
			this.replaceChildren(emptyNote('No active note'));
			return;
		}
		const backlinks = vaultStore.backlinksFor(path);
		const mentions = await ipc.invoke(CH.UNLINKED_MENTIONS, { path }).catch(() => []);
		if (workspaceStore.activeTab()?.path !== path) return; // switched away

		const frag = document.createDocumentFragment();

		frag.append(sectionTitle(`Linked mentions (${backlinks.reduce((n, b) => n + b.links.length, 0)})`));
		if (backlinks.length === 0) frag.append(emptyNote('No backlinks'));
		for (const { source, links } of backlinks) {
			frag.append(await this.#linkedGroup(source, links));
		}

		const count = mentions.reduce((n, m) => n + m.matches.length, 0);
		const toggle = sectionTitle(`Unlinked mentions (${count})`, true, this.#unlinkedOpen);
		toggle.addEventListener('click', () => {
			this.#unlinkedOpen = !this.#unlinkedOpen;
			this.render();
		});
		frag.append(toggle);
		if (this.#unlinkedOpen) {
			if (count === 0) frag.append(emptyNote('No unlinked mentions'));
			for (const group of mentions) {
				frag.append(this.#unlinkedGroup(path, group));
			}
		}
		this.replaceChildren(frag);
	}

	async #linkedGroup(source, links) {
		const group = document.createElement('div');
		group.className = 'link-group';
		group.append(groupTitle(source));

		// Context snippets, fetched once per source note; one row per line
		// (several links on one line share a snippet).
		const text = await ipc.invoke(CH.NOTE_READ, { path: source }).catch(() => null);
		const seenLines = new Set();
		for (const link of links) {
			if (seenLines.has(link.line)) continue;
			seenLines.add(link.line);
			const row = document.createElement('div');
			row.className = 'link-context';
			const snippet = text?.split('\n')[link.line - 1]?.trim() ?? '';
			row.textContent = snippet.length > 220 ? snippet.slice(0, 220) + '…' : snippet;
			row.addEventListener('click', () => openNoteAtLine(source, link.line));
			group.append(row);
		}
		return group;
	}

	#unlinkedGroup(targetPath, { path: source, matches }) {
		const group = document.createElement('div');
		group.className = 'link-group';
		group.append(groupTitle(source));
		for (const match of matches) {
			const row = document.createElement('div');
			row.className = 'link-context mention-row';

			const snippet = document.createElement('span');
			snippet.className = 'mention-snippet';
			snippet.textContent = match.snippet.length > 180 ? match.snippet.slice(0, 180) + '…' : match.snippet;
			snippet.addEventListener('click', () => openNoteAtLine(source, match.line));

			const link = document.createElement('button');
			link.className = 'mention-link-button';
			link.textContent = 'Link';
			link.title = `Turn this mention into [[${noteTitle(targetPath)}]]`;
			link.addEventListener('click', async (e) => {
				e.stopPropagation();
				const ok = await linkMention({
					sourcePath: source,
					line: match.line,
					column: match.column,
					length: match.length,
					targetPath,
					name: match.name,
				});
				if (!ok) console.warn('Mention no longer matches; not linked.');
				this.#refresh(); // re-index catches up via the watcher; refresh optimistically
			});

			row.append(snippet, link);
			group.append(row);
		}
		return group;
	}
}

function groupTitle(source) {
	const title = document.createElement('div');
	title.className = 'link-group-title';
	title.textContent = noteTitle(source);
	title.title = source;
	title.addEventListener('click', () => workspaceStore.openNote(source));
	return title;
}

function sectionTitle(text, collapsible = false, open = true) {
	const el = document.createElement('div');
	el.className = 'link-group-title is-static panel-section-title';
	if (collapsible) {
		el.classList.add('is-collapsible');
		el.append(icon(open ? 'chevron-down' : 'chevron-right', 'section-chevron'));
	}
	el.append(document.createTextNode(text));
	return el;
}

export function emptyNote(text) {
	const el = document.createElement('div');
	el.className = 'panel-empty';
	el.textContent = text;
	return el;
}

customElements.define('clew-backlinks', ClewBacklinks);
