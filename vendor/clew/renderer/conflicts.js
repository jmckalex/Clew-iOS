// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Edit-conflict safety, the renderer's half (FEATURE-IDEAS #1; Clew-iOS
// CONFLICT-SAFETY.md items 2–4): the same note changed in two places must
// never lose a version silently. However the second version shows itself —
//
// - a save main REFUSED, because the disk holds a version it had not seen
//   (main/write-guard.js; the pool holds the note, kind 'save');
// - a change arriving under unsaved edits (the pool's old banner, kind 'disk');
// - Dropbox's "Note (Name's conflicted copy YYYY-MM-DD).md" beside a note;
// - git's <<<<<<< ======= >>>>>>> in a note's own text —
//
// both versions are in the note's history BEFORE anything is offered
// (history.js#keepVersion), and then the user chooses: keep mine, keep
// theirs, keep both ("Note (conflict YYYY-MM-DD).md" beside it), with a
// line diff to compare. git markers get a notice only: they ARE the note's
// text, and choosing between them is editing it. The text helpers are
// shared/conflict-text.js, Clew-iOS's, so the two cannot drift.
import { ipc, CH } from './ipc.js';
import { editorPool } from './editor/pool.js';
import { vaultStore } from './state/vault-store.js';
import { notice } from './plugins.js';
import { conflictSiblingPath, findDropboxCopies, hasGitConflictMarkers, lineDiff } from '../shared/conflict-text.js';

const nameOf = (rel) => rel.split('/').pop().replace(/\.(md|jmd)$/i, '');

/** Every file path in the vault, from the explorer's tree. */
function vaultPaths() {
	const out = [];
	const walk = (entries) => {
		for (const e of entries ?? []) {
			if (e.type === 'folder') walk(e.children);
			else out.push(e.path);
		}
	};
	walk(vaultStore.tree);
	return out;
}

/** "Note (conflict YYYY-MM-DD).md" beside `rel`, never an existing name. */
export function conflictSibling(rel) {
	const taken = new Set(vaultPaths());
	return conflictSiblingPath(rel, (p) => taken.has(p));
}

// ---- the compare view -----------------------------------------------------------

/** The diff as rows, an unchanged run of more than 6 lines folded to its
 *  ends. '-' only on disk (theirs), '+' only in the editor (mine). */
function diffRows(theirs, mine) {
	const ops = lineDiff(theirs, mine);
	const box = document.createElement('div');
	box.className = 'clew-conflict-diff';
	if (!ops) {
		box.textContent = 'Too large to compare line by line — keep both to read them side by side.';
		return box;
	}
	const row = (op, text) => {
		const el = document.createElement('div');
		el.className = `clew-diff-line ${op === '-' ? 'is-theirs' : op === '+' ? 'is-mine' : 'is-same'}`;
		el.textContent = `${op} ${text}`;
		return el;
	};
	for (let i = 0; i < ops.length;) {
		if (ops[i].op !== ' ') { box.append(row(ops[i].op, ops[i].text)); i++; continue; }
		let j = i;
		while (j < ops.length && ops[j].op === ' ') j++;
		const run = ops.slice(i, j);
		if (run.length > 6) {
			for (const { text } of run.slice(0, 2)) box.append(row(' ', text));
			const fold = document.createElement('div');
			fold.className = 'clew-diff-fold';
			fold.textContent = `… ${run.length - 4} unchanged lines`;
			box.append(fold);
			for (const { text } of run.slice(-2)) box.append(row(' ', text));
		} else for (const { text } of run) box.append(row(' ', text));
		i = j;
	}
	return box;
}

/**
 * The choice, as a modal: an explanation, the choices, and Compare.
 * @param {{ title: string, explain: string, mine: string, theirs: string,
 *   choices: { id: string, label: string, primary?: boolean }[],
 *   compare?: boolean }} spec
 * @returns {Promise<string|null>} the chosen id, or null (Later / Esc)
 */
export function openConflictSheet({ title, explain, mine, theirs, choices, compare = false, textual = true }) {
	document.querySelector('.clew-conflict-sheet')?.remove();
	return new Promise((resolve) => {
		const sheet = document.createElement('div');
		sheet.className = 'clew-conflict-sheet';
		const card = document.createElement('div');
		card.className = 'clew-conflict-card';
		card.setAttribute('role', 'dialog');
		card.setAttribute('aria-label', title);
		const h = document.createElement('h2');
		h.textContent = title;
		const p = document.createElement('p');
		p.textContent = explain;
		const legend = document.createElement('p');
		legend.className = 'clew-conflict-legend';
		legend.textContent = '− only on disk (theirs)   + only in the editor (mine)';
		// `textual: false` (a PDF): no line diff — the choices say it all.
		const diff = textual ? diffRows(theirs, mine) : document.createElement('div');
		legend.hidden = diff.hidden = !compare || !textual;
		const buttons = document.createElement('div');
		buttons.className = 'clew-conflict-buttons';
		const done = (id) => {
			sheet.remove();
			window.removeEventListener('keydown', onKey, true);
			resolve(id);
		};
		const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
		window.addEventListener('keydown', onKey, true);
		for (const choice of choices) {
			const b = document.createElement('button');
			b.textContent = choice.label;
			b.dataset.choice = choice.id;
			if (choice.primary) b.className = 'is-primary';
			b.addEventListener('click', () => done(choice.id));
			buttons.append(b);
		}
		const toggle = document.createElement('button');
		toggle.textContent = compare ? 'Hide comparison' : 'Compare…';
		toggle.dataset.choice = 'compare';
		toggle.addEventListener('click', () => {
			legend.hidden = diff.hidden = !diff.hidden;
			toggle.textContent = diff.hidden ? 'Compare…' : 'Hide comparison';
		});
		const later = document.createElement('button');
		later.textContent = 'Later';
		later.dataset.choice = 'later';
		later.addEventListener('click', () => done(null));
		if (textual) buttons.append(toggle);
		buttons.append(later);
		card.append(h, p, legend, diff, buttons);
		sheet.append(card);
		document.body.append(sheet);
	});
}

// ---- an editor's conflict (the pool holds it) -------------------------------------

const EXPLAIN = {
	save: 'Since Clew last read this note, another app or device saved a different version. Your save was held, so nothing was overwritten. Both versions are in the note\'s history.',
	disk: 'This note changed on disk while it had unsaved edits here. Auto-save is paused. Both versions are in the note\'s history.',
};

/** Resolve the editor `tabId`'s conflict: 'mine' | 'theirs' | 'both'. */
export async function resolveEditorConflict(tabId, choice) {
	const entry = editorPool.get(tabId);
	if (!entry?.conflict) return;
	const sibling = choice === 'both' ? conflictSibling(entry.path) : null;
	try {
		const result = await editorPool.resolveConflict(tabId, choice, { sibling });
		if (result?.sibling) notice(`Kept both — the other version is "${nameOf(result.sibling)}".`, 5000);
	} catch (err) {
		notice(`Could not resolve the conflict: ${err.message ?? err}`, 6000);
	}
}

/** The sheet for an editor's conflict (the banner's Compare…). */
export async function reviewEditorConflict(tabId, { compare = true } = {}) {
	const entry = editorPool.get(tabId);
	if (!entry?.conflict) return;
	const choice = await openConflictSheet({
		title: `“${nameOf(entry.path)}” changed in two places`,
		explain: EXPLAIN[entry.conflictKind ?? 'disk'],
		mine: entry.view.state.doc.toString(),
		theirs: entry.conflict,
		compare,
		choices: [
			{ id: 'mine', label: 'Keep mine', primary: true },
			{ id: 'theirs', label: 'Keep theirs' },
			{ id: 'both', label: 'Keep both' },
		],
	});
	if (choice) await resolveEditorConflict(tabId, choice);
}

export const conflictExplanation = (kind) => EXPLAIN[kind ?? 'disk'];

// ---- Dropbox's conflicted copies and git's markers ---------------------------------

/** Copies and marked notes already announced this session (until gone). */
const announced = new Set();

export function persistentNotice(text, actions, key) {
	let host = document.querySelector('.clew-notices');
	if (!host) {
		host = document.createElement('div');
		host.className = 'clew-notices';
		document.body.append(host);
	}
	const note = document.createElement('div');
	note.className = 'clew-notice clew-trust-banner clew-conflict-notice';
	note.setAttribute('role', 'status');
	note.dataset.conflictKey = key;
	const span = document.createElement('span');
	span.textContent = text;
	note.append(span);
	for (const { label, run } of actions) {
		const b = document.createElement('button');
		b.className = 'clew-trust-button';
		b.textContent = label;
		b.addEventListener('click', () => { note.remove(); run(); });
		note.append(b);
	}
	const close = document.createElement('button');
	close.className = 'clew-trust-dismiss';
	close.textContent = '×';
	close.setAttribute('aria-label', 'Dismiss');
	close.addEventListener('click', () => note.remove());
	note.append(close);
	host.prepend(note);
	return note;
}

/** A Dropbox copy beside its note: keep the note, the copy, or both files. */
export async function reviewDropboxCopy({ base, copy, who }) {
	const read = (rel) => ipc.invoke(CH.NOTE_READ, { path: rel });
	let mine;
	let theirs;
	try { [mine, theirs] = await Promise.all([read(base), read(copy)]); } catch (err) {
		notice(`Could not read the conflicted copy: ${err.message ?? err}`, 6000);
		return;
	}
	await ipc.invoke(CH.HISTORY_KEEP, { path: base, text: theirs }).catch(() => {});
	await ipc.invoke(CH.HISTORY_KEEP, { path: base, text: mine }).catch(() => {});
	const choice = await openConflictSheet({
		title: `Dropbox kept two versions of “${nameOf(base)}”`,
		explain: `Dropbox saved ${who ? `${who}'s` : 'another'} version beside the note as “${copy.split('/').pop()}”. Both are in the note's history. "Keep the note" moves the copy to the Trash; "Keep the copy" puts its text in the note and moves the copy to the Trash; "Keep both" leaves both files.`,
		mine,
		theirs,
		choices: [
			{ id: 'mine', label: 'Keep the note', primary: true },
			{ id: 'theirs', label: 'Keep the copy' },
			{ id: 'both', label: 'Keep both' },
		],
	});
	if (!choice || choice === 'both') return;
	try {
		if (choice === 'theirs') {
			const tabId = editorPool.tabsFor(base)[0];
			const entry = tabId ? editorPool.get(tabId) : null;
			if (entry?.conflict) throw new Error('the note has another conflict open — resolve it first');
			await ipc.invoke(CH.NOTE_WRITE, { path: base, content: theirs, force: true });
		}
		await ipc.invoke(CH.FS_TRASH, { path: copy });
		announced.delete(`dropbox:${copy}`);
		notice(choice === 'theirs' ? `“${nameOf(base)}” now holds the copy's text; the copy is in the Trash.` : 'The copy is in the Trash.', 5000);
	} catch (err) {
		notice(`Could not resolve the copy: ${err.message ?? err}`, 6000);
	}
}

/** Look for Dropbox copies in the vault's tree; announce each new one once. */
export function scanDropboxCopies() {
	const copies = findDropboxCopies(vaultPaths());
	const live = new Set(copies.map((c) => `dropbox:${c.copy}`));
	for (const key of [...announced]) if (key.startsWith('dropbox:') && !live.has(key)) announced.delete(key);
	for (const c of copies) {
		const key = `dropbox:${c.copy}`;
		// Once: the tree arrives more than once as a vault opens.
		const shown = [...document.querySelectorAll('.clew-conflict-notice')].some((n) => n.dataset.conflictKey === key);
		if (announced.has(key) || shown) { announced.add(key); continue; }
		announced.add(key);
		persistentNotice(`Dropbox kept a conflicted copy of “${nameOf(c.base)}”.`, [{ label: 'Review…', run: () => reviewDropboxCopy(c) }], key);
	}
	return copies;
}

/** git's markers in a note's text: a notice, once, until they are gone. */
export function checkGitMarkers(path, text) {
	const key = `git:${path}`;
	if (!/\.(md|jmd)$/i.test(path) || !String(text ?? '').includes('<<<<<<<') || !hasGitConflictMarkers(text)) {
		announced.delete(key);
		return false;
	}
	if (announced.has(key)) return true;
	announced.add(key);
	notice(`“${nameOf(path)}” holds git conflict markers (<<<<<<< ======= >>>>>>>): two versions are in its text — keep what you want and delete the markers.`, 9000);
	return true;
}

export function installConflictScans() {
	vaultStore.on('tree-changed', () => scanDropboxCopies());
	// A note's text as it opens or reloads from disk.
	editorPool.on('state-replaced', ({ tabId }) => {
		const entry = editorPool.get(tabId);
		if (entry?.view && entry.path) checkGitMarkers(entry.path, entry.view.state.doc.toString());
	});
	editorPool.on('reloaded', ({ path, text }) => checkGitMarkers(path, text));
	// A held save shows a banner in its editor — which may not be the one
	// in front of the user: say so.
	editorPool.on('conflict-changed', ({ tabId, active, kind }) => {
		if (!active || kind !== 'save') return;
		const path = editorPool.get(tabId)?.path;
		if (path) notice(`“${nameOf(path)}” was changed elsewhere — your save was held and nothing was overwritten. Choose in the banner above it.`, 8000);
	});
	// Another vault: what was announced was the last one's.
	ipc.on(CH.EV_VAULT_OPENED, () => {
		announced.clear();
		for (const n of document.querySelectorAll('.clew-conflict-notice')) n.remove();
		scanDropboxCopies();
	});
}
