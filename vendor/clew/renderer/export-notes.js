// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// "Export notes as PDF (reading view)" — the window's half: the sheet (the
// owner's ask, 2026-11-24: a folder of marked essays, a PDF each). The notes
// are ticked in a list — a folder's (its explorer menu) all ticked, the whole
// vault's (File → Export) none, with a filter to find them — then main asks
// for the folder, prints each (export.js#exportNotesPrint, the single note's
// printer) and the sheet follows it, with Stop, to what was written, what
// failed and Show in Finder. What is unsaved is saved first: the print is the
// note as saved.
import { ipc, CH } from './ipc.js';
import { editorPool } from './editor/pool.js';
import { vaultStore } from './state/vault-store.js';
import { notice } from './plugins.js';

const h = (tag, cls, text) => {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text != null) e.textContent = text;
	return e;
};
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const errorText = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const isFolderOf = (folder) => (p) => !folder || p.startsWith(`${folder}/`);

let running = false;

/** The modal frame: a title, a scrolling body, buttons. */
function openSheet(title) {
	const sheet = h('div', 'clew-sheet clew-print-sheet');
	const card = h('div', 'clew-sheet-card');
	card.setAttribute('role', 'dialog');
	card.setAttribute('aria-label', title);
	card.tabIndex = -1;
	const head = h('div', 'clew-sheet-head');
	const body = h('div', 'clew-sheet-body');
	const buttons = h('div', 'clew-sheet-buttons');
	head.append(h('h2', null, title));
	card.append(head, body, buttons);
	sheet.append(card);
	document.body.append(sheet);
	card.focus();
	let escape = null;
	const onKey = (e) => { if (e.key === 'Escape' && escape) { e.stopPropagation(); e.preventDefault(); escape(); } };
	window.addEventListener('keydown', onKey, true);
	return {
		state(s) { sheet.dataset.state = s; },
		body(...nodes) { body.replaceChildren(...nodes); },
		/** Buttons; resolves with the id pressed. Esc is `cancel`/`done`, if one is offered. */
		choose(choices) {
			return new Promise((resolve) => {
				buttons.replaceChildren();
				for (const c of choices) {
					const b = h('button', c.primary ? 'is-primary' : null, c.label);
					b.dataset.printAction = c.id;
					c.bind?.(b);
					b.addEventListener('click', () => { if (!b.disabled) { escape = null; resolve(c.id); } });
					buttons.append(b);
				}
				const cancel = choices.find((c) => c.id === 'cancel' || c.id === 'done');
				escape = cancel ? () => { escape = null; resolve(cancel.id); } : null;
			});
		},
		buttons(...nodes) { escape = null; buttons.replaceChildren(...nodes); },
		close() {
			window.removeEventListener('keydown', onKey, true);
			sheet.remove();
		},
	};
}

/**
 * The list to tick. Resolves with the paths ticked, or null.
 * @param {ReturnType<typeof openSheet>} sheet
 * @param {string[]} notes - the notes offered, vault-relative
 * @param {Set<string>} ticked - kept across a cancelled folder choice
 * @param {string|null} folder - the folder the notes are in, shown from it
 */
async function pick(sheet, notes, ticked, folder) {
	sheet.state('pick');
	const filter = h('input', 'clew-print-filter');
	filter.type = 'search';
	filter.placeholder = 'Filter by name or folder';
	filter.setAttribute('aria-label', 'Filter the notes');
	const count = h('span', 'clew-print-count');
	const all = h('button', 'clew-print-tick', 'Tick all shown');
	const none = h('button', 'clew-print-tick', 'Untick all shown');
	all.dataset.printAction = 'all';
	none.dataset.printAction = 'none';
	const tools = h('div', 'clew-print-tools');
	tools.append(filter, all, none, count);

	const list = h('div', 'clew-print-list');
	const rows = notes.map((path) => {
		const row = h('label', 'clew-print-row');
		const box = h('input');
		box.type = 'checkbox';
		box.checked = ticked.has(path);
		box.dataset.path = path;
		box.addEventListener('change', () => {
			if (box.checked) ticked.add(path); else ticked.delete(path);
			update();
		});
		row.append(box, h('span', 'clew-print-path', folder ? path.slice(folder.length + 1) : path));
		list.append(row);
		return { row, box, path, key: path.toLowerCase() };
	});
	const shown = () => rows.filter((r) => !r.row.hidden);

	let exportButton = null;
	const update = () => {
		const n = ticked.size;
		count.textContent = `${n.toLocaleString()} of ${plural(notes.length, 'note')} ticked`;
		if (exportButton) {
			exportButton.disabled = n === 0;
			exportButton.textContent = n ? `Export ${plural(n, 'PDF')}…` : 'Export PDFs…';
		}
	};
	filter.addEventListener('input', () => {
		const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
		for (const r of rows) r.row.hidden = !words.every((w) => r.key.includes(w));
	});
	// Enter in the filter is not Export: the question keeps the keyboard.
	filter.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
	const tickShown = (on) => {
		for (const r of shown()) {
			r.box.checked = on;
			if (on) ticked.add(r.path); else ticked.delete(r.path);
		}
		update();
	};
	all.addEventListener('click', () => tickShown(true));
	none.addEventListener('click', () => tickShown(false));

	sheet.body(
		h('p', 'clew-sheet-explain', 'Each note is printed as reading view draws it, to a PDF of its own named after the note, in a folder you choose next. What a note marks @begin(clew-only) is left out.'),
		tools, list,
	);
	const choice = sheet.choose([
		{ id: 'cancel', label: 'Cancel' },
		{ id: 'export', label: 'Export PDFs…', primary: true, bind: (b) => { exportButton = b; } },
	]);
	update();
	filter.focus();
	// The list's own order (the vault's), whatever order they were ticked in.
	return (await choice) === 'export' ? notes.filter((p) => ticked.has(p)) : null;
}

/** Main prints; the sheet follows it, with Stop. */
async function print(sheet, paths) {
	sheet.state('printing');
	const line = h('p', null, 'Choose the folder for the PDFs…');
	const bar = h('div', 'clew-sheet-progress is-indeterminate');
	const fill = h('div', 'clew-sheet-progress-fill');
	bar.append(fill);
	sheet.body(line, bar);
	const stop = h('button', null, 'Stop');
	stop.dataset.printAction = 'stop';
	stop.addEventListener('click', () => {
		stop.disabled = true;
		stop.textContent = 'Stopping…';
		ipc.invoke(CH.EXPORT_NOTES_STOP).catch(() => {});
	});
	sheet.buttons(stop);
	const off = ipc.on(CH.EV_EXPORT_NOTES_PROGRESS, ({ done, total, path }) => {
		bar.classList.remove('is-indeterminate');
		fill.style.width = `${Math.round((total ? done / total : 0) * 100)}%`;
		line.textContent = path ? `Printing ${(done + 1).toLocaleString()} of ${total.toLocaleString()} — ${path}` : 'Finishing…';
	});
	try {
		return await ipc.invoke(CH.EXPORT_NOTES_PRINT, { paths });
	} finally {
		off();
	}
}

/** What came of it. */
async function report(sheet, result) {
	sheet.state('done');
	const { outDir, written, failed, stopped, replaced } = result;
	const nodes = [];
	const of = failed.length || stopped.length ? ` of ${(written.length + failed.length + stopped.length).toLocaleString()}` : '';
	nodes.push(h('p', 'clew-sheet-summary', written.length
		? `Exported ${written.length.toLocaleString()}${of} ${written.length === 1 && !of ? 'PDF' : 'PDFs'} to ${outDir}.`
		: `No PDF was exported to ${outDir}.`));
	if (replaced) nodes.push(h('p', 'clew-sheet-explain', `${plural(replaced, 'older PDF')} of the same name went to the Trash.`));
	if (stopped.length) nodes.push(h('p', null, `Stopped: ${plural(stopped.length, 'note')} not exported.`));
	if (failed.length) {
		nodes.push(h('p', null, `${failed.length === 1 ? 'One note' : `${failed.length.toLocaleString()} notes`} could not be printed:`));
		const list = h('ul', 'clew-print-failed');
		for (const f of failed) {
			const item = h('li');
			item.append(h('span', 'clew-print-path', f.path), h('span', 'clew-sheet-explain', ` — ${f.error}`));
			list.append(item);
		}
		nodes.push(list);
	}
	sheet.body(...nodes);
	for (;;) {
		const choice = await sheet.choose([
			...(written.length ? [{ id: 'reveal', label: navigator.platform.startsWith('Mac') ? 'Show in Finder' : 'Show in Folder' }] : []),
			{ id: 'done', label: 'Done', primary: true },
		]);
		if (choice !== 'reveal') return;
		await ipc.invoke(CH.EXPORT_NOTES_REVEAL).catch(() => {});
	}
}

/**
 * The sheet. `folder`: the notes in it and its subfolders, all ticked;
 * otherwise every note in the vault, none ticked.
 */
export async function exportNotesAsPdf({ folder = null } = {}) {
	if (running || !vaultStore.vault) return;
	const notes = vaultStore.notePaths().filter(isFolderOf(folder));
	if (!notes.length) {
		notice(folder ? `No notes in ${folder} to export.` : 'No notes in this vault to export.');
		return;
	}
	running = true;
	const sheet = openSheet(folder ? `Export notes in "${folder}" as PDF (reading view)` : 'Export notes as PDF (reading view)');
	const ticked = new Set(folder ? notes : []);
	try {
		for (;;) {
			const paths = await pick(sheet, notes, ticked, folder);
			if (!paths) return;
			await editorPool.saveAll();
			let result;
			try {
				result = await print(sheet, paths);
			} catch (err) {
				console.error('Export notes as PDF failed:', err);
				sheet.state('failed');
				sheet.body(h('p', null, `Exporting the notes failed: ${errorText(err)}`));
				await sheet.choose([{ id: 'done', label: 'Done', primary: true }]);
				return;
			}
			// The folder dialog (or the question about PDFs already there)
			// cancelled: back to the list, the ticks as they were.
			if (result?.canceled) continue;
			await report(sheet, result);
			return;
		}
	} finally {
		sheet.close();
		running = false;
	}
}
