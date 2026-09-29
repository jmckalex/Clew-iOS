// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// <clew-preview-pane>: the live preview pane (docs/dev/live-edit.md §5.12).
// While the cursor is inside a formula or a diagram block — its source
// showing, in source mode or revealed in live edit — the pane beside it
// shows what the CURRENT source renders to, updated on a typing pause.
// One per window; the editor plugin (preview-pane-plugin.js) tells it
// which target the cursor is in, and it does the rest.
//
// Two renderers, both existing ones. A formula goes through
// lib/mathjax.js#typesetTex — the call the math widget makes, cached — so
// the pane's picture IS the widget's, and leaving the formula shows it
// with no flicker. A diagram goes through live edit's block endpoint into
// the floating-pane base's one iframe: loaded once, then MORPHED per
// update, so the figure morph guard keeps what did not change and a TikZ
// error shows its console exactly as reading mode would. Only the latest
// text renders (the base's generation counter drops stale results).
//
// It is a mirror, not a document: the frame takes no pointer events (the
// pane's body scrolls it), and it never takes focus.
//
// And it must not eat the wheel (owner's decision, 2026-09-29): the pane is
// fixed, outside the editor's scroller, so a wheel over it reached nothing
// and the note stood still. A wheel the pane's body can use — a diagram
// taller than the pane — scrolls it, natively; any other wheel scrolls the
// note. A gesture that began on the pane stays there until it pauses (the
// browser's own scroll latching), so a trackpad's momentum does not jump to
// the note halfway through.
import { typesetTex, mathReady, mathLoaded } from '../lib/mathjax.js';
import { FloatingPane } from '../components/chrome/floating-pane.js';
import { workspaceStore } from '../state/workspace-store.js';
import { settingsStore } from '../state/settings-store.js';
import { sameTarget } from './preview-target.js';

const MIN_H = 60;
const MAX_H = 420;
/** A wheel gesture is over once its events pause this long. */
const GESTURE_GAP_MS = 150;

const sourceOf = (t) => t.tex ?? t.text;

class ClewPreviewPane extends FloatingPane {
	#view = null;
	#target = null;       // the target shown (or being rendered)
	#shown = null;        // the source text the pane currently shows
	#path = null;
	#timer = null;
	#dismissed = null;    // Escape: this target stays hidden until left
	#renders = 0;         // engine renders applied (scenarios count them)
	#latched = 0;         // a wheel gesture on the pane's own scroll: until when

	connectedCallback() {
		this.innerHTML = '';
		this.initPane({ frameClass: 'preview-pane-frame' });
		this.setAttribute('role', 'status');
		this.setAttribute('aria-label', 'Live preview');
		this.body = document.createElement('div');
		this.body.className = 'preview-pane-body';
		this.math = document.createElement('div');
		this.math.className = 'preview-pane-math';
		this.error = document.createElement('div');
		this.error.className = 'preview-pane-error';
		this.error.hidden = true;
		this.frame.tabIndex = -1;
		this.body.append(this.math, this.frame);
		this.append(this.body, this.error);
		this.addEventListener('wheel', this.#onWheel, { passive: false });
		this.offLayout = workspaceStore.on('layout-changed', () => this.release());
		this.offSettings = settingsStore.on('settings-changed', (key) => {
			if (key === 'previewPane' && settingsStore.get('previewPane') === 'off') this.release();
		});
	}

	disconnectedCallback() {
		this.removeEventListener('wheel', this.#onWheel);
		this.destroyPane();
		this.offLayout?.();
		this.offSettings?.();
	}

	/** The pane's own scroll first, as the browser does; the note otherwise. */
	#onWheel = (e) => {
		const now = performance.now();
		const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
		const dx = e.deltaX * px;
		const dy = e.deltaY * px;
		const body = this.body;
		const math = this.math;
		const canY = (el) => (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : dy < 0 && el.scrollTop > 0);
		const canX = (el) => (dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : dx < 0 && el.scrollLeft > 0);
		const bodyScrolls = getComputedStyle(body).overflowY !== 'hidden';
		const own = Math.abs(dy) >= Math.abs(dx)
			? bodyScrolls && canY(body)
			: canX(math) || canX(body);
		if (own) {
			this.#latched = now + GESTURE_GAP_MS;   // native scroll; stay with it
			return;
		}
		e.preventDefault();
		if (now < this.#latched) {                // the pane's gesture, at its edge
			this.#latched = now + GESTURE_GAP_MS;
			return;
		}
		this.#view?.scrollDOM.scrollBy({ top: dy, left: dx });
	};

	/**
	 * The cursor of `view` is in `target` (or in none: null).
	 *
	 * @param {import('@codemirror/view').EditorView} view
	 * @param {ReturnType<import('./preview-target.js').previewTargetAt>} target
	 * @param {string|null} path - the note, for the engine's sourcePath
	 */
	track(view, target, path) {
		if (!target) {
			this.#dismissed = null;
			if (this.#view === view || !this.#view) this.release();
			return;
		}
		if (this.#dismissed && sameTarget(this.#dismissed, target)) return;
		this.#dismissed = null;
		const same = this.#view === view && sameTarget(this.#target, target);
		this.#view = view;
		this.#target = target;
		this.#path = path;
		if (same) {
			// (A render may still be in flight, the pane not yet shown.)
			this.reposition();
			if (sourceOf(target) === this.#shown) return;
			// Typing inside the same target: render on the pause.
			clearTimeout(this.#timer);
			this.#timer = setTimeout(() => this.#render(), target.pause);
			return;
		}
		clearTimeout(this.#timer);
		this.#render();
	}

	/** Escape: hide, and stay hidden until the cursor leaves this target. */
	dismiss() {
		if (this.hidden) return false;
		this.#dismissed = this.#target;
		this.release();
		return true;
	}

	/** Stop tracking and hide. */
	release() {
		clearTimeout(this.#timer);
		this.#target = null;
		this.#shown = null;
		this.hide();
	}

	hide() {
		clearTimeout(this.#timer);
		this.hidePane();
	}

	/** The view this pane follows (the plugin only repositions its own). */
	get view() { return this.#view; }

	async #render() {
		const target = this.#target;
		if (!target) return;
		const source = sourceOf(target);
		const isMath = target.kind.startsWith('math');
		this.dataset.kind = target.kind;
		this.frame.hidden = isMath;
		this.math.hidden = !isMath;
		if (isMath) {
			if (!mathLoaded()) {
				mathReady().then(() => { if (this.#target === target) this.#render(); }).catch(() => {});
				return;
			}
			const out = typesetTex(target.tex, { display: target.kind === 'math-display' });
			const message = out?.getAttribute('data-mjx-error');
			if (message) {
				// The last good rendering stays; the message goes under it.
				this.error.textContent = message;
				this.error.hidden = false;
			} else if (out) {
				this.error.hidden = true;
				this.math.replaceChildren(out);
			}
			this.#shown = source;
			this.body.style.height = '';
			this.removeAttribute('data-overflows');
		} else {
			if (this.hidden) this.error.hidden = true;
			const result = await this.renderIntoFrame(target.text, this.#path, { morph: true });
			if (result === null || this.#target !== target) return;
			if (result !== 'same') this.#renders += 1;
			this.#shown = source;
			this.#sizeFrame();
		}
		this.showPane();
		this.reposition();
	}

	onFrameSize() {
		this.#sizeFrame();
		this.reposition();
	}

	#sizeFrame() {
		const h = this.frameHeight ?? MIN_H;
		this.frame.style.height = `${h}px`;
		// The body's own padding on top: sized to the frame alone, every
		// diagram overflowed by it (12 px) — a phantom scroll that took the
		// first wheel from the note.
		const style = getComputedStyle(this.body);
		const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
		this.body.style.height = `${Math.min(MAX_H, Math.max(MIN_H, h + padding))}px`;
		// Whether the pane scrolls its own content: a touch port lets a drag
		// over a pane that FITS fall through to the note (Clew-iOS, pointer:
		// coarse → pointer-events: none unless [data-overflows]).
		this.toggleAttribute('data-overflows', h + padding > MAX_H);
	}

	/**
	 * Against the target: an inline formula ABOVE its line at its own x (it
	 * never covers what is being typed); a display formula or a block BELOW
	 * its last line, as wide as the text column. Hidden while the anchor is
	 * off screen.
	 */
	reposition() {
		const view = this.#view;
		const target = this.#target;
		if (this.hidden || !view || !target) return;
		view.requestMeasure({
			key: this,
			read: () => {
				const pos = Math.min(target.from, view.state.doc.length);
				const end = Math.min(target.to, view.state.doc.length);
				const start = view.coordsAtPos(pos, 1);
				const last = view.coordsAtPos(end, -1);
				const scroller = view.scrollDOM.getBoundingClientRect();
				const line = view.domAtPos(view.state.doc.lineAt(pos).from).node;
				const lineEl = (line.nodeType === 1 ? line : line.parentElement)?.closest('.cm-line');
				const column = (lineEl ?? view.contentDOM).getBoundingClientRect();
				return { start, last, scroller, column };
			},
			write: ({ start, last, scroller, column }) => {
				if (!start || !last || last.bottom < scroller.top || start.top > scroller.bottom) {
					this.style.visibility = 'hidden';
					return;
				}
				this.style.visibility = '';
				if (target.kind === 'math-inline') {
					this.style.width = '';
					this.style.maxWidth = `${Math.round(column.width)}px`;
					this.dataset.side = this.placeAgainst(start, { prefer: 'above', left: start.left });
				} else {
					this.style.width = `${Math.round(column.width)}px`;
					this.style.maxWidth = '';
					this.dataset.side = this.placeAgainst({ ...last, left: column.left }, { prefer: 'below', left: column.left });
				}
			},
		});
	}

	/** For scenarios: what is showing. */
	describe() {
		return {
			visible: !this.hidden, kind: this.#target?.kind ?? null, lang: this.#target?.lang ?? null,
			side: this.dataset.side ?? null, ready: this.frameReady, src: this.frame.getAttribute('src'),
			svg: this.math.hidden ? null : this.math.querySelector('svg')?.outerHTML ?? null,
			error: this.error.hidden ? null : this.error.textContent, renders: this.#renders,
		};
	}
}

customElements.define('clew-preview-pane', ClewPreviewPane);

/** The window's one live preview pane. */
export function previewPane() {
	let el = document.querySelector('clew-preview-pane');
	if (!el) {
		el = document.createElement('clew-preview-pane');
		document.body.append(el);
	}
	return el;
}
