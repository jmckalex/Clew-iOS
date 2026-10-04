// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// PDF save safety, the app page's half (the owner's ask, 2026-10-03). A
// viewer's save over a version of the PDF it did not load is refused by the
// host (main/pdf-guard.js — natively on iOS), which keeps BOTH versions in
// the PDF's history first; the viewer (preview-client/pdf-core.js) pauses
// and says `pdf-conflict`. This asks the user, with the notes' sheet
// (renderer/conflicts.js), what to keep:
//
//   Keep mine    — this viewer's version saved over the other;
//   Keep theirs  — the viewer reloads the version on disk (mine stays in
//                  the PDF's history);
//   Keep both    — mine saved beside it as "x (conflict YYYY-MM-DD).pdf",
//                  the viewer reloads theirs, and the two open SIDE BY SIDE:
//                  a PDF has no line diff, so comparing is looking at both.
//   Later        — a persistent notice keeps the way back; nothing saves.
//
// The viewer carries the choice out (`pdf-resolve` → `pdf-resolved`): it
// holds mine, edits since the refusal included. If it has gone (its tab
// closed), the versions kept in history do it instead
// (CH.PDF_VERSION_RESTORE). Platform-neutral but for those two invokes —
// the half a port (Clew-iOS) takes as it is.
import { fromPreviewOrigin, postTo } from '../shared/message-guard.js';
import { openConflictSheet, conflictSibling, persistentNotice } from './conflicts.js';
import { workspaceStore } from './state/workspace-store.js';
import { createTab } from './workspace/tree.js';
import { ipc, CH } from './ipc.js';
import { notice } from './plugins.js';
import { noticeLift } from './lib/notice-lift.js';

const RESOLVE_TIMEOUT_MS = 8000;
/** path → { source, origin, mine, theirs } — the viewer that was refused. */
const open = new Map();
let seq = 0;

const nameOf = (path) => path.split('/').pop();

/** Ask the refused viewer to carry `choice` out; true when it did. */
function askViewer(c, path, choice, copyPath) {
	if (!c.source || c.source.closed) return Promise.resolve(false);
	const requestId = ++seq;
	return new Promise((resolve) => {
		const timer = setTimeout(() => { window.removeEventListener('message', on); resolve(false); }, RESOLVE_TIMEOUT_MS);
		const on = (event) => {
			const msg = event.data;
			if (event.source !== c.source || msg?.source !== 'clew-pdf' || msg.type !== 'pdf-resolved' || msg.requestId !== requestId) return;
			clearTimeout(timer);
			window.removeEventListener('message', on);
			resolve(Boolean(msg.ok));
		};
		window.addEventListener('message', on);
		postTo(c.source, { source: 'clew-pdf-host', type: 'pdf-resolve', requestId, path, choice, copyPath }, c.origin);
	});
}

/** The viewer is gone: the versions kept in the PDF's history do it. */
async function fromHistory(c, path, choice, copyPath) {
	if (choice === 'theirs') return;   // theirs is what the disk holds
	if (!c.mine) throw new Error('your version was not kept');
	if (choice === 'mine') await ipc.invoke(CH.PDF_VERSION_RESTORE, { path, name: c.mine });
	else await ipc.invoke(CH.PDF_VERSION_RESTORE, { path, name: c.mine, to: copyPath, create: true });
}

/** The two PDFs side by side: the copy in a pane beside the original's —
 *  a new one, split off it, when the window has only one. */
function sideBySide(path, copyPath) {
	const found = workspaceStore.allGroups()
		.flatMap((g) => g.tabs.map((t) => ({ g, t })))
		.find(({ t }) => t.kind === 'file' && t.path === path);
	if (found) {
		workspaceStore.setActiveGroup(found.g.id);
		workspaceStore.activateTab(found.t.id);
	}
	if (workspaceStore.allGroups().length < 2) {
		workspaceStore.splitGroup(found?.g.id ?? workspaceStore.activeGroupId, 'right', createTab('file', copyPath));
	} else {
		workspaceStore.openFileBeside(copyPath);
	}
}

/** The sheet for `path`'s conflict, and what it decides. */
export async function resolvePdfConflict(path) {
	const c = open.get(path);
	if (!c) return;
	const name = nameOf(path);
	const choice = await openConflictSheet({
		title: `${name} changed elsewhere`,
		explain: `Since this PDF was opened here, another device, app or viewer saved a different version of it. Your annotations were held, so nothing was overwritten, and both versions are in the PDF's history (.clew/history/${path}/).`,
		textual: false,
		choices: [
			{ id: 'mine', label: 'Keep mine' },
			{ id: 'theirs', label: 'Keep theirs' },
			{ id: 'both', label: 'Keep both, side by side', primary: true },
		],
	});
	if (!choice) {
		persistentNotice(`${name}: your annotations are not saved — the PDF changed elsewhere.`,
			[{ label: 'Resolve…', run: () => resolvePdfConflict(path) }], `pdf:${path}`);
		return;
	}
	const copyPath = choice === 'both' ? conflictSibling(path) : null;
	try {
		if (!(await askViewer(c, path, choice, copyPath))) await fromHistory(c, path, choice, copyPath);
	} catch (err) {
		notice(`Could not resolve ${name}: ${err?.message ?? err}. Both versions are in its history.`, 8000);
		return;
	}
	open.delete(path);
	document.querySelector(`.clew-conflict-notice[data-conflict-key="${CSS.escape(`pdf:${path}`)}"]`)?.remove();
	if (choice === 'both') {
		sideBySide(path, copyPath);
		notice(`Kept both: yours is ${nameOf(copyPath)}, beside ${name}.`, 6000);
	} else {
		notice(choice === 'mine' ? `${name}: your version saved.` : `${name}: the other version kept; yours is in its history.`, 5000);
	}
}

/** True while `path` has a conflict waiting (scenarios; the command). */
export const pdfConflictOpen = (path) => open.has(path);

// The window's notices never cover a PDF viewer's status chip — not least
// this file's own "not saved" notice over the chip saying the same
// (lib/notice-lift.js). The column is placed again whenever a notice comes
// or goes, the window resizes, or the layout or the active tab changes; the
// viewers are the app page's own frames (tabs, canvas cards — a viewer
// inside a note's document draws its chip in the embed's title bar instead).
function keepViewerStatusClear() {
	let pending = 0;
	const place = () => {
		pending = 0;
		const host = document.querySelector('.clew-notices');
		if (!host) return;
		host.style.bottom = '';
		if (!host.children.length) return;
		const viewers = [...document.querySelectorAll('iframe[src*="/clewpdf/pdf-page.html"]')]
			.filter((f) => f.offsetParent && !f.closest('[data-clew-retiring]'))
			.map((f) => f.getBoundingClientRect());
		if (!viewers.length) return;
		const resting = parseFloat(getComputedStyle(host).bottom) || 0;
		const bottom = noticeLift(host.getBoundingClientRect(), viewers, window.innerHeight, resting);
		if (bottom !== resting) host.style.bottom = `${bottom}px`;
	};
	const schedule = () => { pending ||= requestAnimationFrame(place); };
	const watched = new WeakSet();
	new MutationObserver(() => {
		const host = document.querySelector('.clew-notices');
		if (host && !watched.has(host)) {
			watched.add(host);
			new MutationObserver(schedule).observe(host, { childList: true });
			schedule();
		}
	}).observe(document.body, { childList: true });
	window.addEventListener('resize', schedule);
	workspaceStore.on('layout-changed', schedule);
	workspaceStore.on('active-changed', schedule);
}

export function installPdfConflicts() {
	keepViewerStatusClear();
	window.addEventListener('message', (event) => {
		if (!fromPreviewOrigin(event)) return;
		const msg = event.data;
		if (msg?.source !== 'clew-pdf' || msg.type !== 'pdf-conflict' || typeof msg.path !== 'string') return;
		const first = !open.has(msg.path);
		open.set(msg.path, { source: event.source, origin: event.origin, mine: msg.mine ?? null, theirs: msg.theirs ?? null });
		if (first) resolvePdfConflict(msg.path);
	});
}
