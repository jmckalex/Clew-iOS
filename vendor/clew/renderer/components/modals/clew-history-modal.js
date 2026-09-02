// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The note-history browser: snapshots from .clew/history/ on the left,
// the selected version's text on the right, Restore at the bottom.
// Restore goes through main (HISTORY_RESTORE force-snapshots the text it
// displaces first), and the open editor follows over the normal
// external-change path — no unsaved edits means a silent reload.
import { ipc, CH } from '../../ipc.js';
import { notice } from '../../plugins.js';

function relativeTime(ms) {
	const mins = Math.round((Date.now() - ms) / 60_000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins} min ago`;
	const hours = Math.round(mins / 60);
	if (hours < 48) return `${hours} h ago`;
	return `${Math.round(hours / 24)} days ago`;
}

export async function openHistoryModal(notePath) {
	if (document.querySelector('.clew-modal')) return;
	const snapshots = await ipc.invoke(CH.HISTORY_LIST, { path: notePath }).catch(() => []);

	const overlay = document.createElement('div');
	overlay.className = 'clew-modal';
	overlay.innerHTML = `
		<div class="modal-box history-box">
			<div class="history-title"></div>
			<div class="history-body">
				<div class="history-versions"></div>
				<pre class="history-preview"></pre>
			</div>
			<div class="history-footer">
				<span class="history-hint"></span>
				<button class="history-restore" type="button">Restore this version</button>
			</div>
		</div>
	`;
	const name = notePath.split('/').pop();
	overlay.querySelector('.history-title').textContent = `History — ${name}`;
	const versionsEl = overlay.querySelector('.history-versions');
	const previewEl = overlay.querySelector('.history-preview');
	const hintEl = overlay.querySelector('.history-hint');
	const restoreBtn = overlay.querySelector('.history-restore');
	let selected = 0;

	const close = () => {
		overlay.remove();
		window.removeEventListener('keydown', onKey, true);
	};

	const showSelected = async () => {
		const snap = snapshots[selected];
		if (!snap) return;
		previewEl.textContent = await ipc.invoke(CH.HISTORY_READ, { path: notePath, id: snap.id })
			.catch(() => '(snapshot unreadable)');
	};

	const renderVersions = () => {
		versionsEl.replaceChildren(...snapshots.map((snap, i) => {
			const row = document.createElement('div');
			row.className = 'modal-result' + (i === selected ? ' is-selected' : '');
			const label = document.createElement('span');
			label.className = 'result-label';
			label.textContent = new Date(snap.time).toLocaleString();
			const size = snap.size < 1024 ? `${snap.size} B` : `${(snap.size / 1024).toFixed(1)} KB`;
			const hint = document.createElement('span');
			hint.className = 'result-hint';
			hint.textContent = `${relativeTime(snap.time)} · ${size}`;
			row.append(label, hint);
			row.addEventListener('pointerdown', (e) => {
				e.preventDefault();
				selected = i;
				renderVersions();
				showSelected();
			});
			return row;
		}));
		if (snapshots.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'modal-empty';
			empty.textContent = 'No snapshots yet — history collects versions as you edit.';
			versionsEl.replaceChildren(empty);
			restoreBtn.disabled = true;
		}
	};

	restoreBtn.addEventListener('click', async () => {
		const snap = snapshots[selected];
		if (!snap) return;
		try {
			await ipc.invoke(CH.HISTORY_RESTORE, { path: notePath, id: snap.id });
			notice(`Restored ${name} to ${new Date(snap.time).toLocaleString()}`);
			close();
		} catch (err) {
			notice(`Restore failed: ${err?.message ?? err}`);
		}
	});

	const onKey = (e) => {
		if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const delta = e.key === 'ArrowDown' ? 1 : -1;
			selected = Math.min(Math.max(selected + delta, 0), snapshots.length - 1);
			renderVersions();
			showSelected();
		}
	};

	hintEl.textContent = 'The text a restore replaces is snapshotted first.';
	window.addEventListener('keydown', onKey, true);
	overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
	document.body.append(overlay);
	renderVersions();
	showSelected();
}
