// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Office-document embeds, client side.
//
// THUMBNAILS: the engine emits an empty `.office-embed-thumb
// [data-office-path]` anchor; this asks the app page (window.top — this
// may run nested inside a canvas-embed note frame) for the cached
// thumbnail, which the app renders on demand with an offscreen ZetaOffice
// (main/office-thumbs.js). The reply carries a ready-to-use URL, stamped
// so a re-saved document busts the image.
//
// LIVE embeds: an iframe cannot stay in the morphed content flow — ANY
// DOM move reloads an iframe, and a paragraph typed above the embed
// shifts it, which would reboot LibreOffice and discard unsaved edits
// (the same physics that made the office tab an overlay dock). So the
// engine's iframe is HOISTED on first sight into an absolutely-positioned
// holder on document.body (data-clew-keep: morphs never discard it, and
// absolute coordinates ride document scroll for free), leaving a sized
// placeholder slot in the flow. Re-renders replace the slot's fresh inert
// iframe with a placeholder again and reposition the holder; a slot that
// disappears takes its holder (and editor) with it.

let seq = 0;
const pending = new Map(); // id → element
const holders = new Map(); // frameId → holder element on document.body

window.addEventListener('message', (event) => {
	const msg = event.data;
	if (msg?.source !== 'clew-office-embed-host' || !pending.has(msg.id)) return;
	const el = pending.get(msg.id);
	pending.delete(msg.id);
	if (!el.isConnected) return;
	el.replaceChildren();
	if (msg.ok) {
		const img = document.createElement('img');
		img.className = 'office-thumb-img';
		img.alt = '';
		img.src = msg.url;
		el.append(img);
	} else {
		const note = document.createElement('span');
		note.className = 'office-thumb-missing';
		note.textContent = msg.reason === 'no-engine'
			? 'No office engine yet — open the document to download it, or use Settings → Office documents. Click to open.'
			: `Office thumbnail unavailable: ${msg.reason}`;
		el.append(note);
	}
});

export function initOfficeEmbeds() {
	for (const el of document.querySelectorAll('.office-embed-thumb[data-office-path]')) {
		if (el.dataset.officeRequested) continue;
		el.dataset.officeRequested = '1';
		const id = `ot${++seq}`;
		pending.set(id, el);
		try {
			window.top.postMessage(
				{ source: 'clew-office-embed', type: 'office-thumb', id, path: el.dataset.officePath }, '*');
		} catch { /* no app page (static host) — the title link still works */ }
	}
	hoistLiveEmbeds();
}

function hoistLiveEmbeds() {
	// Fresh (or re-rendered) live iframes in the flow → placeholder slots.
	for (const iframe of document.querySelectorAll('.office-embed-box.is-live iframe.office-embed-live')) {
		const id = iframe.id;
		// The morph strips src into data-live-src (client.js) so flow
		// iframes never boot; first-render iframes still carry src proper.
		const src = iframe.getAttribute('src') || iframe.dataset.liveSrc;
		const slot = document.createElement('div');
		slot.className = 'office-live-slot';
		slot.dataset.liveFor = id;
		slot.style.height = iframe.style.height;
		iframe.replaceWith(slot);
		if (!holders.has(id) && src) {
			// A FRESH iframe, src set only after it is in the document: a
			// parser-created iframe detached before its first load commits
			// does not reliably renavigate on reinsertion (measured — the
			// editor never booted), so the flow iframe is only a template.
			const live = document.createElement('iframe');
			live.className = 'office-embed-live';
			live.allow = iframe.getAttribute('allow') ?? '';
			const holder = document.createElement('div');
			holder.className = 'office-live-holder';
			holder.setAttribute('data-clew-keep', '');
			holder.dataset.liveId = id;
			holder.append(live);
			document.body.append(holder);
			holders.set(id, holder);
			live.src = src;
		}
	}
	// Slots gone from the document take their editors down (embed deleted).
	for (const [id, holder] of holders) {
		if (!document.querySelector(`.office-live-slot[data-live-for="${CSS.escape(id)}"]`)) {
			holder.remove();
			holders.delete(id);
		}
	}
	positionLiveHolders();
}

function positionLiveHolders() {
	for (const [id, holder] of holders) {
		const slot = document.querySelector(`.office-live-slot[data-live-for="${CSS.escape(id)}"]`);
		if (!slot) continue;
		const rect = slot.getBoundingClientRect();
		holder.style.top = `${rect.top + window.scrollY}px`;
		holder.style.left = `${rect.left + window.scrollX}px`;
		holder.style.width = `${rect.width}px`;
		holder.style.height = `${rect.height}px`;
	}
}

window.addEventListener('resize', positionLiveHolders);
// Layout shifts without a morph (images finishing, MathJax typesetting)
// still move the slots; a body-level observer catches everything cheaply.
if (document.body) {
	new ResizeObserver(positionLiveHolders).observe(document.body);
} else {
	document.addEventListener('DOMContentLoaded', () =>
		new ResizeObserver(positionLiveHolders).observe(document.body));
}
