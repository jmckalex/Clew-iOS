// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The pen convention for every PDF viewer (items 10+11; the iOS port's
// module, upstreamed — pdf-core.js imports it, so it runs in whichever
// document a viewer lives in: a note preview or the viewer page).
//
// The rule, borrowed from the canvas: once a PEN has been seen in this
// document, a FINGER navigates and only the pen draws. Without it, picking up
// a drawing tool means every scroll leaves a stray mark and a resting palm
// scribbles; with it the tool stays armed for the pen while fingers pan.
//
// Self-arming: nothing happens until a `pen` pointerdown, and only `touch`
// pointers are ever redirected — a mouse is never affected, and a device that
// has not used a pen behaves exactly as before. (Windows pen-and-touch
// screens would arm it the same way: UNTESTED there.)
//
// The pan is driven by hand: EmbedPDF's annotation layers set
// `touch-action: none` while a tool is active, so suppressing the pointer
// event leaves nothing to scroll natively. We find the scroller under the
// finger and move it ourselves.
import { viewerHandles } from './pdf-handles.js';

/** Free-drag tools, which draw along the pointer's path — a finger stroke
 *  would become a mark. Selection-driven tools (highlight, underline, …) and
 *  tap-to-place ones (stamp, signature) need a finger tap to work at all. */
const DRAW_TOOLS = new Set(['ink', 'inkHighlighter', 'circle', 'square',
	'line', 'lineArrow', 'polyline', 'polygon']);

// handle → annotation capability, resolved ahead of time: `registry` is a
// PROMISE, and a pointerdown must decide synchronously whether it is a pan.
const caps = new WeakMap();
const pending = new WeakSet();

function resolveCap(handle) {
	if (caps.has(handle) || pending.has(handle)) return;
	pending.add(handle);
	Promise.resolve(handle.container?.registry)
		.then((registry) => {
			const cap = registry?.getPlugin('annotation')?.provides();
			if (cap?.getActiveTool) caps.set(handle, cap);
		})
		.catch((err) => console.warn('[clew pdf] annotation capability unavailable:', err))
		.finally(() => pending.delete(handle));
}

/** A free-drag tool armed on this viewer now? Asked of the capability, not
 *  tracked from change events: a lazily subscribed listener never hears of
 *  the tool that was already selected. */
function isDrawing(handle) {
	const cap = caps.get(handle);
	if (!cap) return false;
	try {
		const tool = cap.getActiveTool();
		return Boolean(tool) && DRAW_TOOLS.has(tool.id);
	} catch {
		return false;
	}
}

const syncHandles = () => {
	for (const handle of viewerHandles) resolveCap(handle);
};

let penSeen = false;

document.addEventListener('pointerdown', (e) => {
	if (e.pointerType !== 'pen') return;
	penSeen = true;
	syncHandles();
}, true);
document.addEventListener('clew:render', syncHandles);

/** The nearest scrollable ancestor of the point, inside the viewer's shadow DOM. */
function scrollerAt(shadowRoot, x, y) {
	let el = shadowRoot?.elementFromPoint?.(x, y) ?? null;
	while (el) {
		if (el.scrollHeight > el.clientHeight + 1) {
			const overflow = getComputedStyle(el).overflowY;
			if (overflow === 'auto' || overflow === 'scroll') return el;
		}
		el = el.parentElement ?? el.getRootNode()?.host ?? null;
	}
	return null;
}

let pan = null; // { pointerId, scroller, x, y }

document.addEventListener('pointerdown', (e) => {
	if (e.pointerType !== 'touch' || !penSeen || pan) return;
	syncHandles();
	const handle = [...viewerHandles].find((h) =>
		h.container && e.composedPath().includes(h.target) && isDrawing(h));
	if (!handle) return;
	const scroller = scrollerAt(handle.container.shadowRoot, e.clientX, e.clientY);
	if (!scroller) return;
	e.stopImmediatePropagation();
	e.preventDefault();
	pan = { pointerId: e.pointerId, scroller, x: e.clientX, y: e.clientY };
}, true);

document.addEventListener('pointermove', (e) => {
	if (!pan || e.pointerId !== pan.pointerId) return;
	e.stopImmediatePropagation();
	e.preventDefault();
	pan.scroller.scrollLeft += pan.x - e.clientX;
	pan.scroller.scrollTop += pan.y - e.clientY;
	pan.x = e.clientX;
	pan.y = e.clientY;
}, true);

for (const type of ['pointerup', 'pointercancel']) {
	document.addEventListener(type, (e) => {
		if (!pan || e.pointerId !== pan.pointerId) return;
		e.stopImmediatePropagation();
		pan = null;
	}, true);
}

// Smoke hooks (the iOS module's names): `armed` — a pen has been seen;
// `watching` — viewers with a resolved annotation capability; `drawing` —
// viewers with a free-drag tool selected; `sync()` resolves capabilities now.
window.__clewPdfTouch = {
	get armed() { return penSeen; },
	get watching() { return [...viewerHandles].filter((h) => caps.has(h)).length; },
	get drawing() { return [...viewerHandles].filter(isDrawing).length; },
	sync: syncHandles,
};
