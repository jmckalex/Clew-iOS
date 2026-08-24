// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// References panel: the active note's formatted bibliography, in the right
// sidebar. The engine renders every note with a hidden all-citations
// bibliography (the .clew-bib-panel-source aside in clew-template.html);
// this panel fetches the note's rendered HTML on demand and lifts that list
// out, so it works whether or not a preview is open. Notes that author their
// own @bibliography blocks (sectional, scoped, styled) are untouched — this
// panel is a read-only view beside them.
import { ClewElement } from '../base/clew-element.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { ipc, CH } from '../../ipc.js';
import { debounce } from '../../lib/debounce.js';

const NOTE_FILE = /\.(md|jmd)$/i;

// The extracted markup is citeproc output built from .bib fields — author
// content. Keep only the formatting it legitimately produces.
const KEEP_TAGS = new Set(['DIV', 'SPAN', 'P', 'EM', 'I', 'B', 'STRONG', 'SMALL', 'SUP', 'SUB', 'BR', 'A']);

function sanitize(node, out) {
	for (const child of node.childNodes) {
		if (child.nodeType === Node.TEXT_NODE) {
			out.append(child.textContent);
			continue;
		}
		if (child.nodeType !== Node.ELEMENT_NODE) continue;
		if (!KEEP_TAGS.has(child.tagName)) {
			sanitize(child, out); // unwrap: keep the text, drop the tag
			continue;
		}
		const el = document.createElement(child.tagName.toLowerCase());
		const cls = child.getAttribute('class');
		if (cls) el.className = cls;
		if (child.tagName === 'A') {
			const href = child.getAttribute('href') ?? '';
			if (/^https?:/i.test(href)) {
				el.setAttribute('href', href);
				el.setAttribute('target', '_blank');
			}
		}
		sanitize(child, el);
		out.append(el);
	}
}

export class ClewBibliography extends ClewElement {
	#refresh = debounce(() => this.render(), 200);
	#renderToken = 0;

	subscribe() {
		this.listen(workspaceStore, 'active-changed', () => this.#refresh());
		this.listen(workspaceStore, 'layout-changed', () => this.#refresh());
		this.listen({ on: ipc.on }, CH.EV_RENDER_DONE, ({ path }) => {
			if (path === workspaceStore.activeTab()?.path) this.#refresh();
		});
	}

	async render() {
		this.classList.add('panel-scroll');
		const path = workspaceStore.activeTab()?.path;
		if (!path || !NOTE_FILE.test(path)) {
			this.replaceChildren(this.#empty('No active note'));
			return;
		}
		const token = ++this.#renderToken;
		let html;
		try {
			html = await ipc.invoke(CH.RENDER_HTML, { path });
		} catch {
			this.replaceChildren(this.#empty('Could not render this note'));
			return;
		}
		if (token !== this.#renderToken || workspaceStore.activeTab()?.path !== path) return;

		const doc = new DOMParser().parseFromString(html, 'text/html');
		const source = doc.querySelector('.clew-bib-panel-source');
		const entries = source?.querySelectorAll('.csl-entry') ?? [];
		if (!source || entries.length === 0) {
			this.replaceChildren(this.#empty('No citations in this note'));
			return;
		}

		const frag = document.createDocumentFragment();
		const title = document.createElement('div');
		title.className = 'link-group-title is-static panel-section-title';
		title.textContent = `References (${entries.length})`;
		frag.append(title);
		const list = document.createElement('div');
		list.className = 'bibliography-entries';
		sanitize(source, list);
		frag.append(list);
		this.replaceChildren(frag);
	}

	#empty(text) {
		const el = document.createElement('p');
		el.className = 'panel-empty';
		el.textContent = text;
		return el;
	}
}

customElements.define('clew-bibliography', ClewBibliography);
