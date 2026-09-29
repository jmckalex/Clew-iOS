// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Tier C's frames (plan §7.3): one small clew-preview:// document per rich
// block — mermaid, figures, maps, queries, embeds — rendered by the engine
// through the block endpoint (protocol.js `__clew_block__`), so live edit
// shows what reading mode shows, refusals included.
//
// WHERE they live is the whole design. CodeMirror recycles block-widget DOM
// as it scrolls, and moving an iframe in the DOM reloads it — so the frames
// are not in the widgets. They live in ONE layer inside the scroller (it
// scrolls with the content natively), and each is positioned onto its
// placeholder (frames.js) after every layout. A placeholder outside what
// CodeMirror has drawn hides its frame; it is not destroyed.
//
// Bounded: frames are created only for placeholders CodeMirror has drawn
// (the viewport plus its margin), at most `frameCap` per editor, the
// least-recently-visible unpinned frame evicted first. Kinds with state a
// reader would lose (maps, boards, query cells, PDFs) are pinned while in
// the drawn range. Heights come back from the frame (`size`, reported by the
// client in block mode) and flow into the placeholder through a state effect
// — one round trip, and CodeMirror re-measures.
import { ViewPlugin } from '@codemirror/view';
import { liveStateField } from './reveal-field.js';
import { liveConfigFacet } from './config.js';
import {
	frameKind, frameText, wantsFrame, isPinnedKind, setFrameHeight,
} from './frames.js';
import { handlePreviewMessage } from './frame-host.js';
import { blockUrl, blockDocumentUrl } from '../../lib/preview-url.js';
import { renderPost } from '../../lib/caller-token.js';
import { effectiveChords } from '../../commands/registry.js';
import { ipc, CH } from '../../ipc.js';
import { settingsStore } from '../../state/settings-store.js';
import { vaultSettingsStore } from '../../state/vault-settings-store.js';
import { isDependentFragment } from '../../../shared/fragment-deps.js';
import { retire } from '../../pdf-frames.js';
import { citationLines } from '../../../shared/citation-keys.js';

const HOST_SOURCE = 'clew-preview-host';
const RESTALE_MS = 300;
/** Settings that reconfigure the ENGINE (ipc.js / settings.js): every block
 *  may render differently afterwards, dependent or not. */
const ENGINE_VAULT_KEYS = new Set(['texFragments', 'normalSyntax', 'jmarkdownProject', 'pandocCitations', 'plugins', 'bibliography', 'bibliographyStyle']);
const ENGINE_APP_KEYS = new Set(['texFragments']);

/** POST a block's text; resolves to its document hash. */
async function renderBlock(text, sourcePath) {
	const response = await renderPost(blockUrl(), { text, sourcePath });
	if (!response.ok) throw new Error(`block render failed (${response.status})`);
	return (await response.json()).hash;
}

class FrameLayer {
	constructor(view) {
		this.view = view;
		/** @type {Map<string, object>} construct id → record */
		this.records = new Map();
		this.layer = document.createElement('div');
		this.layer.className = 'le-frames';
		view.scrollDOM.append(this.layer);
		this.live = null;
		this.onMessage = (event) => this.#message(event);
		window.addEventListener('message', this.onMessage);
		this.offFile = ipc.on(CH.EV_FILE_CHANGED, ({ path }) => this.#fileChanged(path));
		// Every block renders under the note's citation keys (main/
		// citation-header.js); a save that changes them re-renders the frames.
		this.citeKeys = this.#citationKeys();
		this.offKv = ipc.on(CH.EV_KV_CHANGED, (payload) => this.#broadcast({ type: 'event', name: 'kv', payload }));
		this.offTheme = settingsStore.on('settings-changed', (key) => {
			if (key === 'theme') this.#broadcast({ type: 'theme', theme: document.body.dataset.theme ?? 'dark' });
			// A global TeX fragment: main reconfigures on its own schedule
			// (settingsStore emits before the write lands), so wait longer.
			if (ENGINE_APP_KEYS.has(key)) this.#restaleAll(900);
		});
		// The per-vault switches that reconfigure the engine. The store emits
		// after main has written the setting and reconfigured, so a re-POST
		// renders under the new configuration (its key is new: render-service
		// keys every fragment by the configuration generation).
		this.offVault = vaultSettingsStore.on('vault-settings-changed', (key) => {
			if (ENGINE_VAULT_KEYS.has(key)) this.#restaleAll(RESTALE_MS);
		});
		this.restaleTimer = null;
		this.allTimer = null;
		this.#sync();
	}

	update(update) {
		const live = update.state.field(liveStateField);
		if (live !== this.live || update.docChanged) this.#sync();
		if (update.geometryChanged || update.viewportChanged || update.heightChanged || live !== this.live) {
			this.#schedule();
		}
		this.live = live;
	}

	destroy() {
		window.removeEventListener('message', this.onMessage);
		this.offFile?.();
		this.offKv?.();
		this.offTheme?.();
		this.offVault?.();
		clearTimeout(this.restaleTimer);
		clearTimeout(this.allTimer);
		clearTimeout(this.citeTimer);
		retire(this.layer);
		this.records.clear();
	}

	get config() { return this.view.state.facet(liveConfigFacet); }

	/** Records for the model's Tier C constructs; drop the ones gone. */
	#sync() {
		const { state } = this.view;
		const live = state.field(liveStateField);
		const config = this.config;
		const seen = new Set();
		const ordinal = new Map();
		for (const c of live.model) {
			if (!wantsFrame(c, config)) continue;
			const kind = frameKind(c);
			const n = ordinal.get(kind) ?? 0;
			ordinal.set(kind, n + 1);
			seen.add(c.id);
			let record = this.records.get(c.id);
			if (!record) {
				const text = frameText(c, state.doc);
				record = {
					id: c.id, kind, text, iframe: null, hash: null, ready: false, height: null,
					lastVisible: 0, pinned: isPinnedKind(kind), dependent: isDependentFragment(text),
					state: 'idle', queue: [],
				};
				this.records.set(c.id, record);
			}
			record.ordinal = n;
			record.from = c.from;
			record.line = state.doc.lineAt(c.from).number;
		}
		for (const [id, record] of this.records) {
			if (!seen.has(id)) {
				if (record.iframe) retire(record.iframe);   // a PDF edit still saving keeps it, hidden
				this.records.delete(id);
			}
		}
	}

	#schedule() {
		this.view.requestMeasure({
			key: this,
			read: () => this.#read(),
			write: (measured) => this.#write(measured),
		});
	}

	/** Where each placeholder is, relative to the layer. */
	#read() {
		const base = this.layer.getBoundingClientRect();
		const screen = this.view.scrollDOM.getBoundingClientRect();
		const out = new Map();
		for (const slot of this.view.contentDOM.querySelectorAll('.le-frame-slot')) {
			const body = slot.querySelector('.le-frame-body');
			const r = body.getBoundingClientRect();
			out.set(slot.dataset.frameId, {
				top: r.top - base.top, left: r.left - base.left, width: r.width, height: r.height,
				// Drawn is not the same as on screen: CodeMirror draws a margin
				// beyond the viewport, which is where eviction looks second.
				onScreen: r.bottom > screen.top - 200 && r.top < screen.bottom + 200,
			});
		}
		// How far every record is from the viewport, in screens — the height
		// map knows where undrawn blocks are, which the DOM cannot say.
		const { scrollTop, clientHeight } = this.view.scrollDOM;
		const docTop = this.view.documentTop - this.view.scrollDOM.getBoundingClientRect().top + scrollTop;
		this.screens = new Map();
		for (const record of this.records.values()) {
			if (record.from === undefined || record.from > this.view.state.doc.length) continue;
			const top = docTop + this.view.lineBlockAt(record.from).top;
			const gap = top < scrollTop ? scrollTop - top : Math.max(0, top - scrollTop - clientHeight);
			this.screens.set(record.id, gap / Math.max(1, clientHeight));
		}
		return out;
	}

	#write(measured) {
		const now = performance.now();
		for (const [id, record] of this.records) {
			const place = measured.get(id);
			if (!place) {
				if (record.iframe) record.iframe.style.visibility = 'hidden';
				continue;
			}
			if (place.onScreen) record.lastVisible = now;
			if (!record.iframe && record.state === 'idle' && this.#room(measured)) this.#create(record);
			if (record.iframe) {
				Object.assign(record.iframe.style, {
					visibility: 'visible',
					top: `${place.top}px`,
					left: `${place.left}px`,
					width: `${place.width}px`,
					height: `${place.height}px`,
				});
			}
		}
	}

	/**
	 * Room for one more document under `frameCap`, evicting if need be:
	 * unpinned frames before pinned ones (a map's pan, a board, a PDF's page
	 * are the reader's state — a mermaid diagram reloads for free), and
	 * within those, frames CodeMirror has not drawn, then drawn ones off
	 * screen, least recently seen first. False when every live frame is on
	 * screen or pinned within three screens (the placeholder keeps its
	 * skeleton until one scrolls away).
	 */
	#room(measured) {
		const cap = this.config.frameCap ?? 16;
		const alive = [...this.records.values()].filter((r) => r.iframe || r.state === 'posting');
		if (alive.length < cap) return true;
		const rank = (r) => (!measured.has(r.id) ? 0 : measured.get(r.id).onScreen ? 2 : 1);
		// A pinned frame within three screens is kept (plan §7.1): coming
		// back to a map must not find it reset.
		const protectedPin = (r) => r.pinned && (this.screens?.get(r.id) ?? 0) <= 3;
		const victim = alive
			.filter((r) => r.iframe && rank(r) < 2 && !protectedPin(r))
			.sort((a, b) => (a.pinned - b.pinned) || (rank(a) - rank(b)) || (a.lastVisible - b.lastVisible))[0];
		if (!victim) return false;
		retire(victim.iframe);
		victim.iframe = null;
		victim.ready = false;
		victim.state = 'idle';
		return true;
	}

	async #create(record) {
		record.state = 'posting';
		try {
			record.hash = await renderBlock(record.text, this.config.notePath);
		} catch (err) {
			record.state = 'error';
			this.#slotError(record, String(err.message ?? err));
			return;
		}
		if (!this.records.has(record.id)) return;
		const iframe = document.createElement('iframe');
		iframe.className = 'le-frame';
		iframe.allow = 'fullscreen';
		iframe.dataset.frameId = record.id;
		iframe.style.visibility = 'hidden';
		this.layer.append(iframe);
		// src AFTER insertion (the lesson from office embeds: a frame built
		// with its src and then moved may never navigate).
		iframe.src = blockDocumentUrl(record.hash);
		record.iframe = iframe;
		record.state = 'loading';
		this.#schedule();
	}

	#slotError(record, message) {
		const slot = this.view.contentDOM.querySelector(`.le-frame-slot[data-frame-id="${CSS.escape(record.id)}"] .le-frame-skeleton`);
		if (slot) slot.textContent = `${record.kind} — ${message}`;
	}

	#post(record, msg) {
		if (!record.ready) { record.queue.push(msg); return; }
		record.iframe?.contentWindow?.postMessage({ source: HOST_SOURCE, ...msg }, '*');
	}

	#broadcast(msg) {
		for (const record of this.records.values()) if (record.iframe) this.#post(record, msg);
	}

	#message(event) {
		const msg = event.data;
		if (!msg || msg.source !== 'clew-preview') return;
		let record = null;
		for (const r of this.records.values()) {
			if (r.iframe && event.source === r.iframe.contentWindow) { record = r; break; }
		}
		if (!record) return;
		switch (msg.type) {
			case 'ready':
				record.ready = true;
				record.state = 'ready';
				this.#post(record, { type: 'theme', theme: document.body.dataset.theme ?? 'dark' });
				this.#post(record, { type: 'app-chords', chords: effectiveChords() });
				for (const queued of record.queue.splice(0)) this.#post(record, queued);
				return;
			case 'size': {
				const height = Math.max(8, Math.round(msg.height));
				if (record.height === height) return;
				record.height = height;
				// Out of the message handler, never inside a view update.
				requestAnimationFrame(() => {
					if (!this.records.has(record.id)) return;
					this.view.dispatch({
						effects: [
							setFrameHeight.of({ id: record.id, height }),
							setFrameHeight.of({ id: `${record.kind}#${record.ordinal}`, height }),
						],
					});
				});
				return;
			}
			case 'morph-failed':
				if (record.iframe && record.hash) {
					record.ready = false;
					record.iframe.src = `${blockDocumentUrl(record.hash)}?t=${Date.now()}`;
				}
				return;
			default: {
				const config = this.config;
				handlePreviewMessage(msg, {
					mode: 'block', tabId: config.tabId, path: config.notePath,
					embedLine: record.line, post: (m) => this.#post(record, m),
				});
			}
		}
	}

	/** Another file changed: blocks that read other files re-render. */
	#fileChanged(path) {
		if (path === this.config.notePath) {
			// This note's own saves re-render nothing — unless its citation keys
			// changed, which every one of its blocks renders under. Compared a
			// beat later: a change made outside reaches the editor after this.
			clearTimeout(this.citeTimer);
			this.citeTimer = setTimeout(() => {
				const keys = this.#citationKeys();
				if (keys === this.citeKeys) return;
				this.citeKeys = keys;
				this.#restale({ all: true });
			}, RESTALE_MS);
			return;
		}
		if (![...this.records.values()].some((r) => r.dependent)) return;
		clearTimeout(this.restaleTimer);
		this.restaleTimer = setTimeout(() => this.#restale(), RESTALE_MS);
	}

	/** The note's citation keys, from its header (the top of the note). */
	#citationKeys() {
		const doc = this.view.state.doc;
		return JSON.stringify(citationLines(doc.sliceString(0, Math.min(doc.length, 4096))));
	}

	/** Every frame re-renders (the engine was reconfigured), debounced — a
	 *  fragment edited in settings commits per pause, not per keystroke. */
	#restaleAll(delay) {
		clearTimeout(this.allTimer);
		this.allTimer = setTimeout(() => this.#restale({ all: true }), delay);
	}

	async #restale({ all = false } = {}) {
		for (const record of this.records.values()) {
			if (!record.iframe) {
				record.hash = null; // re-POSTed whenever it is next created
				continue;
			}
			if (!all && !record.dependent) continue;
			let hash;
			try { hash = await renderBlock(record.text, this.config.notePath); } catch { continue; }
			if (hash === record.hash || !record.iframe) continue;
			record.hash = hash;
			try {
				const html = await (await fetch(blockDocumentUrl(hash))).text();
				// Morph in place (maps, PDFs, boards keep their state where the
				// client's morph guards allow), rather than reloading.
				this.#post(record, { type: 'render', html });
			} catch { /* the next change tries again */ }
		}
	}
}

export const frameLayer = ViewPlugin.fromClass(FrameLayer);
