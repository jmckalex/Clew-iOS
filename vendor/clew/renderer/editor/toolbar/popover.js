// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// One anchored popover at a time (plan §6.6): below its anchor, flipped
// above when it would leave the window, clamped horizontally. Closes on
// Escape (focus back to the anchor), a pointerdown outside, or the window
// losing focus. Arrow keys walk its items. Contents come from popovers.js.
import { viewportEdges } from '../../lib/viewport.js';

let current = null;

/**
 * @param {{ anchor: Element, build: (close: () => void) => Element,
 *   onClose?: () => void, focusFirst?: boolean, className?: string }} spec
 * @returns {() => void} close
 */
export function openPopover({ anchor, build, onClose, focusFirst = true, className = '' }) {
	closePopover();
	const el = document.createElement('div');
	el.className = `clew-popover ${className}`.trim();
	el.setAttribute('role', 'menu');
	let closed = false;
	const close = ({ refocus = false } = {}) => {
		if (closed) return;
		closed = true;
		el.remove();
		document.removeEventListener('pointerdown', outside, true);
		window.removeEventListener('blur', blurred);
		if (current?.el === el) current = null;
		if (refocus) anchor.focus?.();
		onClose?.();
	};
	const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
	const blurred = () => close();
	el.append(build(close));
	el.addEventListener('keydown', (e) => {
		e.stopPropagation();
		if (e.key === 'Escape') { e.preventDefault(); close({ refocus: true }); return; }
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
		if (e.target.matches?.('input[type="text"], input:not([type])') && e.target.closest('.popover-form')) return;
		const items = [...el.querySelectorAll('.popover-item:not([disabled]), .popover-grid-cell')];
		if (!items.length) return;
		e.preventDefault();
		const at = items.indexOf(document.activeElement);
		const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
		items[next].focus();
	});
	document.body.append(el);
	position(el, anchor);
	document.addEventListener('pointerdown', outside, true);
	window.addEventListener('blur', blurred);
	current = { el, close };
	if (focusFirst) (el.querySelector('input, .popover-item, .popover-grid-cell, button'))?.focus();
	return close;
}

export function closePopover() { current?.close(); }

export function popoverOpen() { return current !== null; }

function position(el, anchor) {
	const a = anchor.getBoundingClientRect();
	const r = el.getBoundingClientRect();
	const { right, bottom } = viewportEdges();
	let top = a.bottom + 4;
	if (top + r.height > bottom - 8 && a.top - r.height - 4 > 8) top = a.top - r.height - 4;
	const left = Math.max(8, Math.min(a.left, right - r.width - 8));
	el.style.top = `${Math.round(top)}px`;
	el.style.left = `${Math.round(left)}px`;
}

/** A menu row: a button with an optional icon element and chord text. */
export function menuItem(label, onPick, { icon = null, chord = '', checked = false, disabled = false } = {}) {
	const b = document.createElement('button');
	b.className = `popover-item${checked ? ' is-checked' : ''}`;
	b.setAttribute('role', 'menuitem');
	b.disabled = disabled;
	if (icon) b.append(icon);
	const text = document.createElement('span');
	text.className = 'popover-label';
	text.textContent = label;
	b.append(text);
	if (chord) {
		const c = document.createElement('span');
		c.className = 'popover-chord';
		c.textContent = chord;
		b.append(c);
	}
	b.addEventListener('pointerdown', (e) => e.preventDefault());
	b.addEventListener('click', () => onPick());
	return b;
}

export function menuSeparator() {
	const hr = document.createElement('div');
	hr.className = 'popover-separator';
	return hr;
}

export function menuHeading(text) {
	const h = document.createElement('div');
	h.className = 'popover-heading';
	h.textContent = text;
	return h;
}
