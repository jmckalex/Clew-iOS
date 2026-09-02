// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The office dock: owner of this window's ONE LibreOffice-in-wasm iframe.
//
// Why an overlay and not a child of the tab body: reparenting an iframe
// reloads it, and the tab body is replaceChildren()'d on every tab switch —
// an office frame living there would discard a booted LibreOffice (and any
// unsaved edits) every time the user glanced at a note. So the frame lives
// in a fixed-position container on document.body, tracked to the office
// tab's host element while that tab is visible and display:none while it is
// parked. The instance survives tab switches, splits, and drags; it dies
// only when its tab actually closes — through the close guard below, which
// is what gives a dirty document its Save / Discard / Cancel moment.
//
// One instance per WINDOW is this class being a singleton; one per APP is
// the main-process office slot (office-slot.js), acquired before boot and
// released on destroy. Both exist because an instance costs ~1.6 GB.
//
// External changes: a vault-watcher event for the open document within a
// few seconds of our own save-back is the echo of that save (the same
// problem editorPool solves with lastWrittenText; bytes are not comparable
// here, so recency stands in). Anything later is real: silently reboot from
// disk when the document is clean, banner when it is dirty.
import { Emitter } from './lib/emitter.js';
import { ipc, CH } from './ipc.js';
import { workspaceStore } from './state/workspace-store.js';
import { zetaOfficeUrl } from './lib/preview-url.js';

const SAVE_TIMEOUT = 20000; // a big spreadsheet store is seconds, not minutes
const ECHO_WINDOW = 3000; // watcher events this close to our save are the save

const basename = (p) => String(p ?? '').split('/').pop();

class OfficeDock extends Emitter {
	// { tabId, path, host, container, frame, banner, ro, dirty, ready,
	//   lastSaveAt, saveWaiters } | null
	#state = null;
	#slot = { held: false }; // the app-global slot, per EV_OFFICE_SLOT
	#engine = null; // cached OFFICE_ENGINE_STATUS result
	#syncQueued = false;
	// Live office EMBEDS (`![[x.docx|live]]` in previews, live canvas
	// nodes) also post zeta-modified through this window; tracked here so
	// the close guards cover their unsaved edits too. Keyed by the posting
	// window: WindowProxy → { dirty, waiters }.
	#embeds = new Map();

	init() {
		window.addEventListener('message', this.#onMessage);
		ipc.on(CH.EV_OFFICE_SLOT, (slot) => {
			this.#slot = slot;
			this.emit('changed');
		});
		ipc.on(CH.EV_FILE_CHANGED, ({ path }) => this.#onFileChanged(path));
		ipc.on(CH.EV_CLOSE_REQUESTED, () => this.#onCloseRequested());
		// The authoritative cleanup: however a tab leaves the layout (close
		// button, pane close, vault switch, workspace reset), a dock whose
		// tab is gone must die and free both slots. Office tabs never
		// navigate (tree.js#openPath), so a tab that still exists but no
		// longer shows our document is a bug being survived, not a flow.
		workspaceStore.on('layout-changed', () => {
			const st = this.#state;
			if (st) {
				const found = workspaceStore.findTab(st.tabId);
				if (!found || found.tab.kind !== 'file' || found.tab.path !== st.path) this.destroy();
			}
			this.#queueSync();
		});
		workspaceStore.on('sizes-changed', () => this.#queueSync());
		workspaceStore.on('sidebar-changed', () => this.#queueSync());
		workspaceStore.on('active-changed', () => this.#queueSync());
		window.addEventListener('resize', () => this.#queueSync());
		workspaceStore.registerCloseGuard((tab) => this.#guardClose(tab));
	}

	// ---- what the file view asks ------------------------------------------

	isDirty(tabId) {
		if (this.#state?.tabId === tabId && this.#state.dirty === true) return true;
		return this.#embeds.size > 0 && this.#dirtyEmbedsUnder(tabId).length > 0;
	}

	/** Engine install state, cached; kicks off a fetch when unknown. */
	engineStatus() {
		if (this.#engine === null) {
			this.#engine = { pending: true };
			ipc.invoke(CH.OFFICE_ENGINE_STATUS).then((status) => {
				this.#engine = status;
				this.emit('changed');
			}).catch(() => { this.#engine = null; });
		}
		return this.#engine;
	}

	refreshEngineStatus() {
		this.#engine = null;
		return this.engineStatus();
	}

	/** Kick off (or join) the engine download; 'changed' fires on progress. */
	async downloadEngine() {
		if (this.#engine?.downloading) return;
		this.#engine = { ...(this.#engine ?? {}), downloading: true, pending: false };
		this.emit('changed');
		const poll = setInterval(() => {
			ipc.invoke(CH.OFFICE_ENGINE_STATUS).then((status) => {
				this.#engine = status;
				this.emit('changed');
			}).catch(() => {});
		}, 700);
		try {
			this.#engine = await ipc.invoke(CH.OFFICE_ENGINE_DOWNLOAD);
		} catch { /* status poll already painted the failure */ } finally {
			clearInterval(poll);
			this.emit('changed');
		}
	}

	/**
	 * A file view wants its office document on screen. Synchronous verdict:
	 *   'mine'         the dock now tracks this view's host (boots if needed)
	 *   'other-tab'    this window's instance belongs to another open tab
	 *   'other-window' the app's instance lives in another window
	 * The dock emits 'changed' whenever a verdict might improve, and the
	 * view re-renders on that — which is what wakes a blocked tab the
	 * moment the busy instance closes, here or in any other window.
	 */
	claim(view, host) {
		const { tabId, path } = view;
		if (this.#state && this.#state.tabId !== tabId) {
			return { verdict: 'other-tab', path: this.#state.path };
		}
		if (!this.#state && this.#slot.held) {
			return { verdict: 'other-window', path: this.#slot.path };
		}
		if (this.#state?.path && this.#state.path !== path) {
			// Same tab, new document (tab navigation): a wasm LibreOffice
			// cannot swap documents — reboot on the new one.
			this.destroy();
		}
		if (!this.#state) this.#boot(tabId, path);
		const st = this.#state;
		st.host = host;
		st.ro.disconnect();
		st.ro.observe(host);
		st.container.style.display = '';
		this.#queueSync();
		return { verdict: 'mine' };
	}

	/** The view left the DOM. Tab still open → park; tab gone → destroy. */
	detach(view) {
		const st = this.#state;
		if (!st || st.tabId !== view.tabId || !st.host || !view.contains(st.host)) return;
		if (!workspaceStore.findTab(st.tabId)) {
			this.destroy();
			return;
		}
		st.host = null;
		st.ro.disconnect();
		st.container.style.display = 'none';
	}

	// ---- lifecycle ---------------------------------------------------------

	#boot(tabId, path) {
		const container = document.createElement('div');
		container.className = 'office-dock';
		const frame = document.createElement('iframe');
		frame.className = 'office-frame';
		// Clipboard both ways for LibreOffice's paste/copy (Qt bridges the
		// system clipboard through the async clipboard API, which needs the
		// embedder's permissions policy to reach a cross-origin frame).
		frame.allow = 'clipboard-read; clipboard-write';
		frame.src = zetaOfficeUrl(path);
		container.append(frame);
		document.body.append(container);
		this.#state = {
			tabId, path, host: null, container, frame, banner: null,
			ro: new ResizeObserver(() => this.#queueSync()),
			dirty: false, ready: false, lastSaveAt: 0, saveWaiters: [],
		};
		// The app-global slot: optimistic boot (the local checks in claim()
		// already passed); a lost race against another window is surfaced by
		// tearing the frame back down. Marking the slot held locally stops
		// the re-rendering view from re-booting before the broadcast lands.
		ipc.invoke(CH.OFFICE_SLOT_ACQUIRE, { tabId, path }).then((res) => {
			if (!res?.ok && this.#state?.tabId === tabId) {
				this.#slot = { held: true, path: res?.path ?? null };
				this.destroy({ releaseSlot: false });
			}
		}).catch(() => {});
	}

	/** Tear down the instance and free the slot. Never prompts — callers
	 *  that owe the user a prompt (the close guard) prompt first. */
	destroy({ releaseSlot = true } = {}) {
		const st = this.#state;
		if (!st) return;
		this.#state = null;
		st.ro?.disconnect();
		st.container.remove();
		for (const resolve of st.saveWaiters) resolve(false);
		if (releaseSlot) ipc.invoke(CH.OFFICE_SLOT_RELEASE).catch(() => {});
		this.emit('changed');
		this.emit('dirty-changed', { tabId: st.tabId });
	}

	/** Reboot from disk (external change took the document under us). */
	#reload() {
		const st = this.#state;
		if (!st) return;
		const { tabId, path, host } = st;
		this.destroy({ releaseSlot: false });
		this.#boot(tabId, path);
		const next = this.#state;
		next.host = host;
		if (host) next.ro.observe(host);
		else next.container.style.display = 'none';
		this.#queueSync();
	}

	// ---- saving and the close guard ---------------------------------------

	/** Ask LibreOffice to store, and resolve once the bytes hit the vault. */
	save() {
		const st = this.#state;
		if (!st?.frame) return Promise.resolve(false);
		if (!st.dirty) return Promise.resolve(true);
		return new Promise((resolve) => {
			let settled = false;
			const once = (ok) => { if (!settled) { settled = true; resolve(ok); } };
			st.saveWaiters.push(once);
			st.frame.contentWindow?.postMessage({ cmd: 'zeta-save' }, '*');
			setTimeout(() => once(false), SAVE_TIMEOUT);
		});
	}

	/** workspaceStore close guard: claim office tabs with unsaved edits —
	 *  and note/canvas tabs whose LIVE EMBEDS have unsaved edits. */
	#guardClose(tab) {
		const st = this.#state;
		if (st && tab.id === st.tabId && st.dirty) return this.#confirmClose();
		if (this.#embeds.size > 0) {
			const dirty = this.#dirtyEmbedsUnder(tab.id);
			if (dirty.length) return this.#confirmEmbeds(dirty);
		}
		return null;
	}

	/** Save / Discard / Cancel for the current document. Resolves true when
	 *  the close may proceed (the dock is destroyed by then). */
	async #confirmClose() {
		const st = this.#state;
		if (!st) return true;
		const choice = await ipc.invoke(CH.CONFIRM_DISCARD, {
			message: `Save changes to “${basename(st.path)}”?`,
			detail: 'Office documents are not auto-saved. If you don’t save, your changes will be lost.',
		}).catch(() => 'cancel');
		if (choice === 'cancel') return false;
		if (choice === 'save') {
			const ok = await this.save();
			if (!ok) return false; // the viewer shows the error; nothing closes
		}
		this.destroy();
		return true;
	}

	/** The window wants to close (main asked). Clean → yes; anything dirty
	 *  — the office tab or any live embed — gets its dialog first. */
	async #onCloseRequested() {
		this.#sweepEmbeds();
		const dirtyEmbeds = [...this.#embeds].filter(([, e]) => e.dirty).map(([w]) => w);
		if (!this.#state?.dirty && dirtyEmbeds.length === 0) {
			ipc.invoke(CH.WINDOW_CLOSE_RESOLVED, { proceed: true }).catch(() => {});
			return;
		}
		ipc.invoke(CH.WINDOW_CLOSE_RESOLVED, { proceed: 'pending' }).catch(() => {});
		let proceed = true;
		if (this.#state?.dirty) proceed = await this.#confirmClose();
		if (proceed && dirtyEmbeds.length) proceed = await this.#confirmEmbeds(dirtyEmbeds);
		ipc.invoke(CH.WINDOW_CLOSE_RESOLVED, { proceed }).catch(() => {});
	}

	// ---- events from the viewer page --------------------------------------

	#onMessage = (e) => {
		const msg = e.data;
		const st = this.#state;
		const isDock = Boolean(st && e.source === st.frame?.contentWindow);
		// The save-back REQUEST passes through this window on its way to the
		// office-save bridge. Stamp the echo window here, before the write:
		// the vault watcher fires faster than the save-result round-trip,
		// and a stamp taken only at 'zeta-vault-saved' loses that race and
		// reboots LibreOffice out from under its own save.
		if (msg?.source === 'clew-zeta' && msg?.type === 'office-save') {
			if (isDock) st.lastSaveAt = Date.now();
			return;
		}
		if (isDock) {
			switch (msg?.cmd) {
			case 'zeta-ready':
				st.ready = true;
				break;
			case 'zeta-modified':
				if (st.dirty !== msg.state) {
					st.dirty = msg.state;
					this.emit('dirty-changed', { tabId: st.tabId });
				}
				break;
			case 'zeta-vault-saved': {
				st.lastSaveAt = Date.now();
				const waiters = st.saveWaiters.splice(0);
				for (const resolve of waiters) resolve(msg.ok === true);
				break;
			}
			}
			return;
		}
		// Not the dock's frame: a live EMBED somewhere under this window.
		if (msg?.cmd === 'zeta-modified' && e.source) {
			const entry = this.#embeds.get(e.source) ?? { dirty: false, waiters: [] };
			entry.dirty = msg.state === true;
			this.#embeds.set(e.source, entry);
			const tabId = this.#tabForEmbed(e.source);
			if (tabId) this.emit('dirty-changed', { tabId });
		} else if (msg?.cmd === 'zeta-vault-saved' && e.source) {
			const entry = this.#embeds.get(e.source);
			if (entry) {
				for (const resolve of entry.waiters.splice(0)) resolve(msg.ok === true);
			}
		}
	};

	// ---- live embeds --------------------------------------------------------

	/** Drop tracking for embed windows that no longer exist. */
	#sweepEmbeds() {
		for (const [win, entry] of this.#embeds) {
			let gone = false;
			try { gone = win.closed === true; } catch { gone = true; }
			if (gone) {
				for (const resolve of entry.waiters.splice(0)) resolve(false);
				this.#embeds.delete(win);
			}
		}
	}

	/** The workspace tab whose view hosts this embed's window, if visible:
	 *  walk the window's parent chain until an iframe of a view matches. */
	#tabForEmbed(sourceWin) {
		const views = document.querySelectorAll('clew-preview-view, clew-canvas-view');
		let w = sourceWin;
		for (let depth = 0; w && depth < 5; depth++) {
			for (const view of views) {
				for (const frame of view.querySelectorAll('iframe')) {
					if (frame.contentWindow === w) return view.tabId ?? null;
				}
			}
			let parent = null;
			try { parent = w.parent && w.parent !== w ? w.parent : null; } catch { parent = null; }
			w = parent;
		}
		return null;
	}

	/** Dirty embed windows living under one workspace tab. */
	#dirtyEmbedsUnder(tabId) {
		this.#sweepEmbeds();
		const out = [];
		for (const [win, entry] of this.#embeds) {
			if (entry.dirty && this.#tabForEmbed(win) === tabId) out.push(win);
		}
		return out;
	}

	/** Ask every given embed to store, and wait for the vault write-backs. */
	#saveEmbeds(wins) {
		return Promise.all(wins.map((win) => new Promise((resolve) => {
			const entry = this.#embeds.get(win);
			if (!entry?.dirty) { resolve(true); return; }
			let settled = false;
			const once = (ok) => { if (!settled) { settled = true; resolve(ok); } };
			entry.waiters.push(once);
			try { win.postMessage({ cmd: 'zeta-save' }, '*'); } catch { once(false); }
			setTimeout(() => once(false), SAVE_TIMEOUT);
		}))).then((results) => results.every(Boolean));
	}

	/** Save / Discard / Cancel for dirty embedded editors; true = proceed. */
	async #confirmEmbeds(wins) {
		const choice = await ipc.invoke(CH.CONFIRM_DISCARD, {
			message: wins.length === 1
				? 'Save changes to the embedded office document?'
				: `Save changes to ${wins.length} embedded office documents?`,
			detail: 'Office documents are not auto-saved. If you don’t save, your changes will be lost.',
		}).catch(() => 'cancel');
		if (choice === 'cancel') return false;
		if (choice === 'save') return this.#saveEmbeds(wins);
		return true;
	}

	#onFileChanged(path) {
		const st = this.#state;
		if (!st || path !== st.path) return;
		if (Date.now() - st.lastSaveAt < ECHO_WINDOW) return; // our own save
		if (!st.dirty) {
			this.#reload();
			return;
		}
		this.#showConflictBanner();
	}

	#showConflictBanner() {
		const st = this.#state;
		if (!st || st.banner) return;
		const banner = document.createElement('div');
		banner.className = 'conflict-banner';
		const text = document.createElement('span');
		text.textContent = 'This document changed on disk while you have unsaved edits.';
		const keep = document.createElement('button');
		keep.textContent = 'Keep my version';
		keep.addEventListener('click', () => {
			// Keep editing; the next save overwrites the disk version.
			banner.remove();
			if (this.#state === st) st.banner = null;
		});
		const reload = document.createElement('button');
		reload.textContent = 'Load disk version';
		reload.addEventListener('click', () => {
			if (this.#state === st) this.#reload();
		});
		banner.append(text, keep, reload);
		st.banner = banner;
		st.container.prepend(banner);
	}

	// ---- geometry ----------------------------------------------------------

	#queueSync() {
		if (this.#syncQueued) return;
		this.#syncQueued = true;
		requestAnimationFrame(() => {
			this.#syncQueued = false;
			this.#sync();
		});
	}

	#sync() {
		const st = this.#state;
		if (!st) return;
		if (!st.host?.isConnected) {
			st.container.style.display = 'none';
			return;
		}
		const rect = st.host.getBoundingClientRect();
		st.container.style.display = '';
		st.container.style.top = `${rect.top}px`;
		st.container.style.left = `${rect.left}px`;
		st.container.style.width = `${rect.width}px`;
		st.container.style.height = `${rect.height}px`;
	}
}

export const officeDock = new OfficeDock();
