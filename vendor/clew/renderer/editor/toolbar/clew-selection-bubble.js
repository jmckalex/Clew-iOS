// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// <clew-selection-bubble>: the small formatting bar over a selection (plan
// §6.7). One per window. It appears when the active editor's selection has
// been non-empty and still for 400ms (or on the pointerup that made it),
// above the selection's first line, and goes on a collapse, an edit, a
// scroll, a blur, Escape, or when the `selectionBubble` setting is off.
// Same spec items as the toolbar's text-style group, same commands.
import { runCommand, effectiveKeymap } from '../../commands/registry.js';
import { prettifyChord } from '../../commands/builtin.js';
import { icon } from '../../lib/icons.js';
import { editorPool } from '../pool.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { settingsStore } from '../../state/settings-store.js';
import { vaultSettingsStore } from '../../state/vault-settings-store.js';
import { liveModel } from '../live/model.js';
import { deriveState } from './toolbar-state.js';
import { activeCellOf } from '../live/active-cell.js';
import { TOOLBAR_GROUPS, BUBBLE_GROUPS, BUBBLE_EXTRA, labelOf } from './toolbar-spec.js';
import { openPopover, popoverOpen } from './popover.js';
import { buildPopover } from './popovers.js';

const STILL_MS = 400;

class ClewSelectionBubble extends HTMLElement {
	#timer = null;
	#view = null;
	#buttons = [];

	connectedCallback() {
		this.hidden = true;
		this.setAttribute('role', 'toolbar');
		this.setAttribute('aria-label', 'Selection formatting');
		const items = [
			...TOOLBAR_GROUPS.filter((g) => BUBBLE_GROUPS.includes(g.id)).flatMap((g) => g.items),
			...BUBBLE_EXTRA,
		];
		for (const item of items) {
			const b = document.createElement('button');
			b.className = 'toolbar-button';
			b.type = 'button';
			b.append(icon(item.icon));
			if (item.kind === 'toggle') b.setAttribute('aria-pressed', 'false');
			b.addEventListener('pointerdown', (e) => e.preventDefault());
			b.addEventListener('click', () => {
				if (item.popover) openPopover({ anchor: b, build: (close) => buildPopover(item.popover, close, this.state ?? {}) });
				else { runCommand(item.command); this.#schedule(); }
			});
			this.#buttons.push({ item, el: b });
			this.append(b);
		}
		this.offPool = editorPool.on('view-update', ({ tabId, update }) => this.#onUpdate(tabId, update));
		this.onKey = (e) => { if (e.key === 'Escape' && !this.hidden) this.hide(); };
		this.onScroll = () => this.hide();
		this.onPointerUp = () => this.#schedule(0);
		document.addEventListener('keydown', this.onKey, true);
		document.addEventListener('pointerup', this.onPointerUp, true);
		window.addEventListener('blur', this.onScroll);
	}

	disconnectedCallback() {
		this.offPool?.();
		document.removeEventListener('keydown', this.onKey, true);
		document.removeEventListener('pointerup', this.onPointerUp, true);
		window.removeEventListener('blur', this.onScroll);
	}

	hide() {
		clearTimeout(this.#timer);
		this.hidden = true;
		this.#view?.scrollDOM.removeEventListener('scroll', this.onScroll);
	}

	#onUpdate(tabId, update) {
		if (tabId !== workspaceStore.activeTab()?.id) return;
		if (update.docChanged || update.state.selection.main.empty) { this.hide(); return; }
		this.#schedule();
	}

	#schedule(delay = STILL_MS) {
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => this.#show(), delay);
	}

	#show() {
		if (settingsStore.get('selectionBubble') === false || popoverOpen()) return;
		const tab = workspaceStore.activeTab();
		const view = editorPool.get(tab?.id)?.view;
		// A table cell being edited in place has the toolbar's text styles and
		// no room above it for a bubble; the bubble stays out of cells.
		if (!view || tab.view.mode === 'reading' || !view.hasFocus || activeCellOf(view.state)) { this.hide(); return; }
		const sel = view.state.selection.main;
		if (sel.empty) { this.hide(); return; }
		const start = view.coordsAtPos(sel.from);
		const end = view.coordsAtPos(sel.to);
		if (!start || !end) { this.hide(); return; }
		const normalSyntax = vaultSettingsStore.get('normalSyntax') === true;
		this.state = deriveState(view.state, liveModel(view.state, { normalSyntax }), { mode: tab.view.mode, normalSyntax });
		for (const { item, el } of this.#buttons) {
			const label = labelOf(item, this.state) ?? '';
			let chord = '';
			for (const [c, id] of effectiveKeymap()) if (id === item.command) { chord = prettifyChord(c); break; }
			el.title = chord ? `${label} (${chord})` : label;
			el.setAttribute('aria-label', label);
			if (item.active) el.setAttribute('aria-pressed', String(Boolean(item.active(this.state))));
			el.hidden = Boolean(item.when && !item.when(this.state));
		}
		this.hidden = false;
		const r = this.getBoundingClientRect();
		const middle = start.top === end.top ? (start.left + end.left) / 2 : start.left + 60;
		let top = start.top - r.height - 8;
		if (top < 8) top = end.bottom + 8;
		this.style.top = `${Math.round(top)}px`;
		this.style.left = `${Math.round(Math.max(8, Math.min(middle - r.width / 2, window.innerWidth - r.width - 8)))}px`;
		if (this.#view !== view) {
			this.#view?.scrollDOM.removeEventListener('scroll', this.onScroll);
			this.#view = view;
		}
		view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
	}
}

customElements.define('clew-selection-bubble', ClewSelectionBubble);
