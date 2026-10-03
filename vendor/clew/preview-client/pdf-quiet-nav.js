// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// A quieter page navigator (the "‹ 2 18 ›" pill EmbedPDF draws at the
// bottom of every viewer; the owner's ask, 2026-10-03). EmbedPDF SHOWS it on
// every scroll and hides it four seconds later — over the text being read.
// Here it is the other way round:
//
// - hidden while the document scrolls;
// - shown when the pointer comes into a band around where it sits (the
//   bottom of the viewer, a little wider than the pill), and kept while the
//   pointer is in the band or on it, or while it holds the KEYBOARD focus
//   (Tab, the page field) — not the focus a click leaves on its buttons;
// - kept while its own ‹ › turn the page under the pointer;
// - faded out shortly after the pointer leaves;
// - on a touch screen (no hover), a TAP in that band shows it for a few
//   seconds, and a tap anywhere else hides it.
//
// From Clew's side, no fork change: a stylesheet in the viewer's shadow root
// overrides the pill's own opacity (`data-overlay-id="page-controls"`, the
// schema's overlay id) and a class says when to show it. One per viewer;
// pdf-core.js installs it.
const BAND_ABOVE = 56;     // px above the pill's top edge
const BAND_SIDES = 96;     // px either side of it
const FADE_AFTER = 700;    // ms after the pointer leaves
const TAP_SHOWS = 4000;    // ms a tap keeps it on a touch screen
const SCROLL_QUIET = 250;  // ms after the last scroll before a hover counts

const CSS = `
[data-overlay-id="page-controls"] > * > * {
	opacity: 0 !important;
	transition: opacity 180ms ease !important;
}
/* KEYBOARD focus shows it — Tab, or the page field being typed in (a text
   field is always :focus-visible) — but not the focus a mouse click leaves
   on its ‹ › buttons, which would keep it up after the pointer has gone. */
[data-overlay-id="page-controls"].clew-nav-shown > * > *,
[data-overlay-id="page-controls"]:has(:focus-visible) > * > * {
	opacity: 1 !important;
}
/* Hidden, it takes no clicks: the text under it stays selectable. */
[data-overlay-id="page-controls"]:not(.clew-nav-shown):not(:has(:focus-visible)) * {
	pointer-events: none !important;
}
`;

/** Whether a client point is in the band around the pill. Pure. */
export function inNavBand(point, pill, viewer) {
	if (!pill || !pill.width) return false;
	return point.x >= pill.left - BAND_SIDES && point.x <= pill.right + BAND_SIDES
		&& point.y >= pill.top - BAND_ABOVE && point.y <= Math.max(pill.bottom, viewer?.bottom ?? pill.bottom);
}

/**
 * @param {HTMLElement} host - the viewer's container (EmbedPDF's custom
 *   element, whose shadowRoot holds the UI)
 * @returns {() => void} uninstall
 */
export function installQuietNavigator(host) {
	const root = host?.shadowRoot;
	if (!root) return () => {};
	const style = document.createElement('style');
	style.dataset.clew = 'quiet-navigator';
	style.textContent = CSS;
	root.append(style);
	const pill = () => root.querySelector('[data-overlay-id="page-controls"]');
	let hideTimer = null;
	let scrolledAt = 0;
	let onPill = false;   // the pointer is over the pill itself
	const show = (on) => {
		clearTimeout(hideTimer);
		hideTimer = null;
		pill()?.classList.toggle('clew-nav-shown', on);
	};
	const hideSoon = (ms = FADE_AFTER) => {
		if (hideTimer || !pill()?.classList.contains('clew-nav-shown')) return;
		hideTimer = setTimeout(() => { hideTimer = null; pill()?.classList.remove('clew-nav-shown'); }, ms);
	};
	const where = (e) => inNavBand({ x: e.clientX, y: e.clientY }, pill()?.getBoundingClientRect(), host.getBoundingClientRect());
	const onMove = (e) => {
		if (e.pointerType === 'touch') return;
		onPill = Boolean(pill()?.contains(e.composedPath?.()[0] ?? null));
		if (Date.now() - scrolledAt < SCROLL_QUIET && !onPill) return;
		if (where(e)) show(true);
		else hideSoon();
	};
	const onLeave = () => { onPill = false; hideSoon(); };
	const onTap = (e) => {
		if (e.pointerType !== 'touch') return;
		if (where(e)) {
			show(true);
			hideTimer = setTimeout(() => { hideTimer = null; pill()?.classList.remove('clew-nav-shown'); }, TAP_SHOWS);
		} else if (!pill()?.contains(e.composedPath?.()[0] ?? null)) show(false);
	};
	// Scrolling hides it at once — unless the pointer is on it (its own ‹ ›
	// scroll the document) or it holds the keyboard focus (a page number
	// being typed, which :focus-visible keeps regardless).
	const onScroll = () => {
		scrolledAt = Date.now();
		if (!onPill) show(false);
	};
	host.addEventListener('pointermove', onMove);
	host.addEventListener('pointerleave', onLeave);
	host.addEventListener('pointerdown', onTap);
	root.addEventListener('scroll', onScroll, true);
	root.addEventListener('wheel', onScroll, { capture: true, passive: true });
	return () => {
		clearTimeout(hideTimer);
		style.remove();
		host.removeEventListener('pointermove', onMove);
		host.removeEventListener('pointerleave', onLeave);
		host.removeEventListener('pointerdown', onTap);
		root.removeEventListener('scroll', onScroll, true);
		root.removeEventListener('wheel', onScroll, { capture: true });
	};
}
