// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Meta Bind widgets, client side: every .clew-mb element carries the same
// data-edit-* contract the editable query cells use, so a change becomes
// the same field-edit message and the same write path. The file change then
// re-renders the note, which is what brings every OTHER view of that
// property (tables, kanban, the properties panel) into line — the widget
// never updates anything but the file.
const post = (msg) => window.parent.postMessage({ source: 'clew-preview', ...msg }, '*');

export function initMetaBind() {
	document.addEventListener('change', (event) => {
		const el = event.target;
		if (!el.classList?.contains('clew-mb')) return;
		const value = el.type === 'checkbox' ? String(el.checked) : String(el.value);
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
		if (!el.classList?.contains('clew-mb') || el.type !== 'range') return;
		const bubble = el.parentElement?.querySelector('.clew-mb-value');
		if (bubble) bubble.textContent = el.value;
	});
}
