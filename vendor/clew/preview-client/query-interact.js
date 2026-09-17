// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Interactivity for ```query tables and ```kanban boards: editable cells
// and drag-between-columns cards. Both end in the same place — a
// field-edit message the host applies to the SOURCE note's frontmatter,
// after which the live-query re-render brings the view back in sync. The view is just a projection; the truth
// stays in the files.

const post = (msg) => window.parent.postMessage({ source: 'clew-preview', ...msg }, '*');

export function initQueryInteract() {
	// One document-level wiring; elements are re-created by every morph, so
	// handlers are delegated rather than attached per element.
	if (document.body.dataset.queryInteract) return;
	document.body.dataset.queryInteract = '1';

	// ---- editable table cells ----
	document.addEventListener('click', (e) => {
		const cell = e.target.closest?.('td.clew-q-cell');
		if (!cell || cell.querySelector('input')) return;
		const original = cell.textContent;
		const input = document.createElement('input');
		input.className = 'clew-q-edit';
		input.value = original;
		cell.replaceChildren(input);
		input.focus();
		input.select();
		let done = false;
		const finish = (commit) => {
			if (done) return;
			done = true;
			const value = input.value.trim();
			cell.textContent = commit ? value : original;
			if (commit && value !== original.trim()) {
				// 'fieldSource', not 'source' — the message envelope's own
				// source field must stay 'clew-preview'.
				post({
					type: 'field-edit',
					path: cell.dataset.editPath,
					field: cell.dataset.editField,
					fieldSource: cell.dataset.editSource,
					value,
				});
			}
		};
		input.addEventListener('keydown', (ev) => {
			ev.stopPropagation();
			if (ev.key === 'Enter') finish(true);
			if (ev.key === 'Escape') finish(false);
		});
		input.addEventListener('blur', () => finish(true));
	});

	// ---- kanban drag & drop ----
	let dragging = null; // { path, card }
	document.addEventListener('dragstart', (e) => {
		const card = e.target.closest?.('.kanban-card');
		if (!card) return;
		dragging = { path: card.dataset.kanbanPath, card };
		card.classList.add('is-dragging');
		e.dataTransfer.effectAllowed = 'move';
		e.dataTransfer.setData('text/plain', card.dataset.kanbanPath);
	});
	document.addEventListener('dragend', () => {
		dragging?.card.classList.remove('is-dragging');
		document.querySelectorAll('.kanban-col.is-target')
			.forEach((col) => col.classList.remove('is-target'));
		dragging = null;
	});
	document.addEventListener('dragover', (e) => {
		const col = e.target.closest?.('.kanban-col');
		if (!col || !dragging) return;
		e.preventDefault(); // allow the drop
		e.dataTransfer.dropEffect = 'move';
		document.querySelectorAll('.kanban-col.is-target')
			.forEach((c) => c !== col && c.classList.remove('is-target'));
		col.classList.add('is-target');
	});
	document.addEventListener('drop', (e) => {
		const col = e.target.closest?.('.kanban-col');
		if (!col || !dragging) return;
		e.preventDefault();
		const board = col.closest('.clew-kanban');
		const value = col.dataset.kanbanValue;
		// Optimistic move; the live re-render confirms from the file.
		col.append(dragging.card);
		post({
			type: 'field-edit',
			path: dragging.path,
			field: board.dataset.kanbanField,
			fieldSource: 'fm',
			value,
		});
	});

	// Kanban cards open their note on double-click (single click = drag).
	document.addEventListener('dblclick', (e) => {
		const card = e.target.closest?.('.kanban-card');
		if (card) post({ type: 'link-click', target: card.dataset.href, newTab: true });
	});
}
