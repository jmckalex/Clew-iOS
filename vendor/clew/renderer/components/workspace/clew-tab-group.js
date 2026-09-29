// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// <clew-tab-group>: a leaf of the layout tree — tab bar plus the active
// tab's content. Also the drop target for tab drags (center = move here,
// edges = split).
import { ClewElement } from '../base/clew-element.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { createTab } from '../../workspace/tree.js';
import './clew-tab-bar.js';
import './clew-editor-view.js';
import './clew-preview-view.js';
import '../views/clew-graph-view.js';
import '../views/clew-settings-view.js';
import '../views/clew-file-view.js';
import '../views/clew-canvas-view.js';
import { retire } from '../../pdf-frames.js';

/**
 * Put `next` in the tab body. The outgoing view goes through retire(): if a
 * PDF viewer in it holds an unsaved annotation, it lingers — hidden — until
 * that is written (pdf-frames.js), while `next` shows at once.
 */
function show(body, next) {
	for (const child of [...body.children]) if (!child.hasAttribute('data-clew-retiring')) retire(child);
	body.append(next);
}

class ClewTabGroup extends ClewElement {
	groupId = null;
	#renderedTabId = null;
	#renderedPath = null;
	#renderedMode = null;

	subscribe() {
		this.listen(workspaceStore, 'layout-changed', () => this.render());
		this.addEventListener('pointerdown', this.#onPointerDown);
	}

	cleanup() {
		this.removeEventListener('pointerdown', this.#onPointerDown);
	}

	#onPointerDown = () => {
		if (this.groupId) workspaceStore.setActiveGroup(this.groupId);
	};

	get group() {
		const found = workspaceStore.allGroups().find((g) => g.id === this.groupId);
		return found ?? null;
	}

	render() {
		const group = this.group;
		if (!group) return; // about to be reconciled away

		let bar = this.querySelector(':scope > clew-tab-bar');
		let body = this.querySelector(':scope > .tab-body');
		if (!bar) {
			bar = document.createElement('clew-tab-bar');
			body = document.createElement('div');
			body.className = 'tab-body';
			const overlay = document.createElement('div');
			overlay.className = 'drop-overlay';
			this.replaceChildren(bar, body, overlay);
		}
		bar.groupId = this.groupId;
		bar.render?.();

		const active = group.tabs.find((t) => t.id === group.activeTabId) ?? null;
		if (!active) {
			this.#renderedTabId = null;
			this.#renderedPath = null;
			this.#renderedMode = null;
			show(body, this.#emptyState());
			return;
		}
		// Source and live edit are ONE view — the same pooled editor wearing
		// a different compartment (clew-editor-view handles the flip) — so a
		// source↔live change must not replace the body and remount it.
		const viewMode = active.view?.mode ?? 'source';
		const mode = viewMode === 'reading' ? 'reading' : 'editor';
		if (active.id === this.#renderedTabId && active.path === this.#renderedPath
			&& mode === this.#renderedMode) return;
		this.#renderedTabId = active.id;
		this.#renderedPath = active.path ?? null;
		this.#renderedMode = mode;

		if (active.kind === 'note' && mode === 'reading') {
			const view = document.createElement('clew-preview-view');
			view.tabId = active.id;
			view.path = active.path;
			show(body, view);
		} else if (active.kind === 'note') {
			const view = document.createElement('clew-editor-view');
			view.tabId = active.id;
			view.path = active.path;
			show(body, view);
		} else if (active.kind === 'file') {
			const view = document.createElement('clew-file-view');
			view.tabId = active.id;
			view.path = active.path;
			show(body, view);
		} else if (active.kind === 'canvas') {
			const view = document.createElement('clew-canvas-view');
			view.tabId = active.id;
			view.path = active.path;
			show(body, view);
		} else if (active.kind === 'graph') {
			show(body, document.createElement('clew-graph-view'));
		} else if (active.kind === 'settings') {
			show(body, document.createElement('clew-settings-view'));
		} else {
			show(body, this.#emptyState());
		}
	}

	refreshActive() {
		this.render();
	}

	#emptyState() {
		const el = document.createElement('div');
		el.className = 'empty-state';
		const button = document.createElement('button');
		button.textContent = 'Create new note';
		button.addEventListener('click', () => {
			document.querySelector('clew-file-explorer')?.createNote?.();
		});
		const hint = document.createElement('p');
		hint.textContent = 'No file is open';
		el.append(hint, button);
		return el;
	}

	// ---- drop-target API used by tab-drag.js ----

	showDrop(region) {
		this.dataset.drop = region; // 'center' | 'left' | 'right' | 'top' | 'bottom'
	}

	clearDrop() {
		delete this.dataset.drop;
	}

	acceptDrop(region, tabId) {
		this.clearDrop();
		if (region === 'center') {
			workspaceStore.moveTab(tabId, this.groupId, Infinity);
		} else {
			workspaceStore.splitWithTab(this.groupId, region, tabId);
		}
	}
}

customElements.define('clew-tab-group', ClewTabGroup);
export { createTab };
