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
// It is a mirror, not a document: it takes NO pointer events and never
// focus — a click or a wheel over it goes to the note under it (the owner's
// report, 2026-10-03: a broken figure's pane, the whole TeX log in it, sat
// over the fence and took the clicks meant for the typo). And it never
// covers the block being edited: a block's pane goes BELOW it, else BESIDE
// the text column, else below and shrunk to the room there, else nowhere
// (reposition). Before, it went above the block's LAST line when there was
// no room below — over the block itself.
//
// A failed figure says where (preview-client/figures.js): the pane finds the
// fence line its error names (shared/figure-errors.js) and marks it in the
// editor (figure-error-mark.js) until the figure renders or the cursor
// leaves.
import { typesetTex, mathReady, mathLoaded } from '../lib/mathjax.js';
import { FloatingPane } from '../components/chrome/floating-pane.js';
import { workspaceStore } from '../state/workspace-store.js';
import { settingsStore } from '../state/settings-store.js';
import { sameTarget } from './preview-target.js';
import { locateFigureError } from '../../shared/figure-errors.js';
import { setFigureError } from './figure-error-mark.js';

const MIN_H = 60;
const MAX_H = 420;
/** The least room a block's pane is shown in, below its block. */
const MIN_ROOM = 90;
/** The least width beside the text column worth placing it in. */
const MIN_BESIDE = 300;
const GAP = 6;

const sourceOf = (t) => t.tex ?? t.text;

class ClewPreviewPane extends FloatingPane {
	#view = null;
	#target = null;       // the target shown (or being rendered)
	#shown = null;        // the source text the pane currently shows
	#path = null;
	#timer = null;
	#dismissed = null;    // Escape: this target stays hidden until left
	#renders = 0;         // engine renders applied (scenarios count them)
	#figureError = null;  // { message, noteLine } of the figure shown, if it failed
	#marked = null;       // { view, id }: the line marked, and in which editor
	#markSeq = 0;

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
		// A failed figure's log, behind the pane's OWN button: the frame is a
		// mirror (no pointer events, and a click into it would take the
		// editor's focus, which closes the pane), so the frame's "Show log"
		// could not be clicked (the owner's report) — the frame hides it here
		// (`#mirror`, client.js) and hands the log over with its error.
		this.logRow = document.createElement('div');
		this.logRow.className = 'preview-pane-log';
		this.logRow.hidden = true;
		this.logToggle = document.createElement('button');
		this.logToggle.type = 'button';
		this.logToggle.className = 'preview-pane-log-toggle';
		this.logToggle.textContent = 'Show log';
		this.logText = document.createElement('pre');
		this.logText.className = 'preview-pane-log-text';
		this.logText.hidden = true;
		this.logRow.append(this.logToggle, this.logText);
		// pointerdown is prevented by the base (the editor keeps its focus);
		// the click still arrives.
		this.logToggle.addEventListener('click', () => {
			this.logText.hidden = !this.logText.hidden;
			this.logToggle.textContent = this.logText.hidden ? 'Show log' : 'Hide log';
			this.reposition();
		});
		this.frameUrlSuffix = '#mirror';
		this.append(this.body, this.error, this.logRow);
		this.offLayout = workspaceStore.on('layout-changed', () => this.release());
		this.offSettings = settingsStore.on('settings-changed', (key) => {
			if (key === 'previewPane' && settingsStore.get('previewPane') === 'off') this.release();
		});
	}

	disconnectedCallback() {
		this.destroyPane();
		this.offLayout?.();
		this.offSettings?.();
	}

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
		if (!same) this.#clearError();
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
		this.#clearError();
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

	/** A figure in the frame failed, or came out right (preview-client/figures.js). */
	onFrameMessage(msg) {
		if (msg.type === 'figure-ok') { this.#clearError(); return; }
		if (msg.type !== 'figure-error') return;
		const target = this.#target;
		const view = this.#view;
		if (!target?.text || !view) return;
		const at = locateFigureError(target.text.split('\n'), msg);
		const first = view.state.doc.lineAt(Math.min(target.from, view.state.doc.length)).number;
		const noteLine = at >= 0 ? first + at : null;
		this.#figureError = { message: msg.message, noteLine };
		this.#showLog(msg.log ?? '');
		if (noteLine && noteLine <= view.state.doc.lines) {
			const id = ++this.#markSeq;
			view.dispatch({ effects: setFigureError.of({ pos: view.state.doc.line(noteLine).from, message: msg.message, id }) });
			this.#marked = { view, id };
		}
	}

	#showLog(log) {
		this.logText.textContent = log;
		this.logText.hidden = true;
		this.logToggle.textContent = 'Show log';
		this.logRow.hidden = !log;
	}

	/**
	 * The error is gone (the figure rendered, the cursor left it, the pane
	 * closed): its line mark too. Often called from INSIDE the editor's
	 * update (the plugin tracks the cursor there), where a dispatch is
	 * refused — so the mark is cleared on the next tick, by its id, which
	 * leaves a newer mark alone.
	 */
	#clearError() {
		this.#figureError = null;
		this.#showLog('');
		const marked = this.#marked;
		this.#marked = null;
		if (!marked) return;
		setTimeout(() => {
			if (marked.view.isDestroyed) return;
			try { marked.view.dispatch({ effects: setFigureError.of({ clear: marked.id }) }); } catch { /* the view went */ }
		}, 0);
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
		// Whether its content is taller than the pane (scenarios; Clew-iOS
		// read it to let a drag fall through — which now every pane does).
		this.toggleAttribute('data-overflows', h + padding > MAX_H);
	}

	/**
	 * Against the target: an inline formula ABOVE its line at its own x (it
	 * never covers what is being typed). A display formula or a block NEVER
	 * over its own lines: below its last line, as wide as the text column,
	 * when it fits there; else BESIDE the column, when the window has room
	 * to its right; else below, shrunk to the room there; else not at all.
	 * Hidden while the anchor is off screen.
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
					this.#placeBlock(start, last, column);
				}
			},
		});
	}

	/** A block's pane, kept off the block (reposition). */
	#placeBlock(start, last, column) {
		const winH = window.innerHeight;
		const winW = window.innerWidth;
		this.style.maxHeight = '';
		this.style.width = `${Math.round(column.width)}px`;
		this.style.maxWidth = '';
		const natural = this.getBoundingClientRect().height;
		const below = last.bottom + GAP;
		const roomBelow = winH - 8 - below;
		const roomBeside = winW - 8 - (column.right + GAP);
		let side;
		if (natural <= roomBelow) {
			side = 'below';
			this.style.top = `${Math.round(below)}px`;
			this.style.left = `${Math.round(column.left)}px`;
		} else if (roomBeside >= MIN_BESIDE) {
			side = 'beside';
			const width = Math.min(column.width, roomBeside);
			this.style.width = `${Math.round(width)}px`;
			const h = Math.min(natural, winH - 16);
			this.style.maxHeight = `${Math.round(h)}px`;
			this.style.top = `${Math.round(Math.max(8, Math.min(start.top, winH - 8 - h)))}px`;
			this.style.left = `${Math.round(column.right + GAP)}px`;
		} else if (roomBelow >= MIN_ROOM) {
			side = 'below';
			this.style.maxHeight = `${Math.round(roomBelow)}px`;
			this.style.top = `${Math.round(below)}px`;
			this.style.left = `${Math.round(column.left)}px`;
		} else {
			side = 'none';
			this.style.visibility = 'hidden';
		}
		this.dataset.side = side;
	}

	/** For scenarios: what is showing. */
	describe() {
		return {
			visible: !this.hidden, kind: this.#target?.kind ?? null, lang: this.#target?.lang ?? null,
			side: this.dataset.side ?? null, ready: this.frameReady, src: this.frame.getAttribute('src'),
			svg: this.math.hidden ? null : this.math.querySelector('svg')?.outerHTML ?? null,
			error: this.error.hidden ? null : this.error.textContent, renders: this.#renders,
			figureError: this.#figureError,
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
