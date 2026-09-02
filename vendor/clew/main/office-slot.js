// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The app-global office slot: at most ONE LibreOffice-in-wasm instance per
// app, not per window (each costs ~1.6 GB — the spike's measurement). The
// renderer's office dock acquires before booting an instance and releases
// when it destroys one; a webContents that reloads or dies releases
// implicitly, so a crashed window can never wedge the slot shut.
import { BrowserWindow } from 'electron';
import { CH } from '../shared/channels.js';

let holder = null; // { wc, tabId, path } | null

function broadcast() {
	const state = status();
	for (const win of BrowserWindow.getAllWindows()) {
		// The release that triggers this often IS a window mid-teardown
		// (the wc 'destroyed' hook) — sending there throws, and a throw
		// inside that event wedges the main process behind an error dialog.
		if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
		try { win.webContents.send(CH.EV_OFFICE_SLOT, state); } catch { /* closing */ }
	}
}

/** What the renderers may know: is the slot held, and for which document. */
export function status() {
	return holder
		? { held: true, path: holder.path, wcId: holder.wc.id }
		: { held: false };
}

export function acquire(wc, { tabId, path }) {
	if (holder && holder.wc !== wc) {
		return { ok: false, where: 'other-window', path: holder.path };
	}
	// Same window re-acquiring (same tab repositioned, or the dock moving to
	// a new document after destroying the old frame) just updates the claim.
	if (!holder) {
		const free = () => release(wc);
		holder = { wc, tabId, path };
		// A closed window must free the slot, and so must a renderer reload
		// (dev hot-reload navigates the main frame without destroying it).
		wc.once('destroyed', free);
		wc.on('did-navigate', free);
		holder.unhook = () => {
			wc.removeListener('destroyed', free);
			wc.removeListener('did-navigate', free);
		};
	} else {
		holder.tabId = tabId;
		holder.path = path;
	}
	broadcast();
	return { ok: true };
}

export function release(wc) {
	if (holder?.wc !== wc) return;
	holder.unhook?.();
	holder = null;
	broadcast();
}
