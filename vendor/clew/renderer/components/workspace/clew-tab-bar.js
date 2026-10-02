// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// <clew-tab-bar>: the row of tabs for one group. Click activates,
// middle-click / × closes, dragging hands off to tab-drag.js.
//
// It also holds the pane's VIEW-MODE switch — source, live edit, reading —
// pinned at the right end, just left of "+", acting on this pane's ACTIVE
// tab (the owner's choice, 2026-10-01: a whole row above the note for three
// buttons was not worth the space). Tabs shrink and scroll under it, never
// push it out. A tab with no modes (a file, a canvas, the graph, settings)
// leaves it hidden in place, so nothing in the strip moves.
import { ClewElement } from '../base/clew-element.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { editorPool } from '../../editor/pool.js';
import { createTab } from '../../workspace/tree.js';
import { startTabDrag } from '../../workspace/tab-drag.js';
import { showMenu } from '../chrome/menu.js';
import { icon } from '../../lib/icons.js';
import { officeDock } from '../../office-dock.js';
import { runCommand, effectiveKeymap } from '../../commands/registry.js';
import { prettifyChord } from '../../commands/builtin.js';
import { VIEW_MODES } from '../../editor/toolbar/toolbar-spec.js';

const chordFor = (id) => {
	for (const [chord, mapped] of effectiveKeymap()) if (mapped === id) return prettifyChord(chord);
	return '';
};

export function tabTitle(tab) {
	if (tab.kind === 'note' && tab.path) {
		const base = tab.path.split('/').pop();
		return base.replace(/\.(md|jmd)$/i, '');
	}
	if (tab.kind === 'file' && tab.path) return tab.path.split('/').pop();
	if (tab.kind === 'canvas' && tab.path) {
		return tab.path.split('/').pop().replace(/\.canvas$/i, '');
	}
	if (tab.kind === 'graph') return 'Graph view';
	if (tab.kind === 'settings') return 'Settings';
	return 'New tab';
}

class ClewTabBar extends ClewElement {
	groupId = null;
	#signature = null;

	subscribe() {
		this.listen(workspaceStore, 'active-changed', () => this.#refreshActive());
		this.listen(editorPool, 'dirty-changed', ({ tabId, dirty }) => {
			this.querySelector(`.tab[data-tab-id="${tabId}"]`)
				?.classList.toggle('is-dirty', dirty);
		});
		// Office tabs dirty the same dot: LibreOffice edits are NOT
		// auto-saved, so the dot is real information there, not decoration.
		this.listen(officeDock, 'dirty-changed', ({ tabId }) => {
			this.querySelector(`.tab[data-tab-id="${tabId}"]`)
				?.classList.toggle('is-dirty', officeDock.isDirty(tabId));
		});
	}

	get group() {
		return workspaceStore.allGroups().find((g) => g.id === this.groupId) ?? null;
	}

	render() {
		const group = this.group;
		if (!group) return;

		// Rebuild ONLY when the tab list itself changed. Activation must not
		// replace the DOM: a click's pointerdown activates the tab, and
		// rebuilding then would detach the very element (close ×, the tab
		// being dragged) before its pointerup/click arrives.
		const signature = this.groupId + '|'
			+ group.tabs.map((t) => `${t.id}:${t.pinned ? 1 : 0}:${tabTitle(t)}`).join('|');
		if (signature === this.#signature && this.querySelector('.tab-strip')) {
			this.#refreshActive();
			this.#syncModes();
			return;
		}
		this.#signature = signature;

		const strip = document.createElement('div');
		strip.className = 'tab-strip';
		for (const tab of group.tabs) {
			strip.append(this.#makeTab(tab, tab.id === group.activeTabId));
		}

		const addButton = document.createElement('button');
		addButton.className = 'tab-add';
		addButton.title = 'New tab';
		addButton.append(icon('plus'));
		addButton.addEventListener('click', () => {
			workspaceStore.openTab(this.groupId, createTab('empty'));
		});

		this.#modes ??= this.#makeModes();
		this.replaceChildren(strip, this.#modes, addButton);
		this.#syncModes();
	}

	#modes = null;

	/** The segmented switch, made once and kept across tab-list rebuilds. */
	#makeModes() {
		const wrap = document.createElement('div');
		wrap.className = 'tab-modes toolbar-segmented';
		wrap.setAttribute('role', 'group');
		wrap.setAttribute('aria-label', 'View mode');
		for (const option of VIEW_MODES) {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'toolbar-button tab-mode';
			b.dataset.value = option.value;
			b.dataset.command = option.command;
			b.setAttribute('aria-pressed', 'false');
			b.append(icon(option.icon));
			// Clicking must not take focus or the selection from the note.
			b.addEventListener('pointerdown', (e) => e.preventDefault());
			b.addEventListener('click', () => {
				// The commands act on the ACTIVE pane's tab: make it this one.
				workspaceStore.setActiveGroup(this.groupId);
				runCommand(option.command);
			});
			wrap.append(b);
		}
		wrap.addEventListener('keydown', (e) => this.#modeKeys(e));
		return wrap;
	}

	/** Pressed state and availability from this pane's active tab. */
	#syncModes() {
		if (!this.#modes) return;
		const group = this.group;
		const tab = group?.tabs.find((t) => t.id === group.activeTabId) ?? null;
		const has = tab?.kind === 'note';
		const mode = tab?.view?.mode ?? 'source';
		this.#modes.classList.toggle('is-unavailable', !has);
		this.#modes.setAttribute('aria-hidden', String(!has));
		for (const b of this.#modes.querySelectorAll('.tab-mode')) {
			const option = VIEW_MODES.find((o) => o.value === b.dataset.value);
			const pressed = has && mode === option.value;
			b.setAttribute('aria-pressed', String(pressed));
			b.disabled = !has;
			b.tabIndex = pressed ? 0 : -1;
			const chord = chordFor(option.command);
			const title = chord ? `${option.label} (${chord})` : option.label;
			if (b.title !== title) {
				b.title = title;
				b.setAttribute('aria-label', option.label);
			}
		}
	}

	/** Keyboard: arrows move between the three, Escape returns to the note. */
	#modeKeys(e) {
		const buttons = [...this.#modes.querySelectorAll('.tab-mode:not([disabled])')];
		const at = buttons.indexOf(document.activeElement);
		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			e.preventDefault();
			const next = buttons[(at + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
			next?.focus();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			this.closest('clew-tab-group')?.focusView?.();
		}
	}

	/** Focus the pressed mode (view:focus-toolbar where there is no toolbar). */
	focusModes() {
		const target = this.#modes?.querySelector('.tab-mode[aria-pressed="true"]');
		target?.focus();
		return Boolean(target);
	}

	#makeTab(tab, isActive) {
		const el = document.createElement('div');
		el.className = 'tab';
		el.dataset.tabId = tab.id;
		el.classList.toggle('is-active', isActive);
		el.classList.toggle('is-pinned', !!tab.pinned);
		el.classList.toggle('is-dirty', editorPool.isDirty(tab.id) || officeDock.isDirty(tab.id));

		const title = document.createElement('span');
		title.className = 'tab-title';
		title.textContent = tabTitle(tab);
		title.title = tab.path ?? '';
		el.append(title);

		if (tab.pinned) {
			const pin = document.createElement('span');
			pin.className = 'tab-pin';
			pin.append(icon('thumbtack'));
			pin.title = 'Pinned (right-click to unpin)';
			el.append(pin);
		} else {
			const close = document.createElement('button');
			close.className = 'tab-close';
			close.setAttribute('aria-label', 'Close tab');
			close.append(icon('xmark'));
			close.addEventListener('click', (e) => {
				e.stopPropagation();
				this.#closeTab(tab.id);
			});
			el.append(close);
		}

		el.addEventListener('pointerdown', (e) => {
			if (e.button === 1 || e.button === 2) return;
			workspaceStore.activateTab(tab.id);
			startTabDrag(e, { tabId: tab.id, groupId: this.groupId, tabEl: el });
		});
		el.addEventListener('auxclick', (e) => {
			if (e.button === 1 && !tab.pinned) this.#closeTab(tab.id);
		});
		el.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			this.#tabMenu(tab, e.clientX, e.clientY);
		});
		return el;
	}

	#tabMenu(tab, x, y) {
		const group = this.group;
		if (!group) return;
		const index = group.tabs.findIndex((t) => t.id === tab.id);
		const closable = (t) => !t.pinned && t.id !== tab.id;
		const others = group.tabs.filter(closable);
		const toRight = group.tabs.slice(index + 1).filter((t) => !t.pinned);
		const closeAll = (tabs) => {
			for (const t of tabs) this.#closeTab(t.id);
		};
		showMenu(x, y, [
			tab.pinned
				? { label: 'Unpin', click: () => workspaceStore.pinTab(tab.id, false) }
				: { label: 'Pin', click: () => workspaceStore.pinTab(tab.id, true) },
			{ separator: true },
			...(tab.pinned ? [] : [{ label: 'Close', click: () => this.#closeTab(tab.id) }]),
			// "This" rather than "current": you right-clicked the pane, so which
			// one closes is unambiguous even when another pane holds focus.
			...(workspaceStore.allGroups().length > 1 ? [{ label: 'Close this pane', click: () => {
				for (const t of [...(this.group?.tabs ?? [])]) editorPool.close(t.id);
				workspaceStore.closeGroup(this.groupId);
			} }] : []),
			{ label: `Close others${others.length ? ` (${others.length})` : ''}`, click: () => closeAll(others) },
			{ label: `Close tabs to the right${toRight.length ? ` (${toRight.length})` : ''}`, click: () => closeAll(toRight) },
		]);
	}

	#closeTab(tabId) {
		editorPool.close(tabId);
		workspaceStore.closeTab(tabId);
	}

	#refreshActive() {
		const group = this.group;
		if (!group) return;
		this.querySelectorAll('.tab-drop-marker').forEach((el) => el.remove());
		for (const el of this.querySelectorAll('.tab')) {
			el.classList.toggle('is-active', el.dataset.tabId === group.activeTabId);
		}
		this.#syncModes();
	}
}

customElements.define('clew-tab-bar', ClewTabBar);
