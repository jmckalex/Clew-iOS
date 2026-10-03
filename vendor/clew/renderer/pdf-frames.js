// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later


// PDF viewer frames that hold an unsaved annotation, and keeping them alive
// until it lands (owner's decision 2026-09-29: the host-assisted flush).
//
// The viewer autosaves 2.5 s after an edit, and a frame that is REMOVED takes
// a pending save with it: the export is async and never completes, and not
// even a synchronous postMessage from its pagehide reaches this page
// (measured). So the frame must not be removed while it holds an edit.
// Every viewer document reports its state ('pdf-dirty', preview-client/
// pdf-core.js); whatever is about to remove a view asks retire() instead,
// which keeps the view — hidden, inert, marked data-clew-retiring — tells its
// frames to save NOW ('pdf-flush'), and removes it once they report clean.
// The next view shows at once; only the old one lingers, invisibly.
//
// Closing is the other way a frame goes: a close guard waits (briefly) for
// the closing tab's frames, and the window's close handshake waits for all
// of them (office-dock.js#onCloseRequested).
import { workspaceStore } from './state/workspace-store.js';
import { fromPreviewOrigin, PREVIEW_ORIGIN } from '../shared/message-guard.js';

/** A lingering view waits at most this long; a normal save takes ~10 ms. */
const LINGER_MS = 10_000;
/** A close waits at most this long before going ahead anyway. */
const CLOSE_WAIT_MS = 3_000;

const dirty = new Set();   // WindowProxy of each viewer document reporting unsaved edits
const waiters = new Set(); // re-checked on every report

window.addEventListener('message', (event) => {
	const msg = event.data;
	// Only a viewer on the preview origin (shared/message-guard.js).
	if (!msg || msg.source !== 'clew-pdf' || msg.type !== 'pdf-dirty' || !fromPreviewOrigin(event)) return;
	if (msg.dirty) dirty.add(event.source);
	else dirty.delete(event.source);
	for (const check of [...waiters]) check();
});

/**
 * Whether `frame` holds the viewer document `win`: it IS the frame's
 * document, or lives somewhere under it — a canvas scene's viewer is a frame
 * inside a note's frame, and reports to this window directly (pdf-core.js
 * posts to window.top). `parent` is readable across origins.
 */
function holds(frame, win) {
	const own = frame.contentWindow;
	if (!own) return false;
	for (let w = win, depth = 0; w && depth < 8; depth++) {
		if (w === own) return true;
		let up = null;
		try { up = w.parent; } catch { return false; }
		if (!up || up === w) return false;
		w = up;
	}
	return false;
}

/** The dirty viewer documents that `frames` hold. */
const dirtyUnder = (frames) => [...dirty].filter((win) => frames.some((f) => holds(f, win)));

/** The frames at or under `root` whose PDF viewers hold an unsaved edit. */
export function unsavedFrames(root) {
	const frames = root instanceof HTMLIFrameElement ? [root] : [...root.querySelectorAll('iframe')];
	return frames.filter((f) => [...dirty].some((win) => holds(f, win)));
}

/** Resolves once none of `frames` holds an unsaved edit, or after `ms`. */
function flushed(frames, ms) {
	// Asked of each dirty VIEWER, however deep: a note's frame does not pass
	// a flush on to a scene's viewer inside it, and need not.
	for (const win of dirtyUnder(frames)) {
		try { win.postMessage({ source: 'clew-pdf-host', type: 'pdf-flush' }, PREVIEW_ORIGIN); } catch { /* gone */ }
	}
	return new Promise((resolve) => {
		const finish = (clean) => {
			waiters.delete(check);
			clearTimeout(timer);
			resolve(clean);
		};
		const check = () => { if (dirtyUnder(frames).length === 0) finish(true); };
		const timer = setTimeout(() => finish(false), ms);
		waiters.add(check);
		check();
	});
}

/**
 * Remove `el` — unless a PDF viewer inside it holds an unsaved edit, in which
 * case it is kept, hidden, until that edit is written, then removed. Returns
 * whether it was kept (the caller must then leave it alone).
 */
export function retire(el) {
	const frames = unsavedFrames(el);
	if (frames.length === 0) {
		el.remove();
		return false;
	}
	el.setAttribute('data-clew-retiring', '');
	el.style.display = 'none';   // display:none keeps an iframe loaded
	el.inert = true;
	flushed(frames, LINGER_MS).then(() => {
		for (const win of dirtyUnder(frames)) dirty.delete(win);
		el.remove();
	});
	return true;
}

/** Every viewer in the window saves now; resolves when all are clean (or after `ms`). */
export function flushAllPdf(ms = CLOSE_WAIT_MS) {
	const frames = unsavedFrames(document);
	return frames.length === 0 ? Promise.resolve(true) : flushed(frames, ms);
}

export function hasUnsavedPdf() {
	return unsavedFrames(document).length > 0;
}

// Closing a tab (or a pane, whose element goes away whole): wait for the
// closing tab's frames. Only its RENDERED view can hold one — a background
// tab has no frames at all.
workspaceStore.registerCloseGuard((tab) => {
	const view = [...document.querySelectorAll('.tab-body > :not([data-clew-retiring])')].find((v) => v.tabId === tab.id);
	const frames = view ? unsavedFrames(view) : [];
	return frames.length ? flushed(frames, CLOSE_WAIT_MS).then(() => true) : null;
});
