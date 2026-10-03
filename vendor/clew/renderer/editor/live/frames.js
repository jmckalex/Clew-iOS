// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Tier C, the pieces that live in the DOCUMENT (plan §7): which constructs
// become engine-rendered frames, the placeholder widget that reserves their
// height in the editor, and the heights themselves.
//
// The frames (iframes) are NOT in the placeholders — CodeMirror recycles
// widget DOM and any DOM move reloads an iframe — they live in a layer over
// the content (frame-layer.js) and are positioned onto their placeholders.
// A placeholder only says "this much room, for this frame".
import { StateField, StateEffect } from '@codemirror/state';
import { WidgetType } from '@codemirror/view';
import { OFFICE_EXT } from '../../../shared/file-types.js';

/** Per-kind heights before a frame has reported its own (plan §7.6). */
const DEFAULT_HEIGHT = {
	mermaid: 240, tabbing: 120, tikz: 200, latex: 200, tex: 200, metapost: 200, TiKZ: 200, tikzpicture: 200,
	leaflet: 400, query: 200, tasks: 200, kanban: 240, dataview: 200, dataviewjs: 200, base: 200,
	reveal: 520, pdf: 480, office: 320, canvas: 320, excalidraw: 320, video: 240, audio: 54,
};

/**
 * Where a rendered block's "Edit source" icon sits (frame-layer.js): at the
 * graphic's upper-right corner, INSIDE it — except for kinds whose own
 * controls live there, where it sits just OUTSIDE the corner, in the margin
 * beside the block: a PDF (the viewer's toolbar ends in buttons), a note
 * embed (its disclosure chevron is at the right of its title), Excalidraw
 * (its title bar and view-mode UI), an app and raw HTML (anything at all).
 */
const ICON_OUTSIDE = new Set(['pdf', 'note', 'excalidraw', 'app', 'html']);

export function revealIconOutside(kind) { return ICON_OUTSIDE.has(kind); }

/** Kinds with state worth keeping alive while near the viewport. */
const PINNED = new Set(['leaflet', 'kanban', 'query', 'pdf', 'canvas', 'reveal', 'excalidraw']);

const ext = (target) => {
	const t = String(target ?? '').toLowerCase();
	if (t.endsWith('.excalidraw.md')) return '.excalidraw';
	const dot = t.lastIndexOf('.');
	return dot === -1 ? '' : t.slice(dot);
};

/** What sort of frame a Tier C construct is: 'fence'-like name or file kind. */
export function frameKind(c) {
	if (c.kind === 'embed') {
		const e = ext(c.target);
		if (e === '.pdf') return 'pdf';
		if (OFFICE_EXT.includes(e)) return 'office';
		if (e === '.canvas') return 'canvas';
		if (e === '.excalidraw') return 'excalidraw';
		if (e === '.base') return 'base';
		if (['.mp4', '.webm', '.mov'].includes(e)) return 'video';
		if (['.mp3', '.m4a', '.wav', '.ogg', '.flac'].includes(e)) return 'audio';
		return 'note';
	}
	if (c.source === 'htmlBlock') return 'html';
	return c.name ?? 'block';
}

/** Is this Tier C construct drawn as a frame under these settings? */
export function wantsFrame(c, config) {
	if (c.tier !== 'C') return false;
	if (c.kind === 'embed' || c.source === 'htmlBlock' || c.source === 'directiveAt') return config.renderEmbeds;
	return config.renderFences;
}

export function isPinnedKind(kind) { return PINNED.has(kind); }

export function defaultHeight(kind) { return DEFAULT_HEIGHT[kind] ?? 160; }

/**
 * The text a frame renders: the construct's source — except that a `|live`
 * office embed renders as its thumbnail here (a decision in force, docs/dev/live-edit.md §12: a frame is
 * evictable, and a booted LibreOffice must not be).
 */
export function frameText(c, doc) {
	const text = doc.sliceString(c.from, c.to);
	if (c.kind === 'embed' && frameKind(c) === 'office') {
		return text.replace(/\|\s*live\s*(?=[|\]])/i, '');
	}
	return text;
}

/** A frame's measured height: `{ id, height }`. */
export const setFrameHeight = StateEffect.define();

/** Construct id → last measured height (kept across edits by kind+ordinal). */
export const frameHeightField = StateField.define({
	create: () => new Map(),
	update(value, tr) {
		let next = value;
		for (const e of tr.effects) {
			if (!e.is(setFrameHeight) || next.get(e.value.id) === e.value.height) continue;
			if (next === value) next = new Map(value);
			next.set(e.value.id, e.value.height);
			if (next.size > 400) next.delete(next.keys().next().value);
		}
		return next;
	},
});

export class FramePlaceholder extends WidgetType {
	/**
	 * @param {string} id - construct id (the frame layer's key)
	 * @param {string} kind - frameKind()
	 * @param {number} height - reserved height, px
	 * @param {boolean} measured - a frame has reported this height
	 */
	constructor(id, kind, height, measured) {
		super();
		Object.assign(this, { id, kind, height, measured });
	}

	eq(other) {
		return other instanceof FramePlaceholder && other.id === this.id
			&& other.height === this.height && other.measured === this.measured;
	}

	toDOM() {
		const el = document.createElement('div');
		el.className = 'le-frame-slot';
		el.dataset.frameId = this.id;
		el.dataset.kind = this.kind;
		// A spacer. It was a thin bar that revealed the source when clicked
		// and lit up under the pointer — the owner found it by accident and
		// wanted it gone (2026-10-03); the "Edit source" icon over the
		// block's corner (frame-layer.js) is the way now. It keeps its 6px,
		// so no block moves.
		const edge = document.createElement('div');
		edge.className = 'le-frame-edge';
		const body = document.createElement('div');
		body.className = 'le-frame-body';
		const skeleton = document.createElement('div');
		skeleton.className = 'le-frame-skeleton';
		skeleton.textContent = `${this.kind} — rendering…`;
		body.append(skeleton);
		el.append(edge, body);
		this.updateDOM(el);
		return el;
	}

	updateDOM(dom) {
		if (dom.dataset.frameId !== this.id) return false;
		dom.querySelector('.le-frame-body').style.height = `${this.height}px`;
		dom.classList.toggle('is-measured', this.measured);
		return true;
	}

	get estimatedHeight() { return this.height + 8; }

	// Every event: a press on the slot — the spacer above the frame, or the
	// slot around it — is nobody's. CodeMirror took the mousedown and put the
	// cursor on the block, which revealed it (the thin bar's behaviour, which
	// the owner did not want); the frame takes the clicks on the block, and
	// the "Edit source" icon is the way to its source.
	ignoreEvent() { return true; }
}
