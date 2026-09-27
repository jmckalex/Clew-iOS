// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The mechanics every floating preview shares — the link preview
// (editor/link-preview.js) and the live preview pane (editor/preview-pane.js):
// ONE kept iframe onto live edit's block endpoint, what it says (`ready`
// → theme and chords, `size` → a height), a render that loads or morphs,
// blanking it after 30 s idle, placing the pane against an anchor with a
// flip and a clamp, and never taking focus. At most one floating pane is
// visible in a window: showing one hides the other.
//
// A subclass calls `initPane()` from connectedCallback and `destroyPane()`
// from disconnectedCallback, and may override `onFrameSize(height)` and
// `onFrameMessage(msg)`.
import { blockUrl, blockDocumentUrl } from '../../lib/preview-url.js';
import { effectiveChords } from '../../commands/registry.js';
import { settingsStore } from '../../state/settings-store.js';

const HOST_SOURCE = 'clew-preview-host';
const BLANK_MS = 30000;

/** The floating pane currently showing in this window, if any. */
let visiblePane = null;

export class FloatingPane extends HTMLElement {
	#blankTimer = null;
	#generation = 0;

	/** @param {{ frameClass: string }} options */
	initPane({ frameClass }) {
		this.hidden = true;
		this.frame = document.createElement('iframe');
		this.frame.className = frameClass;
		this.frame.src = 'about:blank';
		this.frameHash = null;
		this.frameReady = false;
		this.frameHeight = null;
		this.onPaneMessage = (event) => {
			const msg = event.data;
			if (!msg || msg.source !== 'clew-preview' || event.source !== this.frame.contentWindow) return;
			if (msg.type === 'ready') {
				this.frameReady = true;
				this.postToFrame({ type: 'theme', theme: document.body.dataset.theme ?? 'dark' });
				this.postToFrame({ type: 'app-chords', chords: effectiveChords() });
			} else if (msg.type === 'size') {
				this.frameHeight = Math.round(msg.height);
				this.onFrameSize(this.frameHeight);
			} else {
				this.onFrameMessage(msg);
			}
		};
		window.addEventListener('message', this.onPaneMessage);
		this.offPaneTheme = settingsStore.on('settings-changed', (key) => {
			if (key === 'theme') this.postToFrame({ type: 'theme', theme: document.body.dataset.theme ?? 'dark' });
		});
		// Never take focus: a press on the pane's own chrome keeps the
		// editor's. (What is inside the iframe is the subclass's affair.)
		this.addEventListener('pointerdown', (e) => { if (e.target !== this.frame) e.preventDefault(); });
	}

	destroyPane() {
		window.removeEventListener('message', this.onPaneMessage);
		this.offPaneTheme?.();
		clearTimeout(this.#blankTimer);
		if (visiblePane === this) visiblePane = null;
	}

	/** Hooks. */
	onFrameSize() {}
	onFrameMessage() {}

	postToFrame(msg) {
		this.frame.contentWindow?.postMessage({ source: HOST_SOURCE, ...msg }, '*');
	}

	/**
	 * Render `text` (markdown, as it would stand in `sourcePath`) into the
	 * iframe through the block endpoint. Only the latest call counts.
	 *
	 * @param {{ morph?: boolean }} [options] - `morph`: when the frame
	 *   already holds a document, morph it in place (the client's morph
	 *   guards keep an unchanged figure) rather than reload
	 * @returns {Promise<'same'|'loaded'|'morphed'|null>} null when a later
	 *   call superseded this one, or the render failed
	 */
	async renderIntoFrame(text, sourcePath, { morph = false } = {}) {
		const generation = ++this.#generation;
		let hash;
		try {
			const response = await fetch(blockUrl(), { method: 'POST', body: JSON.stringify({ text, sourcePath }) });
			if (!response.ok) throw new Error(String(response.status));
			hash = (await response.json()).hash;
		} catch {
			return null;
		}
		if (generation !== this.#generation) return null;
		if (hash === this.frameHash) return 'same';
		if (morph && this.frameReady && this.frameHash) {
			let html;
			try { html = await (await fetch(blockDocumentUrl(hash))).text(); } catch { return null; }
			if (generation !== this.#generation) return null;
			this.frameHash = hash;
			this.postToFrame({ type: 'render', html });
			return 'morphed';
		}
		this.frameHash = hash;
		this.frameReady = false;
		this.frame.src = blockDocumentUrl(hash);
		return 'loaded';
	}

	/** The render generation (a caller's own stale-result guard). */
	get renderGeneration() { return this.#generation; }

	/** Show the pane (hiding any other floating pane). */
	showPane() {
		clearTimeout(this.#blankTimer);
		if (visiblePane && visiblePane !== this) visiblePane.hide();
		visiblePane = this;
		this.hidden = false;
	}

	/** Hide it; the document is released 30 s later unless it shows again. */
	hidePane() {
		if (this.hidden) return false;
		this.hidden = true;
		if (visiblePane === this) visiblePane = null;
		clearTimeout(this.#blankTimer);
		this.#blankTimer = setTimeout(() => this.blankFrame(), BLANK_MS);
		return true;
	}

	/** Subclasses override to add their own teardown; must call hidePane. */
	hide() { this.hidePane(); }

	blankFrame() {
		this.frame.src = 'about:blank';
		this.frameHash = null;
		this.frameReady = false;
		this.frameHeight = null;
	}

	/**
	 * Put the pane against `anchor` (a client rect): on the preferred side,
	 * flipped when that side is clipped, clamped inside the window.
	 *
	 * @param {{left:number,top:number,right:number,bottom:number}} anchor
	 * @param {{ prefer?: 'below'|'above', left?: number, gap?: number }} [options]
	 *   `left`: the x to align to (default the anchor's left)
	 * @returns {'below'|'above'} the side used
	 */
	placeAgainst(anchor, { prefer = 'below', left = anchor.left, gap = 6 } = {}) {
		const r = this.getBoundingClientRect();
		const below = anchor.bottom + gap;
		const above = anchor.top - gap - r.height;
		const fitsBelow = below + r.height <= window.innerHeight - 8;
		const fitsAbove = above >= 8;
		const side = prefer === 'below' ? (fitsBelow || !fitsAbove ? 'below' : 'above') : (fitsAbove || !fitsBelow ? 'above' : 'below');
		this.style.top = `${Math.round(side === 'below' ? below : above)}px`;
		this.style.left = `${Math.round(Math.max(8, Math.min(left, window.innerWidth - r.width - 8)))}px`;
		return side;
	}
}
