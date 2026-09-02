// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Meta Bind widgets, client side. The engine renders Web Awesome elements
// carrying the same data-edit-* contract the editable query cells use, so a
// change becomes the same field-edit message and the same write path. The
// file change then re-renders the note, which is what brings every OTHER
// view of that property (tables, kanban, the properties panel) into line —
// a widget never updates anything but the file.
//
// The component library itself (wa.js + wa.css, ~200 KB) loads LAZILY, only
// when a rendered document actually contains a widget: a note without them
// never pays. Until the definitions arrive, custom elements are inert but
// present; they upgrade in place when the script lands.
const post = (msg) => window.parent.postMessage({ source: 'clew-preview', ...msg }, '*');

const WA_TAGS = 'wa-switch, wa-slider, wa-select, wa-input, wa-number-input, '
	+ 'wa-time-input, wa-textarea, wa-rating, wa-color-picker, wa-progress-bar, '
	+ 'wa-relative-time, wa-format-date, wa-format-number, wa-format-bytes, wa-badge, wa-qr-code';

let waLoaded = false;
function ensureWebAwesome() {
	if (waLoaded || !document.querySelector(WA_TAGS)) return;
	waLoaded = true;
	const link = document.createElement('link');
	link.rel = 'stylesheet';
	link.href = '/__clew_preview__/wa.css';
	const script = document.createElement('script');
	script.src = '/__clew_preview__/wa.js';
	document.head.append(link, script);
}

export function initMetaBind() {
	ensureWebAwesome();
	document.addEventListener('clew:render', ensureWebAwesome);

	document.addEventListener('change', (event) => {
		const el = event.target;
		if (!el.classList?.contains('clew-mb')) return;
		const value = (el.tagName === 'WA-SWITCH' || el.type === 'checkbox')
			? String(el.checked) : String(el.value ?? '');
		post({
			type: 'field-edit',
			path: el.dataset.editPath,
			field: el.dataset.editField,
			fieldSource: el.dataset.editSource,
			value,
		});
	});
	// Sliders show their number live while dragging; the write waits for
	// 'change' (release), so a drag is one edit, not forty.
	document.addEventListener('input', (event) => {
		const el = event.target;
		if (!el.classList?.contains('clew-mb')) return;
		if (el.tagName !== 'WA-SLIDER' && el.type !== 'range') return;
		const bubble = el.parentElement?.querySelector('.clew-mb-value');
		if (bubble) bubble.textContent = el.value;
	});
}
