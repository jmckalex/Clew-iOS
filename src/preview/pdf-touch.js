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

// Handles whose annotation capability we have already subscribed to, and
// whether a free-drag tool is currently active on each.
const clewToolState = new WeakMap(); // handle -> { drawing: boolean }

async function clewWatchTools(handle) {
	if (clewToolState.has(handle)) return;
	const state = { drawing: false };
	clewToolState.set(handle, state);
	try {
		const registry = await handle.container?.registry;
		const annotationCap = registry?.getPlugin('annotation')?.provides();
		if (!annotationCap?.onActiveToolChange) return;
		annotationCap.onActiveToolChange((event) => {
			// Scope-level hooks hand over the tool itself, capability-level
			// ones wrap it in { tool } — accept either shape.
			const tool = event && typeof event === 'object' && 'tool' in event ? event.tool : event;
			state.drawing = !!tool && CLEW_DRAW_TOOL_IDS.has(tool.id);
		});
	} catch (err) {
		console.warn('[clew pdf] tool watch failed:', err);
	}
}

let clewPencilSeen = false;
document.addEventListener('pointerdown', (e) => {
	if (e.pointerType === 'pen') clewPencilSeen = true;
}, true);

// Subscribe to viewers as they appear. Handles are created asynchronously
// (lazily, as an embed nears the viewport), so poll the published set on the
// pointer events we already handle rather than adding a timer.
const clewSyncHandles = () => {
	for (const handle of clewPdfHandles()) clewWatchTools(handle);
};

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
		clewToolState.get(h)?.drawing && h.container && e.composedPath().includes(h.target));
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

// Smoke hook: `window.__clewPdfTouch.armed` says whether a Pencil has been
// seen, `.watching` how many viewers the layer has hooked.
window.__clewPdfTouch = {
	get armed() { return clewPencilSeen; },
	get watching() { return [...clewPdfHandles()].filter((h) => clewToolState.has(h)).length; },
};
