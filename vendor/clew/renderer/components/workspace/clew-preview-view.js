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
import '../../editor/toolbar/clew-editor-toolbar.js';

const HOST_SOURCE = 'clew-preview-host';

class ClewPreviewView extends ClewElement {
	tabId = null;
	path = null;
	#iframe = null;
	#clientReady = false;
	#pending = [];
	#suppressor = makeSuppressor();
	#lastCursorLine = null;

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
			if (key === 'editorToolbar') this.#syncModeBar();
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
		window.addEventListener('message', this.#onMessage);
	}

	cleanup() {
		window.removeEventListener('message', this.#onMessage);
		ipc.invoke(CH.RENDER_UNSUBSCRIBE, { path: this.path }).catch(() => {});
	}

	render() {
		this.classList.add('preview-host');
		ipc.invoke(CH.RENDER_SUBSCRIBE, { path: this.path }).catch(() => {});
		this.#iframe = document.createElement('iframe');
		this.#iframe.className = 'preview-frame';
		// No sandbox attribute: it would block Chromium's PDF viewer plugin for
		// ![[x.pdf]] embeds. Isolation still holds — previews load from the
		// clew-preview:// origin (the app is file://), window.open is denied
		// globally, and main blocks all main-frame navigation after load.
		// EmbedPDF's fullscreen control calls requestFullscreen() inside this
		// frame, which is refused unless the frame is allowed it.
		this.#iframe.allow = 'fullscreen';
		this.#iframe.src = previewUrl(this.path);
		this.replaceChildren(this.#iframe);
		this.#syncModeBar();
	}

	/**
	 * Reading mode's slim bar: only the mode switch, so the three modes are
	 * one click apart from every state (docs/dev/live-edit.md §6.5) — unless the
	 * toolbar is turned off altogether.
	 */
	#syncModeBar() {
		const want = (settingsStore.get('editorToolbar') ?? 'live') !== 'never';
		const bar = this.querySelector(':scope > clew-editor-toolbar');
		if (!want) { bar?.remove(); return; }
		if (bar) return;
		const slim = document.createElement('clew-editor-toolbar');
		slim.slim = true;
		slim.tabId = this.tabId;
		this.prepend(slim);
		slim.setState({ mode: 'reading', inline: new Set(), blockType: 'paragraph' });
	}

	#post(msg) {
		if (!this.#clientReady) {
			this.#pending.push(msg);
			return;
		}
		this.#iframe?.contentWindow?.postMessage({ source: HOST_SOURCE, ...msg }, '*');
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
		if (event.source !== this.#iframe?.contentWindow) return;
		const msg = event.data;
		if (!msg || msg.source !== 'clew-preview') return;

		switch (msg.type) {
			case 'ready': {
				this.#clientReady = true;
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
