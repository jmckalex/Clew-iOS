// Apple Pencil convention for every EmbedPDF surface. Appended by
// scripts/build.js to BOTH preview-side bundles — client.js (note embeds) and
// pdf-page.js (the file tab's and canvas nodes' viewer page) — so it runs in
// whichever document the viewer lives in.
//
// The rule, borrowed from the canvas: once a Pencil has been seen in this
// document, a FINGER navigates and only the Pencil draws. Without it, picking
// up an annotation tool means every scroll leaves a stray mark and a resting
// palm scribbles; with it the tool stays armed for the pen while fingers still
// pan, which is how drawing on an iPad is expected to feel.
//
// Self-arming: nothing happens until a `pen` pointerdown occurs, so a device
// with no Pencil (and desktop, if this ever went upstream) behaves exactly as
// it does now.
//
// The pan has to be driven by hand. EmbedPDF's annotation layers set
// `touch-action: none` while a tool is active, so suppressing the pointer
// event is not enough for native scrolling to take over — there is nothing to
// take over. We find the scroller under the finger and move it ourselves.

// Free-drag tools: these draw along the pointer's path, so a finger stroke
// would become a mark. Selection-driven tools (highlight, underline, squiggly,
// strikeout) and tap-to-place ones (stamp, signature) are left alone — they
// need a finger tap to be usable at all.
const CLEW_DRAW_TOOL_IDS = new Set(['ink', 'inkHighlighter', 'circle', 'square',
	'line', 'lineArrow', 'polyline', 'polygon']);

// Viewer handles published by pdf-core.js (build-time patch). Each is
// { target, container, … }; `container.shadowRoot` hosts the scrollers and
// `container.registry` resolves to the plugin registry.
const clewPdfHandles = () => window.__clewPdfHandles ?? new Set();

// handle -> annotation capability. The capability is reached through
// `container.registry`, which is a PROMISE, so it is resolved ahead of time
// and cached: a pointerdown has to decide synchronously whether this touch
// is a pan or a draw.
const clewCaps = new WeakMap();
const clewCapPending = new WeakSet();

function clewResolveCap(handle) {
	if (clewCaps.has(handle) || clewCapPending.has(handle)) return;
	clewCapPending.add(handle);
	Promise.resolve(handle.container?.registry)
		.then((registry) => {
			const cap = registry?.getPlugin('annotation')?.provides();
			if (cap?.getActiveTool) clewCaps.set(handle, cap);
		})
		.catch((err) => console.warn('[clew pdf] annotation capability unavailable:', err))
		.finally(() => clewCapPending.delete(handle));
}

/**
 * Is a free-drag tool armed on this viewer right now?
 *
 * Asked of the capability directly rather than tracked from
 * onActiveToolChange. A change event only fires on a CHANGE: subscribing
 * lazily (which is what a touch-driven layer does) means the tool that was
 * already selected is invisible, so the first finger after arming would draw
 * instead of panning — precisely the stroke a user notices.
 */
function clewIsDrawing(handle) {
	const cap = clewCaps.get(handle);
	if (!cap) return false;
	try {
		const tool = cap.getActiveTool();
		return !!tool && CLEW_DRAW_TOOL_IDS.has(tool.id);
	} catch {
		return false;
	}
}

let clewPencilSeen = false;

// Resolve capabilities for whatever viewers exist now. Handles appear
// asynchronously (lazily, as an embed nears the viewport), so this runs at
// every moment that plausibly precedes a pan.
const clewSyncHandles = () => {
	for (const handle of clewPdfHandles()) clewResolveCap(handle);
};

document.addEventListener('pointerdown', (e) => {
	if (e.pointerType !== 'pen') return;
	// Arming and capability resolution happen on the SAME event, well before
	// the finger that will want to pan.
	clewPencilSeen = true;
	clewSyncHandles();
}, true);

document.addEventListener('clew:render', clewSyncHandles);

/** The nearest scrollable ancestor of the point, inside the viewer's shadow DOM. */
function clewFindScroller(shadowRoot, x, y) {
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

let clewFingerPan = null; // { pointerId, scroller, x, y }

document.addEventListener('pointerdown', (e) => {
	if (e.pointerType !== 'touch' || !clewPencilSeen || clewFingerPan) return;
	clewSyncHandles();
	const handle = [...clewPdfHandles()].find((h) =>
		h.container && e.composedPath().includes(h.target) && clewIsDrawing(h));
	if (!handle) return;
	const scroller = clewFindScroller(handle.container.shadowRoot, e.clientX, e.clientY);
	if (!scroller) return;
	e.stopImmediatePropagation();
	e.preventDefault();
	clewFingerPan = { pointerId: e.pointerId, scroller, x: e.clientX, y: e.clientY };
}, true);

document.addEventListener('pointermove', (e) => {
	if (!clewFingerPan || e.pointerId !== clewFingerPan.pointerId) return;
	e.stopImmediatePropagation();
	e.preventDefault();
	clewFingerPan.scroller.scrollLeft += clewFingerPan.x - e.clientX;
	clewFingerPan.scroller.scrollTop += clewFingerPan.y - e.clientY;
	clewFingerPan.x = e.clientX;
	clewFingerPan.y = e.clientY;
}, true);

for (const clewEndType of ['pointerup', 'pointercancel']) {
	document.addEventListener(clewEndType, (e) => {
		if (!clewFingerPan || e.pointerId !== clewFingerPan.pointerId) return;
		e.stopImmediatePropagation();
		clewFingerPan = null;
	}, true);
}

// Smoke hooks: `armed` says whether a Pencil has been seen, `watching` how
// many viewers have a resolved annotation capability, and `drawing` how many
// currently have a free-drag tool selected. `sync()` forces resolution so a
// smoke test need not fake a pen event first.
window.__clewPdfTouch = {
	get armed() { return clewPencilSeen; },
	get watching() { return [...clewPdfHandles()].filter((h) => clewCaps.has(h)).length; },
	get drawing() { return [...clewPdfHandles()].filter(clewIsDrawing).length; },
	sync: clewSyncHandles,
};
