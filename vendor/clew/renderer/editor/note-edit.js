// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Changing a note from OUTSIDE the editor the user types in — an app's write
// (app-host.js, frame-bridge.md §10) or the Book panel's (book-mode.md §2) —
// through the editor pool, so undo, the dirty dot, auto-save, the conflict
// hold and history treat it as the user's own edit. Moved here from
// app-host.js unchanged when the Book panel became its second caller.
import { editorPool, HEADLESS_PREFIX } from './pool.js';
import { workspaceStore } from '../state/workspace-store.js';
import { minimalChange } from './minimal-change.js';

const fail = (code, message) => ({ ok: false, error: { code, message } });
let headless = 0;

/** Apply `edit(text) → text` to a note: as a transaction on the editor the
 *  user has it open in, or through a headless pool entry that saves at once.
 *  A note whose editor has an unresolved conflict answers `conflict`. */
export async function editNote(path, edit, { userEvent = 'input.app' } = {}) {
	const editing = editorFor(path);
	if (editing) {
		const entry = editing;
		if (entry.conflict) return fail('conflict', `${path} changed on disk while it had unsaved edits; the user must resolve it first`);
		const before = entry.view.state.doc.toString();
		const change = minimalChange(before, edit(before));
		if (change) entry.view.dispatch({ changes: change, userEvent });
		return { ok: true, result: true };
	}
	const tabId = `${HEADLESS_PREFIX}${++headless}`;
	try {
		const entry = await editorPool.open(tabId, path);
		if (entry.conflict) return fail('conflict', `${path} cannot be written now`);
		const before = entry.view.state.doc.toString();
		const change = minimalChange(before, edit(before));
		if (change) {
			entry.view.dispatch({ changes: change, userEvent });
			await editorPool.saveNow(tabId);
		}
		return { ok: true, result: true };
	} finally {
		editorPool.close(tabId);
	}
}

/**
 * The editor the user is EDITING a note in, or null. A note can have
 * several pool entries — a split, a reading-mode tab whose editor stays
 * pooled — each its own state, kept in step through the disk: an outside
 * edit goes to ONE, the one in an editing mode (the active tab first), and
 * reaches the rest the way the user's own edits do. Only reading-mode
 * entries means "not open in an editor": the write goes headless.
 */
export function editorFor(path) {
	const editing = editorPool.tabsFor(path).filter((id) => {
		const mode = workspaceStore.findTab(id)?.tab?.view?.mode;
		return mode === 'source' || mode === 'live';
	});
	const active = workspaceStore.activeTab()?.id;
	const id = editing.includes(active) ? active : editing[0];
	return id ? editorPool.get(id) : null;
}
