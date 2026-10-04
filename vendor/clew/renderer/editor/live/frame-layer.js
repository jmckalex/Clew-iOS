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
import { ViewPlugin, EditorView } from '@codemirror/view';
import { liveStateField } from './reveal-field.js';
import { liveConfigFacet } from './config.js';
import {
	frameKind, frameText, wantsFrame, isPinnedKind, revealIconOutside, setFrameHeight, defaultHeight,
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
import { PREVIEW_ORIGIN } from '../../../shared/message-guard.js';
import { icon } from '../../lib/icons.js';
import { pinOf, pinnedTop } from '../../../shared/app-pin.js';

/** The spacer above a frame's body (frames.js, `.le-frame-edge`). */
const EDGE = 6;

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
		// This page sees the pointer only where no frame is: a move here, off
		// an "Edit source" icon, means the pointer has left every block —
		// which a frame does not always manage to say.
		this.outsideAt = 0;
		this.onPointerMove = (e) => {
			if (e.target?.closest?.('.le-frame-reveal')) return;
			this.outsideAt = Math.max(this.outsideAt, performance.timeOrigin + e.timeStamp);
			for (const record of this.records.values()) record.reveal?.dispatchEvent(new Event('clew-out'));
		};
		window.addEventListener('pointermove', this.onPointerMove, { passive: true });
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
		// Trust (main/vault-trust.js) is the device's, not a vault setting,
		// but it reconfigures the engine all the same: `Run note code`.
		this.offTrust = ipc.on(CH.EV_VAULT_TRUST_CHANGED, () => this.#restaleAll(RESTALE_MS));
		// Custom callout types (either scope, from Settings or a hand edit of
		// the vault's file): main sends this AFTER it has reconfigured.
		this.offCallouts = ipc.on(CH.EV_CALLOUTS_CHANGED, () => this.#restaleAll(RESTALE_MS));
		this.restaleTimer = null;
		this.allTimer = null;
		// A pinned app (`pin=top|bottom`, shared/app-pin.js) follows every
		// scroll, not only CodeMirror's viewport changes.
		this.hasPins = false;
		this.onScroll = () => { if (this.hasPins) this.#schedule(); };
		view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
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
		window.removeEventListener('pointermove', this.onPointerMove);
		this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
		this.offFile?.();
		this.offKv?.();
		this.offTheme?.();
		this.offVault?.();
		this.offTrust?.();
		this.offCallouts?.();
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
			record.pin = kind === 'app' ? pinOf(frameText(c, state.doc)) : null;
		}
		this.hasPins = [...this.records.values()].some((r) => r.pin);
		for (const [id, record] of this.records) {
			if (!seen.has(id)) {
				if (record.iframe) retire(record.iframe);   // a PDF edit still saving keeps it, hidden
				record.reveal?.remove();
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
		// The visible span, in the layer's coordinates — where a pinned app
		// is held — and, for a pinned app whose block CodeMirror has not
		// drawn (far below a bottom pin, far above a top one), its place from
		// the height map, sized as it was last seen.
		out.view = { top: screen.top - base.top, bottom: screen.bottom - base.top };
		out.estimates = new Map();
		const sample = [...out.values()][0];
		const content = this.view.contentDOM.getBoundingClientRect();
		for (const record of this.records.values()) {
			if (!record.pin || out.has(record.id) || record.from === undefined || record.from > this.view.state.doc.length) continue;
			const block = this.view.lineBlockAt(record.from);
			const like = record.lastPlace ?? sample ?? { left: content.left - base.left + 24, width: content.width - 48 };
			out.estimates.set(record.id, {
				top: this.view.documentTop + block.top + EDGE - base.top, left: like.left, width: like.width,
				height: record.lastPlace?.height ?? record.height ?? defaultHeight(record.kind), onScreen: false,
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
			const drawn = measured.get(id);
			const place = drawn ?? measured.estimates?.get(id);
			// Held at an edge (pin=top|bottom) while its place is out of view
			// there: only `top` changes — the frame never moves in the DOM.
			const at = record.pin && place && measured.view
				? pinnedTop({ top: place.top, height: place.height, viewTop: measured.view.top, viewBottom: measured.view.bottom, pin: record.pin })
				: { top: place?.top, stuck: false };
			record.stuck = at.stuck;
			if (!place || (!drawn && !at.stuck)) {
				if (record.iframe) record.iframe.style.visibility = 'hidden';
				if (record.reveal) record.reveal.style.visibility = 'hidden';
				continue;
			}
			if (drawn) record.lastPlace = drawn;
			if (place.onScreen || at.stuck) record.lastVisible = now;
			if (!record.iframe && record.state === 'idle' && this.#room(measured)) this.#create(record);
			if (record.iframe) {
				record.iframe.classList.toggle('is-pinned', at.stuck);
				record.iframe.dataset.pin = at.stuck ? record.pin : '';
				Object.assign(record.iframe.style, {
					visibility: 'visible',
					top: `${at.top}px`,
					left: `${place.left}px`,
					width: `${place.width}px`,
					height: `${place.height}px`,
				});
			}
			if (record.reveal) {
				// Its top-right corner on the block's, 6px in — or, outside,
				// its top-left 6px beyond the block's right edge.
				const outside = record.reveal.classList.contains('is-outside');
				Object.assign(record.reveal.style, {
					visibility: 'visible',
					top: `${at.top + (outside ? 0 : 6)}px`,
					left: `${place.left + place.width + (outside ? 6 : -6)}px`,
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
		const rank = (r) => (r.stuck ? 2 : !measured.has(r.id) ? 0 : measured.get(r.id).onScreen ? 2 : 1);
		// A pinned frame within three screens is kept (plan §7.1): coming
		// back to a map must not find it reset.
		const protectedPin = (r) => r.pinned && (this.screens?.get(r.id) ?? 0) <= 3;
		const victim = alive
			.filter((r) => r.iframe && rank(r) < 2 && !protectedPin(r))
			.sort((a, b) => (a.pinned - b.pinned) || (rank(a) - rank(b)) || (a.lastVisible - b.lastVisible))[0];
		if (!victim) return false;
		retire(victim.iframe);
		victim.iframe = null;
		victim.reveal?.remove();
		victim.reveal = null;
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
		// Its height from the start: a render that returns after its block
		// scrolled away is not placed until the block is drawn again, and was
		// left at the iframe default, 150 px, in the meantime (live-blocks'
		// `content=79 frame=150`, 2026-10-03).
		iframe.style.height = `${record.height ?? defaultHeight(record.kind)}px`;
		// A restale MORPHS the new render in and leaves src naming the old
		// one, which an engine reconfigure has dropped from main's cache — so
		// a frame that later RELOADS (its pane re-mounted by a mode switch in
		// another pane) fetched a stale hash and showed "Not found" (measured
		// 2026-10-01, a callout definition edited beside an open embed). Such
		// a load is re-pointed at the current render. The 404 page has no
		// client to say `ready`, hence the element's own load event.
		iframe.addEventListener('load', () => {
			if (record.iframe !== iframe || !record.hash || iframe.src.includes(record.hash)) return;
			record.ready = false;
			iframe.src = blockDocumentUrl(record.hash);
		});
		record.reveal = this.#revealButton(record, iframe);
		this.layer.append(iframe);
		// src AFTER insertion (the lesson from office embeds: a frame built
		// with its src and then moved may never navigate).
		iframe.src = blockDocumentUrl(record.hash);
		record.iframe = iframe;
		record.state = 'loading';
		this.#schedule();
	}

	/**
	 * The block's "Edit source" icon (the owner's design, 2026-10-03): one
	 * for every rendered block, over its upper-right corner — or just
	 * outside it, for kinds with their own controls there
	 * (frames.js#revealIconOutside). It fades in while the pointer is over
	 * the block or the icon, and a click puts the cursor at the block's
	 * start, which reveals its source — what the arrow keys do. A click on
	 * the graphic itself is the graphic's: a map pans, a board drags, a
	 * figure does nothing. Touch screens, with no hover, keep it faintly
	 * visible (live-edit.css): a tap inside a frame never reaches this page.
	 */
	#revealButton(record, iframe) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'le-frame-reveal';
		button.title = 'Edit source';
		button.setAttribute('aria-label', 'Edit source');
		button.dataset.frameId = record.id;
		button.dataset.kind = record.kind;
		if (revealIconOutside(record.kind)) button.classList.add('is-outside');
		button.append(icon('code'));
		// mousedown, not click: the editor keeps its focus and selection
		// until the cursor is moved deliberately.
		button.addEventListener('mousedown', (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			this.#revealSource(record);
		});
		// The keyboard's way to it: Enter/Space on the focused button.
		button.addEventListener('click', (e) => {
			if (e.detail === 0) this.#revealSource(record);
		});
		let timer = null;
		let over = false;   // the pointer over the frame, as last reported
		const show = (e) => {
			if (e?.type === 'clew-over' || e?.type === 'mouseenter' && e.target === iframe) over = true;
			clearTimeout(timer);
			button.classList.add('is-shown');
		};
		// Crossing from the block to the icon (or back) is not leaving.
		const hide = (e) => {
			if (e?.type === 'clew-out' || e?.type === 'mouseleave' && e.target === iframe) over = false;
			clearTimeout(timer);
			timer = setTimeout(() => {
				if (!button.matches(':hover') && !over) button.classList.remove('is-shown');
			}, 200);
		};
		// The frame says when the pointer is over it ('pointer' messages, as
		// these events); the iframe element's own enter/leave are a fallback.
		button.addEventListener('clew-over', show);
		button.addEventListener('clew-out', hide);
		iframe.addEventListener('mouseenter', show);
		iframe.addEventListener('mouseleave', hide);
		button.addEventListener('mouseenter', show);
		button.addEventListener('mouseleave', hide);
		this.layer.append(button);
		return button;
	}

	/** The cursor to the block's start: its source, revealed. */
	#revealSource(record) {
		if (record.from === undefined || record.from > this.view.state.doc.length) return;
		this.view.dispatch({ selection: { anchor: record.from }, scrollIntoView: false });
		this.view.focus();
	}

	#slotError(record, message) {
		const slot = this.view.contentDOM.querySelector(`.le-frame-slot[data-frame-id="${CSS.escape(record.id)}"] .le-frame-skeleton`);
		if (slot) slot.textContent = `${record.kind} — ${message}`;
	}

	#post(record, msg) {
		if (!record.ready) { record.queue.push(msg); return; }
		record.iframe?.contentWindow?.postMessage({ source: HOST_SOURCE, ...msg }, PREVIEW_ORIGIN);
	}

	#broadcast(msg) {
		for (const record of this.records.values()) if (record.iframe) this.#post(record, msg);
	}

	#message(event) {
		const msg = event.data;
		if (!msg || msg.source !== 'clew-preview' || event.origin !== PREVIEW_ORIGIN) return;
		let record = null;
		for (const r of this.records.values()) {
			if (r.iframe && event.source === r.iframe.contentWindow) { record = r; break; }
		}
		if (!record) return;
		switch (msg.type) {
			case 'pointer':
				// The pointer over the block, as the frame sees it (client.js) —
				// unless this page has seen it outside every frame since.
				if (msg.over && Number(msg.at) < this.outsideAt) return;
				record.reveal?.dispatchEvent(new Event(msg.over ? 'clew-over' : 'clew-out'));
				return;
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
				// A frame whose block is not drawn (not placed, hidden) follows
				// its content now; a placed one resizes WITH its placeholder in
				// #write, or for a frame it would overlap the text below.
				if (record.iframe?.style.visibility === 'hidden') record.iframe.style.height = `${height}px`;
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

	/** Room kept clear at each edge for the pinned apps (scrollMargins). */
	margins() {
		const out = { top: 0, bottom: 0 };
		for (const r of this.records.values()) {
			if (!r.pin || !r.iframe) continue;
			out[r.pin] += (r.lastPlace?.height ?? r.height ?? 0) + 8;
		}
		return out.top || out.bottom ? out : null;
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

export const frameLayer = ViewPlugin.fromClass(FrameLayer, {
	// A pinned app takes a band at its edge: the cursor is scrolled clear of
	// it, never left under it.
	provide: (plugin) => EditorView.scrollMargins.of((view) => view.plugin(plugin)?.margins() ?? null),
});
