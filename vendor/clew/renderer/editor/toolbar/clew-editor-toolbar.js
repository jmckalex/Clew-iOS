// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// <clew-editor-toolbar>: the formatting bar above a note editor (plan §6.5),
// rendered from toolbar-spec.js.
//
//   - Every control runs a COMMAND through the registry (its `when` gate
//     applies; the tooltip shows the effective chord).
//   - It never steals focus: pointerdown is prevented, so the editor keeps
//     its selection; popovers that need typing take focus and give it back.
//   - State (pressed, enabled, the block label) is PATCHED from setState —
//     no re-render per keystroke.
//   - Width-aware: groups that do not fit go into a `…` menu, lowest
//     priority first (toolbar-layout.js); the mode switch never goes.
//   - Keyboard: roving tabindex — ⌥⇧T (view:focus-toolbar) enters, arrows
//     move, Home/End jump, Enter/Space activate, Escape returns to the editor.
//
// `slim`: reading mode's bar, which holds only the mode switch.
import { runCommand, effectiveKeymap } from '../../commands/registry.js';
import { prettifyChord } from '../../commands/builtin.js';
import { icon } from '../../lib/icons.js';
import { settingsStore } from '../../state/settings-store.js';
import { orderedGroups, labelOf } from './toolbar-spec.js';
import { layoutGroups } from './toolbar-layout.js';
import { openPopover, menuItem, menuHeading, menuSeparator } from './popover.js';
import { buildPopover } from './popovers.js';

/** Plugin buttons (clew.toolbar.addButton), shared by every toolbar. */
const pluginItems = [];
const toolbars = new Set();
export function addToolbarButton(spec) {
	const item = { kind: 'button', group: spec.group ?? 'insert', icon: spec.icon, label: spec.label, command: spec.command, plugin: true };
	pluginItems.push(item);
	for (const bar of toolbars) bar.rebuild();
	return () => {
		const at = pluginItems.indexOf(item);
		if (at !== -1) pluginItems.splice(at, 1);
		for (const bar of toolbars) bar.rebuild();
	};
}

const chordFor = (id) => {
	if (!id) return '';
	for (const [chord, mapped] of effectiveKeymap()) if (mapped === id) return prettifyChord(chord);
	return '';
};

function iconEl(name) {
	if (!name) return null;
	if (typeof name === 'string' && name.startsWith('<svg')) {
		const span = document.createElement('span');
		span.className = 'ui-icon';
		span.innerHTML = name;
		return span;
	}
	try { return icon(name); } catch { return null; }
}

export class ClewEditorToolbar extends HTMLElement {
	/** @type {object} the last state from deriveState */
	state = { mode: 'source', inline: new Set(), blockType: 'paragraph' };
	slim = false;
	#controls = []; // { item, el, groupId }
	#groups = [];
	#observer = null;
	#widths = null;
	#overflow = [];

	connectedCallback() {
		this.setAttribute('role', 'toolbar');
		this.setAttribute('aria-label', this.slim ? 'View mode' : 'Formatting');
		this.classList.add('editor-toolbar');
		toolbars.add(this);
		this.offSettings = settingsStore.on('settings-changed', (key) => {
			if (key === 'editorToolbarGroups' || key === 'hotkeys') this.rebuild();
		});
		this.addEventListener('keydown', (e) => this.#keydown(e));
		this.rebuild();
		this.#observer = new ResizeObserver(() => this.#layout());
		this.#observer.observe(this);
	}

	disconnectedCallback() {
		toolbars.delete(this);
		this.offSettings?.();
		this.#observer?.disconnect();
	}

	/** Re-render from the spec (settings or plugin buttons changed). */
	rebuild() {
		this.#groups = this.slim
			? orderedGroups(null).filter((g) => g.id === 'mode')
			: orderedGroups(settingsStore.get('editorToolbarGroups'), pluginItems);
		this.#controls = [];
		this.#widths = null;
		const frag = document.createDocumentFragment();
		for (const group of this.#groups) {
			const g = document.createElement('div');
			g.className = `toolbar-group${group.align === 'end' ? ' is-end' : ''}`;
			g.dataset.group = group.id;
			g.setAttribute('role', 'group');
			g.setAttribute('aria-label', group.label);
			for (const item of group.items) g.append(this.#control(item, group.id));
			frag.append(g);
		}
		const more = document.createElement('button');
		more.className = 'toolbar-button toolbar-more';
		more.title = 'More';
		more.setAttribute('aria-label', 'More formatting');
		more.append(icon('ellipsis'));
		more.addEventListener('pointerdown', (e) => e.preventDefault());
		more.addEventListener('click', () => this.#openOverflow(more));
		this.more = more;
		frag.append(more);
		this.replaceChildren(frag);
		this.#roving();
		this.setState(this.state);
		requestAnimationFrame(() => this.#layout());
	}

	#control(item, groupId) {
		if (item.kind === 'segmented') {
			const wrap = document.createElement('div');
			wrap.className = 'toolbar-segmented';
			for (const option of item.options) {
				const b = this.#button({ ...option, kind: 'segment' }, groupId);
				b.dataset.value = option.value;
				wrap.append(b);
			}
			return wrap;
		}
		return this.#button(item, groupId);
	}

	#button(item, groupId) {
		const b = document.createElement('button');
		b.className = `toolbar-button${item.kind === 'dropdown' && item.text ? ' toolbar-dropdown' : ''}`;
		b.type = 'button';
		b.tabIndex = -1;
		const i = iconEl(item.icon);
		if (i) b.append(i);
		if (item.text) {
			const span = document.createElement('span');
			span.className = 'toolbar-text';
			if (item.width) span.style.width = `${item.width}px`;
			b.append(span);
			b.append(icon('chevron-down', 'toolbar-caret'));
		}
		if (item.kind === 'toggle' || item.kind === 'segment') b.setAttribute('aria-pressed', 'false');
		if (item.kind === 'dropdown') b.setAttribute('aria-haspopup', 'menu');
		if (item.command) b.dataset.command = item.command;
		if (item.popover) b.dataset.popover = item.popover;
		b.addEventListener('pointerdown', (e) => e.preventDefault());
		b.addEventListener('click', () => this.#activate(item, b));
		this.#controls.push({ item, el: b, groupId });
		return b;
	}

	#activate(item, el) {
		if (item.popover) {
			openPopover({ anchor: el, build: (close) => buildPopover(item.popover, close, this.state) });
			return;
		}
		if (item.command) runCommand(item.command);
	}

	/** Patch pressed / enabled / labels from a new state (no re-render). */
	setState(state) {
		this.state = state;
		for (const { item, el } of this.#controls) {
			const label = labelOf(item, state) ?? '';
			const chord = chordFor(item.command);
			const title = chord ? `${label} (${chord})` : label;
			if (el.title !== title) {
				el.title = title;
				el.setAttribute('aria-label', label);
			}
			if (item.kind === 'segment') {
				el.setAttribute('aria-pressed', String(state.mode === el.dataset.value));
			} else if (item.active) {
				el.setAttribute('aria-pressed', String(Boolean(item.active(state))));
			}
			if (item.enabled) el.disabled = !item.enabled(state);
			if (item.when) el.hidden = !item.when(state);
			if (item.text) {
				const span = el.querySelector('.toolbar-text');
				const text = item.text(state);
				if (span.textContent !== text) span.textContent = text;
			}
		}
		this.#layout();
	}

	/** Which groups fit; the rest go into the `…` menu. */
	#layout() {
		if (!this.isConnected) return;
		const groups = [...this.querySelectorAll(':scope > .toolbar-group')];
		if (!this.#widths) {
			// Measure every group once at full size (per rebuild).
			for (const g of groups) g.hidden = false;
			this.more.hidden = true;
			this.#widths = Object.fromEntries(groups.map((g) => [g.dataset.group, g.getBoundingClientRect().width]));
		}
		const available = this.getBoundingClientRect().width - 16;
		const { visible, overflow } = layoutGroups(this.#groups, this.#widths, available, { state: this.state, separator: 9, overflowButton: 32 });
		for (const g of groups) g.hidden = !visible.includes(g.dataset.group);
		this.#overflow = overflow;
		this.more.hidden = overflow.length === 0;
		this.dataset.overflow = overflow.join(' ');
	}

	#openOverflow(anchor) {
		openPopover({
			anchor,
			build: (close) => {
				const list = document.createElement('div');
				list.className = 'popover-list';
				for (const id of this.#overflow) {
					const group = this.#groups.find((g) => g.id === id);
					list.append(menuHeading(group.label));
					for (const item of group.items) {
						if (item.when && !item.when(this.state)) continue;
						list.append(menuItem(labelOf(item, this.state), () => {
							close();
							if (item.popover) openPopover({ anchor, build: (c) => buildPopover(item.popover, c, this.state) });
							else runCommand(item.command);
						}, { icon: iconEl(item.icon), checked: item.active?.(this.state), disabled: item.enabled ? !item.enabled(this.state) : false }));
					}
				}
				list.append(menuSeparator());
				list.append(menuItem('Customise toolbar…', () => { close(); runCommand('app:settings'); }));
				list.append(menuItem('Hide toolbar', () => { close(); runCommand('view:toggle-toolbar'); }));
				return list;
			},
		});
	}

	// ---- keyboard: roving tabindex ----------------------------------------

	#focusable() {
		return [...this.querySelectorAll('.toolbar-group:not([hidden]) .toolbar-button:not([disabled]):not([hidden]), .toolbar-more:not([hidden])')];
	}

	#roving() {
		const first = this.#focusable()[0];
		if (first) first.tabIndex = 0;
	}

	/** Enter the bar from the keyboard (view:focus-toolbar). */
	focusFirst() {
		const items = this.#focusable();
		for (const b of items) b.tabIndex = -1;
		if (items[0]) { items[0].tabIndex = 0; items[0].focus(); }
	}

	#keydown(e) {
		const items = this.#focusable();
		const at = items.indexOf(document.activeElement);
		if (at === -1) return;
		let next = null;
		if (e.key === 'ArrowRight') next = (at + 1) % items.length;
		else if (e.key === 'ArrowLeft') next = (at - 1 + items.length) % items.length;
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = items.length - 1;
		else if (e.key === 'Escape') {
			e.preventDefault();
			this.dispatchEvent(new CustomEvent('toolbar-escape', { bubbles: true }));
			return;
		} else return;
		e.preventDefault();
		e.stopPropagation();
		items[at].tabIndex = -1;
		items[next].tabIndex = 0;
		items[next].focus();
	}
}

customElements.define('clew-editor-toolbar', ClewEditorToolbar);
