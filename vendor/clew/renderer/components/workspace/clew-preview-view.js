// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// <clew-preview-view>: reading mode for one note tab — a sandboxed iframe
// showing the jmarkdown-rendered document served via clew-preview://, updated
// in place (morphdom in the preview client) on re-renders.
import { ClewElement } from '../base/clew-element.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { vaultStore } from '../../state/vault-store.js';
import { settingsStore } from '../../state/settings-store.js';
import { ipc, CH } from '../../ipc.js';
import * as actions from '../../commands/actions.js';
import { effectiveChords } from '../../commands/registry.js';
import { handlePreviewMessage } from '../../editor/live/frame-host.js';
import { linkPreview } from '../../editor/link-preview.js';
import { previewMode, vaultResolvers } from '../../editor/link-hover.js';
import { parseTarget, previewSpec } from '../../editor/link-at.js';
import { scrollSyncBus, makeSuppressor } from '../../preview/scroll-sync.js';
import { previewUrl } from '../../lib/preview-url.js';
import { PREVIEW_ORIGIN } from '../../../shared/message-guard.js';
import { bookReadingBanner } from '../../books.js';

const HOST_SOURCE = 'clew-preview-host';
/** After the frame's `load`, a client that has not said 'ready' within this
 *  long never will — its message was lost (see #watchReady). */
const READY_AFTER_LOAD_MS = 1500;

class ClewPreviewView extends ClewElement {
	tabId = null;
	path = null;
	#iframe = null;
	#clientReady = false;
	#pending = [];
	#suppressor = makeSuppressor();
	#lastCursorLine = null;
	#readyWatch = null;
	#watchdogSpentOn = null;   // the note a rebuild was spent on (once per element and note)
	#banner = null;            // a chapter's book line (books.js#bookReadingBanner), or null

	subscribe() {
		this.listen({ on: ipc.on }, CH.EV_RENDER_DONE, ({ path }) => {
			if (path === this.path) this.#refresh();
		});
		this.listen({ on: ipc.on }, CH.EV_KV_CHANGED, (payload) => {
			this.#post({ type: 'event', name: 'kv', payload });
		});
		this.listen({ on: ipc.on }, CH.EV_RENDER_ERROR, ({ path, message }) => {
			if (path === this.path) this.#post({ type: 'error', message });
		});
		// Canvas embeds (![[X.canvas]]) rebuild in place when the file changes.
		this.listen({ on: ipc.on }, CH.EV_FILE_CHANGED, ({ path }) => {
			if (path.toLowerCase().endsWith('.canvas')) this.#post({ type: 'canvas-changed', path });
		});
		this.listen(scrollSyncBus, 'scroll', ({ path, line, from }) => {
			if (from === 'preview' || path !== this.path) return;
			// A navigation jump (a [[#Heading]] click landing in reading mode)
			// moves the reader as surely as a scroll gesture does, so it counts
			// as the reading position; an editor's sync scroll does not — that
			// pane's own cursor is already the truth for it.
			if (from === 'nav') this.#rememberReadingLine(line);
			this.#suppressor.suppress();
			this.#post({ type: 'scroll-to-line', line, behavior: 'auto' });
		});
		this.listen(settingsStore, 'settings-changed', (key) => {
			this.#post({ type: 'theme', theme: document.body.dataset.theme ?? 'dark' });
			if (key === 'sidenotes') this.#post({ type: 'sidenotes', mode: settingsStore.get('sidenotes') ?? 'auto' });
		});
		// Back/Forward over anchor jumps restore a same-path entry, which the
		// tab group deliberately does not rebuild — scroll the live document.
		this.listen(workspaceStore, 'layout-changed', () => {
			const line = workspaceStore.findTab(this.tabId)?.tab.view.cursorLine;
			if (!Number.isFinite(line) || line === this.#lastCursorLine) return;
			this.#lastCursorLine = line;
			this.#suppressor.suppress();
			this.#post({ type: 'scroll-to-line', line, behavior: 'auto' });
		});
		// The chapter's book line follows the book: a chapter added, moved or
		// removed, the book it shows switched (D10).
		this.listen(vaultStore, 'index-changed', () => this.#syncBanner());
		this.listen(workspaceStore, 'book-changed', () => this.#syncBanner());
		window.addEventListener('message', this.#onMessage);
	}

	cleanup() {
		clearTimeout(this.#readyWatch);
		window.removeEventListener('message', this.#onMessage);
		ipc.invoke(CH.RENDER_UNSUBSCRIBE, { path: this.path }).catch(() => {});
	}

	render() {
		this.classList.add('preview-host');
		ipc.invoke(CH.RENDER_SUBSCRIBE, { path: this.path }).catch(() => {});
		this.replaceChildren();
		this.#banner = null;
		this.#syncBanner();
		this.#buildFrame();
	}

	/** A chapter's quiet line above the frame — app chrome, never in the
	 *  note's document, and a sibling the frame is never moved for (a moved
	 *  iframe reloads). A note in no book gets nothing. */
	#syncBanner() {
		const next = bookReadingBanner(this.path);
		if ((this.#banner?.dataset.key ?? null) === (next?.dataset.key ?? null)) return;
		this.#banner?.remove();
		this.#banner = next;
		if (next) this.prepend(next);
	}

	/** The preview iframe — built by render(), and rebuilt by the watchdog. */
	#buildFrame() {
		clearTimeout(this.#readyWatch);
		// A new frame has not said 'ready', whatever the last one did: until
		// it does, messages queue (#post) instead of going to a document that
		// is still loading — and the watchdog below can tell a lost 'ready'.
		this.#clientReady = false;
		const old = this.#iframe;
		const frame = document.createElement('iframe');
		frame.className = 'preview-frame';
		// No sandbox attribute, and the reason is fetch (CLAUDE.md): a
		// sandboxed frame has an opaque origin, and a preview document fetches
		// clew-preview:// URLs constantly — canvas scenes, maps' data, plugins
		// reading their own note. (It used to be Chromium's PDF plugin; PDFs
		// are EmbedPDF now.) Isolation holds without it — previews load from
		// the clew-preview:// origin, not the app's; window.open is denied
		// globally; main blocks every main-frame navigation after load.
		// EmbedPDF's fullscreen control calls requestFullscreen() inside this
		// frame, which is refused unless the frame is allowed it.
		frame.allow = 'fullscreen';
		frame.addEventListener('load', () => this.#watchReady(frame));
		frame.src = previewUrl(this.path);
		this.#iframe = frame;
		if (old?.parentNode === this) old.replaceWith(frame);
		else this.append(frame);
	}

	/**
	 * The stuck-preview watchdog, keyed on LOAD (item 12; the iOS session's
	 * finding): WebKit can hand a custom-scheme iframe that the workspace
	 * moved in the DOM a stale window proxy, and postMessage is then dropped
	 * silently BOTH ways — the document loads and runs, but its 'ready' never
	 * arrives and the bridge (re-renders, theme, scroll sync) never opens.
	 * The client posts 'ready' as it runs, before `load`, so a frame that has
	 * loaded and still not said it, a moment later, lost it: rebuild the frame
	 * — ONCE per element and note, so a frame that is stuck for another reason
	 * is not rebuilt forever. Never a retiring view (pdf-frames.js#retire),
	 * whose document may be holding an unsaved annotation. Chromium does not
	 * lose the message; there, this never fires.
	 */
	#watchReady(frame) {
		if (this.#clientReady || frame !== this.#iframe) return;
		clearTimeout(this.#readyWatch);
		this.#readyWatch = setTimeout(() => {
			if (this.#clientReady || frame !== this.#iframe || !this.isConnected) return;
			if (this.hasAttribute('data-clew-retiring') || this.#watchdogSpentOn === this.path) return;
			this.#watchdogSpentOn = this.path;
			this.#buildFrame();
		}, READY_AFTER_LOAD_MS);
	}

	#post(msg) {
		if (!this.#clientReady) {
			this.#pending.push(msg);
			return;
		}
		this.#iframe?.contentWindow?.postMessage({ source: HOST_SOURCE, ...msg }, PREVIEW_ORIGIN);
	}

	/** Where the reader is now — consumed once by the editor view when this
	 *  tab flips to source mode (see clew-editor-view#restoreViewState). */
	#rememberReadingLine(line) {
		if (Number.isFinite(line)) workspaceStore.updateTabView(this.tabId, { readingLine: line });
	}

	async #refresh() {
		try {
			const response = await fetch(previewUrl(this.path));
			const html = await response.text();
			this.#post({ type: 'render', html });
		} catch (err) {
			console.error('Preview refresh failed:', err);
		}
	}

	#onMessage = (event) => {
		if (event.source !== this.#iframe?.contentWindow || event.origin !== PREVIEW_ORIGIN) return;
		const msg = event.data;
		if (!msg || msg.source !== 'clew-preview') return;

		switch (msg.type) {
			case 'ready': {
				this.#clientReady = true;
				clearTimeout(this.#readyWatch);
				this.#post({ type: 'theme', theme: document.body.dataset.theme ?? 'dark' });
				// The app's chords, so the iframe can forward EVERY app
				// shortcut rather than a hardcoded few — an iframe keydown
				// never reaches the app window's dispatcher on its own.
				// (Rebinding hotkeys mid-session refreshes on next reload.)
				this.#post({ type: 'app-chords', chords: effectiveChords() });
				this.#post({ type: 'sidenotes', mode: settingsStore.get('sidenotes') ?? 'auto' });
				// Land where the editor's cursor was when reading mode opened.
				const cursorLine = workspaceStore.findTab(this.tabId)?.tab.view.cursorLine;
				this.#lastCursorLine = Number.isFinite(cursorLine) ? cursorLine : null;
				if (cursorLine > 1) {
					this.#suppressor.suppress();
					this.#post({ type: 'scroll-to-line', line: cursorLine, behavior: 'auto' });
				}
				for (const queued of this.#pending.splice(0)) this.#post(queued);
				break;
			}
			case 'anchor-jump':
				// A TOC click is browser-style navigation: the spot you left
				// becomes a history entry, so Back returns you to it.
				this.#lastCursorLine = msg.toLine;
				workspaceStore.recordAnchorJump(this.tabId, msg.fromLine, msg.toLine);
				break;
			case 'source-line-click': {
				// Inverse search: flip this tab to its editing mode at the
				// clicked line.
				const found = workspaceStore.findTab(this.tabId);
				if (found) {
					found.tab.view.pendingLine = Math.max(1, msg.line);
					workspaceStore.setTabMode(this.tabId, actions.editModeOf(found.tab));
				}
				break;
			}
			case 'morph-failed':
				this.#clientReady = false;
				if (this.#iframe) this.#iframe.src = previewUrl(this.path) + '?t=' + Date.now();
				break;
			case 'scrolled':
				// A scroll the host did not drive is the reader moving: remember
				// where they got to, so flipping back to source mode lands the
				// editor there instead of at the cursor they left behind. The
				// suppressor is what separates the two, and it must: the scroll
				// that seeds this preview from the cursor on open would otherwise
				// record the cursor's own block and then move the cursor to the
				// top of it, mangling a reading-mode round trip that changed
				// nothing.
				if (!this.#suppressor.active()) {
					this.#rememberReadingLine(msg.line);
					scrollSyncBus.emit('scroll', { path: this.path, line: msg.line, from: 'preview' });
				}
				break;
			case 'link-hover': {
				// Hover previews (§5.11): the popover is the window's, so the
				// link's rect moves from the frame's coordinates to ours.
				const mode = previewMode();
				if (mode === 'off' || (mode === 'mod' && !msg.mod)) { linkPreview().unhover(); break; }
				const frame = this.#iframe.getBoundingClientRect();
				const r = msg.rect;
				const rect = { left: frame.left + r.left, right: frame.left + r.right, top: frame.top + r.top, bottom: frame.top + r.bottom };
				const link = msg.cite
					? { kind: 'cite', command: 'cite', keys: String(msg.cite).split(/[,;]\s*/).filter(Boolean), from: 0, to: 0 }
					: parseTarget(msg.target);
				linkPreview().hover(previewSpec(link, vaultResolvers(this.path)), rect, this.path, { now: mode === 'mod' });
				break;
			}
			case 'link-unhover':
				if (msg.scrolled) linkPreview().hide();
				else linkPreview().unhover();
				break;
			default:
				// Everything a block document shares (live/frame-host.js).
				handlePreviewMessage(msg, {
					mode: 'note', tabId: this.tabId, path: this.path, post: (m) => this.#post(m),
				});
		}
	};
}

customElements.define('clew-preview-view', ClewPreviewView);
