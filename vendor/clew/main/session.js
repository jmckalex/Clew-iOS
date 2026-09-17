// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Vault sessions: one window = one vault = one set of services. Each
// session owns its own VaultManager, Indexer, RenderService, KvStore, and
// SearchService, wired together exactly as the old singletons were, and
// sends events only to its own window. A registry maps webContents ids to
// sessions (for IPC routing) and short session ids to sessions (for
// clew-preview:// URLs, which must carry the vault identity because
// protocol handlers cannot see which window issued a request).
import { VaultManager } from './vault.js';
import { Indexer } from './indexer.js';
import { RenderService } from './render-service.js';
import { KvStore, KV_FILE } from './kv-store.js';
import { SearchService } from './search.js';

const byWebContents = new Map(); // webContents.id -> session
const byId = new Map(); // session id -> session
let counter = 0;

export class VaultSession {
	/** @type {import('electron').BrowserWindow} */
	win = null;

	constructor(win, distDir) {
		this.id = `s${++counter}`;
		this.win = win;
		// Captured now: webContents is unreachable once the window is destroyed,
		// and dispose() runs from the 'closed' event.
		this.wcId = win.webContents.id;
		this.vaults = new VaultManager();
		this.vaults.sessionId = this.id;
		this.indexer = new Indexer();
		this.renderService = new RenderService(distDir);
		// Engine-emitted media URLs must carry the session id (preview URLs
		// are clew-preview://vault/<sid>/<path>; root-relative would lose it).
		this.renderService.sessionId = this.id;
		this.kvStore = new KvStore();
		this.searchService = new SearchService({ vaults: this.vaults, indexer: this.indexer });

		this.send = (channel, payload) => {
			if (!this.win?.isDestroyed()) this.win?.webContents.send(channel, payload);
		};
		this.vaults.send = this.send;
		this.indexer.send = this.send;
		this.renderService.send = this.send;
		// A note embedding another goes stale when that other one changes, and
		// only the index knows which notes those are.
		this.renderService.embeddersOf = (relPath) => this.indexer.embeddersOf(relPath);
		this.kvStore.send = this.send;

		this.vaults.hooks = {
			onOpen: (root) => {
				this.renderService.openVault(root);
				this.indexer.openVault(root);
				this.kvStore.open(root);
			},
			onClose: () => {
				this.renderService.closeVault();
				this.indexer.closeVault();
				this.kvStore.close();
			},
			onFileChanged: (rel) => {
				this.renderService.onFileChanged(rel);
				this.indexer.onFileChanged(rel);
				if (rel === KV_FILE) this.kvStore.externalChange();
			},
			onStructureChanged: () => this.indexer.onStructureChanged(),
		};

		byWebContents.set(this.wcId, this);
		byId.set(this.id, this);
	}

	dispose() {
		this.vaults.close();
		byWebContents.delete(this.wcId);
		byId.delete(this.id);
		this.win = null;
	}
}

/** The session that owns this IPC sender (a window's main frame). */
export function sessionFor(webContents) {
	return byWebContents.get(webContents.id) ?? null;
}

/** Session lookup for clew-preview:// URLs. */
export function sessionById(id) {
	return byId.get(id) ?? null;
}

export function allSessions() {
	return [...byId.values()];
}

/** The session whose window has focus (or the most recent live one). */
export function focusedSession() {
	const live = [...byId.values()].filter((s) => s.win && !s.win.isDestroyed());
	return live.find((s) => s.win.isFocused()) ?? live.at(-1) ?? null;
}

/** The session that already has this vault open, if any. */
export function sessionForVault(vaultPath) {
	for (const session of byId.values()) {
		if (session.vaults.root === vaultPath) return session;
	}
	return null;
}
