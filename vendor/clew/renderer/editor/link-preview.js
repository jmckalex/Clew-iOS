// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// <clew-link-preview>: the popover a hovered link shows (docs/dev/live-edit.md
// §5.11). One per window. The editor's hover plugin (link-hover.js) and
// reading mode's host (clew-preview-view.js) tell it which link is under the
// pointer — `hover()` / `unhover()` — and it owns the rest: the 500 ms delay
// (none when moving straight from one link to another while it is open), the
// 300 ms grace that lets the pointer cross into it, and every way it closes.
//
// What it shows comes from link-at.js#previewSpec. A note (or a heading's
// section, or a block) renders through live edit's block endpoint as
// `![[Target#Heading|bare]]` — the engine's own transclusion, so it is
// exactly what reading mode would show — in ONE iframe kept across hovers:
// the same target re-shows without a reload, and the fragment cache makes a
// repeat render instant. Thirty seconds after it closes the iframe is
// blanked, releasing the document. An image is a plain <img>; an unresolved
// note is a card that creates it. It never takes focus. The iframe, its
// messages, the blanking and the placing are the shared floating-pane base
// (components/chrome/floating-pane.js), which the live preview pane uses too.
import { vaultFileUrl } from '../lib/preview-url.js';
import { handlePreviewMessage } from './live/frame-host.js';
import { workspaceStore } from '../state/workspace-store.js';
import * as actions from '../commands/actions.js';
import { FloatingPane } from '../components/chrome/floating-pane.js';
import { showCitation } from './live/events.js';
import { allBibEntries } from './complete/citations.js';
import { openEntryPdf } from '../bib-pdf.js';

const DELAY_MS = 500;
const GRACE_MS = 300;
const WIDTH = 440;
const MIN_H = 80;
const MAX_H = 360;
/** Messages a preview may send that the host acts on. */
const FOLLOWED = new Set(['link-click', 'external-link', 'open-external-file']);

/** A spec's identity: the same key re-shows without a reload. */
const keyOf = (spec) => `${spec.kind}:${spec.text ?? spec.path ?? spec.name}`;

class ClewLinkPreview extends FloatingPane {
	#spec = null;          // what is shown (or about to be)
	#sourcePath = null;    // the note the hovered link is in
	#rect = null;          // the link's client rect
	#showTimer = null;
	#hideTimer = null;
	#height = MIN_H;
	#pointerInside = false;

	connectedCallback() {
		this.innerHTML = '';
		this.initPane({ frameClass: 'link-preview-frame' });
		this.setAttribute('role', 'dialog');
		this.setAttribute('aria-label', 'Link preview');
		this.header = document.createElement('div');
		this.header.className = 'link-preview-header';
		this.name = document.createElement('span');
		this.name.className = 'link-preview-name';
		this.open = document.createElement('button');
		this.open.type = 'button';
		this.open.className = 'link-preview-open';
		this.open.textContent = 'Open';
		this.open.title = 'Open (⌘-click: in a new tab)';
		this.open.addEventListener('click', (e) => this.#follow(e.metaKey || e.ctrlKey));
		this.header.append(this.name, this.open);
		this.body = document.createElement('div');
		this.body.className = 'link-preview-body';
		this.image = document.createElement('img');
		this.image.className = 'link-preview-image';
		this.image.alt = '';
		this.image.addEventListener('load', () => { this.#height = Math.min(MAX_H, Math.max(MIN_H, this.image.naturalHeight * (WIDTH / Math.max(1, this.image.naturalWidth)))); this.#place(); });
		this.card = document.createElement('button');
		this.card.type = 'button';
		this.card.className = 'link-preview-card';
		this.card.addEventListener('click', (e) => this.#follow(e.metaKey || e.ctrlKey));
		this.body.append(this.frame, this.image, this.card);
		this.append(this.header, this.body);

		this.addEventListener('pointerenter', () => { this.#pointerInside = true; clearTimeout(this.#hideTimer); });
		this.addEventListener('pointerleave', () => { this.#pointerInside = false; this.unhover(); });
		this.onKey = (e) => { if (e.key === 'Escape' && !this.hidden) this.hide(); };
		this.onPointerDown = (e) => { if (!this.hidden && !this.contains(e.target)) this.hide(); };
		this.onBlur = () => this.hide();
		document.addEventListener('keydown', this.onKey, true);
		document.addEventListener('pointerdown', this.onPointerDown, true);
		window.addEventListener('blur', this.onBlur);
		this.offLayout = workspaceStore.on('layout-changed', () => this.hide());
	}

	disconnectedCallback() {
		this.destroyPane();
		document.removeEventListener('keydown', this.onKey, true);
		document.removeEventListener('pointerdown', this.onPointerDown, true);
		window.removeEventListener('blur', this.onBlur);
		this.offLayout?.();
	}

	/** Whether a preview is showing. */
	get showing() { return !this.hidden; }

	/**
	 * The pointer is over a link.
	 *
	 * @param {ReturnType<import('./link-at.js').previewSpec>} spec
	 * @param {DOMRect|{left:number,top:number,right:number,bottom:number}} rect
	 * @param {string|null} sourcePath - the note the link is in
	 * @param {{ now?: boolean }} [options] - `now`: skip the delay
	 */
	hover(spec, rect, sourcePath, { now = false } = {}) {
		clearTimeout(this.#hideTimer);
		clearTimeout(this.#showTimer);
		if (!spec) { this.unhover(); return; }
		if (!this.hidden && this.#spec && keyOf(this.#spec) === keyOf(spec)) {
			this.#rect = rect;
			this.#place();
			return;
		}
		// Moving straight from one link to another while a preview is up:
		// no second wait.
		const delay = now || !this.hidden ? 0 : DELAY_MS;
		this.#showTimer = setTimeout(() => this.#show(spec, rect, sourcePath), delay);
	}

	/** The pointer left the link: cancel, or close after the grace. */
	unhover() {
		clearTimeout(this.#showTimer);
		if (this.hidden || this.#pointerInside) return;
		clearTimeout(this.#hideTimer);
		this.#hideTimer = setTimeout(() => { if (!this.#pointerInside) this.hide(); }, GRACE_MS);
	}

	hide() {
		clearTimeout(this.#showTimer);
		clearTimeout(this.#hideTimer);
		this.#pointerInside = false;
		if (this.hidePane()) this.classList.remove('shown');
	}

	blankFrame() {
		super.blankFrame();
		this.#spec = null;
	}

	async #show(spec, rect, sourcePath) {
		const sameTarget = this.#spec && keyOf(this.#spec) === keyOf(spec);
		this.#spec = spec;
		this.#rect = rect;
		this.#sourcePath = sourcePath;
		this.name.textContent = spec.label;
		// A citation's button shows its entry in the Library (§5.14), and says
		// so; anything else opens what the link names.
		this.open.hidden = spec.kind === 'unresolved' && !spec.cite;
		this.open.textContent = spec.cite ? 'Show in Library' : 'Open';
		this.open.title = spec.cite
			? 'Show this entry in the References panel’s Library (⌘-click: open its PDF, if it has one)'
			: 'Open (⌘-click: in a new tab)';
		this.frame.hidden = spec.kind !== 'block';
		this.image.hidden = spec.kind !== 'image';
		this.card.hidden = spec.kind !== 'unresolved';
		this.dataset.kind = spec.kind;
		if (spec.kind === 'image') {
			this.image.src = vaultFileUrl(spec.path);
		} else if (spec.kind === 'unresolved') {
			const what = /\.[A-Za-z0-9]+$/.test(spec.name) && !/\.(md|jmd)$/i.test(spec.name) ? 'file' : 'note';
			const line = document.createElement('span');
			line.className = 'link-preview-card-title';
			line.textContent = spec.message ?? `No ${what} called ${spec.name}`;
			const hint = document.createElement('span');
			hint.className = 'link-preview-card-hint';
			hint.textContent = spec.hint ?? (spec.message ? 'Add @label[…] where it should point' : what === 'note' ? 'Click to create it' : 'Nothing in the vault has that name');
			this.card.replaceChildren(line, hint);
			this.card.disabled = what !== 'note' || Boolean(spec.message);
			this.#height = 0;
		} else if (!sameTarget || !this.frameHash) {
			const result = await this.renderIntoFrame(spec.text, sourcePath);
			if (result === null || this.#spec !== spec) return;
			if (result === 'loaded') this.#height = MIN_H;
		}
		this.showPane();
		this.#place();
		requestAnimationFrame(() => this.classList.add('shown'));
	}

	onFrameSize(height) {
		this.#height = height;
		this.#place();
	}

	/** Below the link, flipped above when clipped, clamped sideways. */
	#place() {
		if (this.hidden || !this.#rect) return;
		const bodyH = this.#spec?.kind === 'unresolved' ? 0 : Math.min(MAX_H, Math.max(MIN_H, this.#height));
		// The body's padding (link-preview.css) is outside the document's height.
		const pad = this.#spec?.kind === 'block' ? 12 : 0;
		this.body.style.height = this.#spec?.kind === 'unresolved' ? '' : `${bodyH + pad}px`;
		this.placeAgainst(this.#rect, { prefer: 'below' });
	}

	onFrameMessage(msg) {
		// Following a link inside the preview happens in the window; a click
		// in it never makes it the active tab (`focused` ignored).
		if (!FOLLOWED.has(msg.type)) return;
		this.hide();
		handlePreviewMessage(msg, {
			mode: 'block', tabId: workspaceStore.activeTab()?.id ?? null, path: this.#sourcePath, post: (m) => this.postToFrame(m),
		});
	}

	#follow(newTab) {
		const spec = this.#spec;
		if (!spec) return;
		this.hide();
		// A citation: its (first) entry in the Library, as a pill's click
		// does — or with ⌘, the entry's PDF when it has one.
		if (spec.cite) {
			const key = spec.cite[0];
			if (!newTab) { showCitation(key); return; }
			allBibEntries().then((entries) => {
				if (!openEntryPdf(entries.find((e) => e.key === key))) showCitation(key);
			}, () => showCitation(key));
			return;
		}
		if (spec.kind === 'unresolved') actions.openWikilink(spec.name, { newTab });
		else {
			const heading = spec.text?.match(/#([^|\]]+)/)?.[1];
			actions.openWikilink(spec.path.replace(/\.(md|jmd)$/i, '') + (heading ? `#${heading}` : ''), { newTab });
		}
	}

	/** For scenarios: what is showing. */
	describe() {
		return {
			visible: !this.hidden, kind: this.#spec?.kind ?? null, path: this.#spec?.path ?? null, label: this.#spec?.label ?? null,
			button: this.open.hidden ? null : this.open.textContent,
			ready: this.frameReady, height: Math.round(this.body.getBoundingClientRect().height),
			src: this.frame.getAttribute('src'), card: this.card.hidden ? null : this.card.firstChild?.textContent ?? null,
		};
	}
}

customElements.define('clew-link-preview', ClewLinkPreview);

/** The window's one popover. */
export function linkPreview() {
	let el = document.querySelector('clew-link-preview');
	if (!el) {
		el = document.createElement('clew-link-preview');
		document.body.append(el);
	}
	return el;
}
