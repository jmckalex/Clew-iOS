// The PDF surface for preview documents on iOS. This file is appended
// verbatim to the preview client by scripts/build.js, so it runs in
// client.js's module scope — `post` (iframe → host bridge) is in scope —
// and its import below resolves relative to vendor/clew/preview-client/
// (the appended-to file), NOT to this file's own directory.
//
// Two surfaces per document:
//
//  - Note embeds (![[x.pdf]]): a live EmbedPDF viewer in the embed box —
//    read, zoom, search, and annotate in place; edits autosave into the
//    vault file (see the inline annotator section below).
//
//  - Canvas-embed scenes: the lazy scrolling PDF.js reader (shared with
//    the app page's canvas nodes via src/preview/pdf-reader-core.js).

import { createPdfReader, vaultRelOf as coreVaultRelOf } from '../../../src/preview/pdf-reader-core.js';

const PDFJS_ASSETS = '/__clew_assets__/pdfjs';
const pdfReader = createPdfReader(PDFJS_ASSETS);
const vaultRelOf = (src) => coreVaultRelOf(src, location.href);

// ---- save bridge (editor → host → native writeBinary) ----------------------

let saveSeq = 0;
const pendingSaves = new Map(); // id -> {resolve, reject, timer}

window.addEventListener('message', (event) => {
	const msg = event.data;
	if (!msg || msg.source !== 'clew-preview-host' || msg.type !== 'clew-pdf-save-result') return;
	const pending = pendingSaves.get(msg.id);
	if (!pending) return;
	pendingSaves.delete(msg.id);
	clearTimeout(pending.timer);
	msg.ok ? pending.resolve() : pending.reject(new Error(msg.error || 'save failed'));
});

const saveToVault = (rel, bytes) => new Promise((resolve, reject) => {
	const id = ++saveSeq;
	pendingSaves.set(id, {
		resolve, reject,
		timer: setTimeout(() => {
			pendingSaves.delete(id);
			reject(new Error('save timed out'));
		}, 30_000),
	});
	post({ type: 'clew-pdf-save', id, rel, bytes });
});

// ---- EmbedPDF inline annotator ---------------------------------------------
// EmbedPDF (MIT; Pdfium-in-wasm; full viewer + annotation chrome) is the
// note-embed PDF surface: each ![[x.pdf]] box hosts a live viewer at
// reading height — read, zoom, search, and annotate in place, no modal
// takeover. Annotation edits autosave into the vault file through the
// clew-pdf-save bridge shortly after the pen lifts, so the file on disk
// (and QuickLook, desktop, iCloud) is never far behind. Airgapped per
// their docs: wasm + chunks from our own assets, external webfonts off.

const EMBEDPDF_ASSETS = '/__clew_assets__/embedpdf';

let embedPdfPromise = null;
// ESM bundle; its hashed chunks resolve relative to this URL.
const loadEmbedPdf = () => embedPdfPromise ??= import(`${EMBEDPDF_ASSETS}/embedpdf.js`);

const INLINE_CSS = `
.clew-pdf-inline { height: 78vh; position: relative; border-radius: 4px; overflow: hidden; }
.clew-pdf-inline-status { float: right; font-size: 0.85em; opacity: 0.7; padding: 2px 8px; }
.clew-pdf-message { padding: 24px; text-align: center; }
`;
function ensureInlineStyles() {
	if (document.getElementById('clew-pdf-inline-css')) return;
	const style = document.createElement('style');
	style.id = 'clew-pdf-inline-css';
	style.textContent = INLINE_CSS;
	document.head.append(style);
}

// Live inline viewers, torn down when a re-render replaces their host.
// Autosave keeps the loss window from an untimely morph ≤ the debounce.
const pdfViewers = new Set();
window.__clewPdfViewers = pdfViewers; // smoke-test hook (see PORT-PLAN kit)
const teardownPdfViewers = () => {
	for (const inst of pdfViewers) {
		if (inst.host.isConnected) continue;
		pdfViewers.delete(inst);
		inst.dispose();
	}
};

// Free-drag annotation tools: while one is active a finger should PAN,
// not draw — the canvas's Pencil convention (once a Pencil has been seen,
// fingers navigate; palms can't scribble). Selection-driven tools
// (highlight, underline, …) and tap-to-place ones keep finger input.
const DRAW_TOOL_IDS = new Set(['ink', 'inkHighlighter', 'circle', 'square',
	'line', 'lineArrow', 'polyline', 'polygon']);

let pencilSeen = false;
document.addEventListener('pointerdown', (e) => {
	if (e.pointerType === 'pen') pencilSeen = true;
}, true);

// One capture-level filter for every inline viewer: swallow finger draws
// while a draw tool is active and turn them into manual pans of the
// viewer's scroller (the annotation layers set touch-action: none, so
// native scrolling cannot take over even though we suppress the event).
let fingerPan = null; // { pointerId, scroller, x, y }
const findScroller = (shadowRoot, x, y) => {
	let el = shadowRoot?.elementFromPoint?.(x, y) ?? null;
	while (el) {
		if (el.scrollHeight > el.clientHeight + 1) {
			const overflow = getComputedStyle(el).overflowY;
			if (overflow === 'auto' || overflow === 'scroll') return el;
		}
		el = el.parentElement ?? el.getRootNode()?.host ?? null;
	}
	return null;
};
document.addEventListener('pointerdown', (e) => {
	if (e.pointerType !== 'touch' || !pencilSeen || fingerPan) return;
	const inst = [...pdfViewers].find((v) =>
		v.drawToolActive && v.container && e.composedPath().includes(v.host));
	if (!inst) return;
	const scroller = findScroller(inst.container.shadowRoot, e.clientX, e.clientY);
	if (!scroller) return;
	e.stopImmediatePropagation();
	e.preventDefault();
	fingerPan = { pointerId: e.pointerId, scroller, x: e.clientX, y: e.clientY };
}, true);
document.addEventListener('pointermove', (e) => {
	if (!fingerPan || e.pointerId !== fingerPan.pointerId) return;
	e.stopImmediatePropagation();
	e.preventDefault();
	fingerPan.scroller.scrollLeft += fingerPan.x - e.clientX;
	fingerPan.scroller.scrollTop += fingerPan.y - e.clientY;
	fingerPan.x = e.clientX;
	fingerPan.y = e.clientY;
}, true);
for (const type of ['pointerup', 'pointercancel']) {
	document.addEventListener(type, (e) => {
		if (!fingerPan || e.pointerId !== fingerPan.pointerId) return;
		e.stopImmediatePropagation();
		fingerPan = null;
	}, true);
}

function mountInlinePdf(embed) {
	ensureInlineStyles();
	const src = embed.getAttribute('src');
	const rel = vaultRelOf(src);
	const host = document.createElement('div');
	host.className = 'clew-pdf-inline';
	embed.replaceWith(host);
	const titleBar = host.closest('.pdf-embed-box')?.querySelector('.embed-title');
	let statusEl = titleBar?.querySelector('.clew-pdf-inline-status');
	if (titleBar && !statusEl) {
		statusEl = document.createElement('span');
		statusEl.className = 'clew-pdf-inline-status';
		titleBar.append(statusEl);
	}
	const setStatus = (text) => { if (statusEl) statusEl.textContent = text; };
	// Lazy: a note can hold several PDFs and each viewer is its own Pdfium
	// engine, so spin one up only when its box approaches the viewport.
	const observer = new IntersectionObserver((entries) => {
		if (!entries.some((entry) => entry.isIntersecting)) return;
		observer.disconnect();
		initInlinePdf(host, src, rel, setStatus);
	}, { rootMargin: '100% 0%' });
	observer.observe(host);
}

async function initInlinePdf(host, src, rel, setStatus) {
	const inst = {
		host,
		container: null,
		drawToolActive: false,
		saveTimer: null,
		dispose() { clearTimeout(this.saveTimer); },
	};
	pdfViewers.add(inst);
	try {
		setStatus('loading…');
		const [{ default: EmbedPDF }, buffer] = await Promise.all([
			loadEmbedPdf(),
			fetch(src).then((response) => response.arrayBuffer()),
		]);
		if (!host.isConnected) return; // re-rendered away while loading
		const container = EmbedPDF.init({
			type: 'container',
			target: host,
			wasmUrl: new URL(`${EMBEDPDF_ASSETS}/pdfium.wasm`, location.href).href,
			fontFallback: null, // airgapped: no jsDelivr fonts
			fonts: { ui: null, signature: null }, // airgapped: no Google Fonts
			theme: { preference: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark' },
			tabBar: 'never',
		});
		if (!container) throw new Error('EmbedPDF.init returned nothing');
		inst.container = container;
		const registry = await container.registry;
		const docManager = registry.getPlugin('document-manager')?.provides();
		if (!docManager) throw new Error('document-manager plugin unavailable');
		// Buffer, not src URL: URL loaders allowlist http(s)/blob and
		// mistake a clew-preview:// path for base64 data.
		await docManager.openDocumentBuffer({
			buffer,
			name: rel.split('/').pop() ?? 'document.pdf',
		}).toPromise();
		setStatus('');

		// Autosave into the vault shortly after each committed annotation
		// change — QuickLook's edit-in-place model, no Save button to miss.
		const exportCap = registry.getPlugin('export')?.provides();
		const annotationCap = registry.getPlugin('annotation')?.provides();
		if (!exportCap || !annotationCap) throw new Error('export/annotation plugin unavailable');
		let saving = false;
		let saveAgain = false;
		const saveNow = async () => {
			if (saving) { saveAgain = true; return; }
			saving = true;
			setStatus('saving…');
			try {
				const bytes = await exportCap.saveAsCopy().toPromise();
				await saveToVault(rel, new Uint8Array(bytes));
				setStatus('saved');
			} catch (err) {
				console.warn('[clew pdf] autosave failed:', err);
				setStatus('save failed');
			} finally {
				saving = false;
				if (saveAgain) { saveAgain = false; saveNow(); }
			}
		};
		annotationCap.onAnnotationEvent((event) => {
			if (event.type === 'loaded') return; // opening isn't a change
			setStatus('unsaved');
			clearTimeout(inst.saveTimer);
			inst.saveTimer = setTimeout(saveNow, 2500);
		});
		annotationCap.onActiveToolChange((event) => {
			// Scope-level hooks hand over the tool, capability-level ones
			// wrap it in { tool } — accept either shape.
			const tool = event && typeof event === 'object' && 'tool' in event ? event.tool : event;
			inst.drawToolActive = !!tool && DRAW_TOOL_IDS.has(tool.id);
		});
	} catch (err) {
		console.warn('[clew pdf] inline viewer failed:', err);
		setStatus('viewer failed');
		const message = document.createElement('div');
		message.className = 'clew-pdf-message';
		message.textContent = `PDF viewer failed: ${err?.message ?? err}`;
		host.replaceChildren(message);
	}
}

// ---- embed wiring -----------------------------------------------------------

// Canvas-embed scenes build asynchronously after clew:render, so PDFs
// inside them are upgraded from a MutationObserver sweep, not just init.
const upgradeScenePdfs = () => {
	for (const embed of document.querySelectorAll('.canvas-embed-scene embed[type="application/pdf"]')) {
		const src = embed.getAttribute('src');
		const host = document.createElement('div');
		host.className = 'clew-pdf-scene';
		host.style.cssText = 'width: 100%; height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch; background: white;';
		embed.replaceWith(host);
		pdfReader.mount(host, src);
	}
};
let sceneSweep = null;
new MutationObserver(() => {
	clearTimeout(sceneSweep);
	sceneSweep = setTimeout(upgradeScenePdfs, 100);
}).observe(document.body, { childList: true, subtree: true });

const clewPdfInit = () => {
	pdfReader.teardown((state) => !state.host.isConnected);
	teardownPdfViewers();
	for (const embed of document.querySelectorAll('.pdf-embed-box embed.pdf-embed')) {
		mountInlinePdf(embed);
	}
	upgradeScenePdfs();
};
clewPdfInit();
document.addEventListener('clew:render', clewPdfInit);
