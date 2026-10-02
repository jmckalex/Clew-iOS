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
import crypto from 'node:crypto';
import { newCallerToken } from './caller-token.js';
import { VaultManager } from './vault.js';
import { Indexer } from './indexer.js';
import { RenderService } from './render-service.js';
import { KvStore, KV_FILE } from './kv-store.js';
import { SearchService } from './search.js';
import { shells } from './ipc.js';
import { trust } from './trust.js';
import { CH } from '../shared/channels.js';
import { watchVaultCallouts } from './callout-types.js';

const byWebContents = new Map(); // webContents.id -> session
const byId = new Map(); // session id -> session

export class VaultSession {
	/** @type {import('electron').BrowserWindow} */
	win = null;

	constructor(win, distDir) {
		// Unguessable (protocol hardening, 2026-09-29): the session id is the
		// only part of a preview URL that is not the vault's own path, so a
		// counter (s1, s2 …) made every one of them predictable. Nothing
		// persists it — a render names it only for this session's lifetime.
		this.id = `s${crypto.randomBytes(16).toString('hex')}`;
		this.win = win;
		// Captured now: webContents is unreachable once the window is destroyed,
		// and dispose() runs from the 'closed' event.
		this.wcId = win.webContents.id;
		// When this window last had focus (main.js's browser-window-focus), so
		// that with none focused the menu still means the one used last.
		this.lastFocusedAt = 0;
		// The caller token (main/caller-token.js): what the render endpoints
		// ask for. Per session — a window receives a vault only while it has
		// none, and nothing closes one short of closing the window, so this is
		// per vault open. Handed to this window only (vaults.ownInfo).
		this.callerToken = newCallerToken();
		this.vaults = new VaultManager();
		this.vaults.sessionId = this.id;
		this.vaults.callerToken = this.callerToken;
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
		this.kvStore.onCreated = () => this.vaults.refreshTree();

		/** Does this device trust the open vault's notes to run code? The
		 *  interim guard (vault-trust.js): the engine's note-code paths only. */
		this.trusted = false;
		/** Web PDFs this session's renders named: sha256(url) → url
		 *  (remote-pdfs.js). The route serves these and nothing else. */
		this.remotePdfs = new Map();

		this.vaults.hooks = {
			onOpen: (root) => {
				// Before the render service writes its first engine config.
				this.trusted = trust.isTrusted(root);
				this.renderService.setNoteCode(this.trusted);
				this.renderService.openVault(root);
				this.indexer.openVault(root, this.vaults.excludes);
				this.kvStore.open(root);
				// A hand edit of this vault's callout types applies at once,
				// as an edit in Settings does (ipc.js VAULT_SETTINGS_SET).
				this.stopCalloutWatch?.();
				this.stopCalloutWatch = watchVaultCallouts(root,
					() => this.renderService.vaultOption('callouts'),
					(list) => {
						this.renderService.reconfigure({ callouts: list });
						this.send(CH.EV_CALLOUTS_CHANGED);
					});
			},
			onClose: () => {
				this.stopCalloutWatch?.();
				this.stopCalloutWatch = null;
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
		// A window's shell dies with the window — the pty, and the shell
		// inside it, would otherwise outlive everything that could reach it.
		shells.close(this.id);
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

/** The session whose window has focus, else the one focused last, else the
 *  newest live one. With the app in the background no window is focused, and
 *  the menu (its check mark in the Window list, where its commands go) should
 *  still mean the window the user was in, not the one opened last. */
export function focusedSession() {
	const live = [...byId.values()].filter((s) => s.win && !s.win.isDestroyed());
	const focused = live.find((s) => s.win.isFocused());
	if (focused) return focused;
	const recent = live.reduce((best, s) => (s.lastFocusedAt > (best?.lastFocusedAt ?? 0) ? s : best), null);
	return recent ?? live.at(-1) ?? null;
}

/** The session a BrowserWindow belongs to. */
export function sessionForWindow(win) {
	return [...byId.values()].find((s) => s.win === win) ?? null;
}

/** The session that already has this vault open, if any. */
export function sessionForVault(vaultPath) {
	for (const session of byId.values()) {
		if (session.vaults.root === vaultPath) return session;
	}
	return null;
}
