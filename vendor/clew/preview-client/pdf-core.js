// The EmbedPDF viewer, shared by every PDF
// surface: note embeds (pdf-embed.js, inside a rendered preview document) and
// the standalone viewer page (pdf-page.js) that the file tab and canvas PDF
// nodes load in an iframe.
//
// Both live on the clew-preview:// origin, and the save bridge is on the APP
// page, which is always window.TOP: a tab's or canvas node's viewer page and a
// note's embed are its children, a canvas SCENE's viewer (canvas-embed.js) a
// grandchild — so saves, dirty reports and their answers go by window.top
// (the Excalidraw page's precedent), never window.parent.
//
// Annotations autosave INTO the vault's PDF file, the way Clew-iOS does it:
// there is no Save button to miss, and the file on disk (and therefore
// Finder, QuickLook, and a synced iPad) is never more than a debounce behind.
import { viewerHandles } from './pdf-handles.js';
// The pen convention (a pen draws, a finger pans) for every viewer built here.
import './pdf-pen.js';

const EMBEDPDF_ASSETS = '/__clew_assets__/embedpdf';
const SAVE_DEBOUNCE_MS = 2500;

// Template literal on purpose: esbuild cannot resolve it, so the ESM bundle
// (and the hashed chunks that resolve relative to its URL) is fetched at
// runtime from our own assets instead of being pulled into this bundle.
let embedPdfPromise = null;
const loadEmbedPdf = () => (embedPdfPromise ??= import(`${EMBEDPDF_ASSETS}/embedpdf.js`));

// ---- save bridge (viewer → app page → main → disk) -------------------------

let saveSeq = 0;
const pendingSaves = new Map();

window.addEventListener('message', (event) => {
	const msg = event.data;
	// From the window the save went to (window.parent), no other.
	if (!msg || msg.source !== 'clew-pdf-host' || msg.type !== 'pdf-save-result' || event.source !== window.top) return;
	const pending = pendingSaves.get(msg.id);
	if (!pending) return;
	pendingSaves.delete(msg.id);
	clearTimeout(pending.timer);
	msg.ok ? pending.resolve() : pending.reject(new Error(msg.error || 'save failed'));
});

function saveToVault(rel, bytes) {
	return new Promise((resolve, reject) => {
		const id = ++saveSeq;
		pendingSaves.set(id, {
			resolve, reject,
			timer: setTimeout(() => {
				pendingSaves.delete(id);
				reject(new Error('save timed out'));
			}, 30_000),
		});
		window.top.postMessage({ source: 'clew-pdf', type: 'pdf-save', id, path: rel, bytes }, '*');
	});
}

// ---- unsaved edits, as the host sees them ----------------------------------
// A document that goes away takes a pending save with it, and nothing it does
// while going — no export, no message — gets out (measured). So the HOST
// keeps a document holding an unsaved edit alive, hidden, until the edit
// lands (renderer/pdf-frames.js). This tells it when that changes, per
// document (a note may embed several PDFs), and saves at once when asked.
const liveHandles = new Set();
let reportedDirty = false;
function reportDirty() {
	const dirty = [...liveHandles].some((h) => h.isDirty());
	if (dirty === reportedDirty) return;
	reportedDirty = dirty;
	window.top.postMessage({ source: 'clew-pdf', type: 'pdf-dirty', dirty }, '*');
}
window.addEventListener('message', (event) => {
	const msg = event.data;
	// From the app page (window.top; renderer/pdf-frames.js asks nested viewers
	// directly) or this document's host.
	if ((event.source !== window.top && event.source !== window.parent)
		|| msg?.source !== 'clew-pdf-host' || msg.type !== 'pdf-flush') return;
	for (const h of liveHandles) h.flush?.();
});

/** clew-preview://vault/<sid>/<path> → the vault-relative <path>. */
export function vaultRelOf(src) {
	const pathname = new URL(src, location.href).pathname;      // /<sid>/<rel>
	const rel = pathname.replace(/^\/[^/]+\//, '');
	return decodeURIComponent(rel);
}

/**
 * Build a viewer in `target` for the PDF at `src`. Returns a handle with
 * dispose(); `onStatus` receives short human-readable states for a status
 * chip ('loading…', '', 'unsaved', 'saving…', 'saved', 'save failed').
 */
export async function createViewer({ target, src, onStatus = () => {} }) {
	const rel = vaultRelOf(src);
	const handle = {
		target, container: null, saveTimer: null,
		// An edit still waiting on the debounce is written before the viewer
		// goes (a note re-rendered without its embed, say), not dropped.
		dispose() {
			this.unlisten?.();
			liveHandles.delete(this);
			viewerHandles.delete(this);
			const pending = this.flush?.();
			clearTimeout(this.saveTimer);
			const destroy = () => this.container?.destroy?.();
			if (pending) pending.finally(destroy);
			else destroy();
			reportDirty();
		},
	};
	const started = performance.now();

	onStatus('loading…');
	const [{ default: EmbedPDF }, buffer] = await Promise.all([
		loadEmbedPdf(),
		fetch(src).then((r) => r.arrayBuffer()),
	]);
	if (!target.isConnected) return handle;   // re-rendered away while loading

	// CJK fallback fonts, if the user has downloaded them (Settings → PDF
	// viewer). null — EmbedPDF's "no fallback, and no CDN either" — otherwise.
	// The endpoint answers null when the setting is off, so the app setting is
	// the only switch and nothing here needs to know about it.
	let fontFallback = null;
	try {
		fontFallback = await fetch('/__clew_assets__/pdffonts/fallback.json').then((r) => r.json());
	} catch { /* no fonts: stay null */ }

	const container = EmbedPDF.init({
		type: 'container',
		target,
		wasmUrl: new URL(`${EMBEDPDF_ASSETS}/pdfium.wasm`, location.href).href,
		fontFallback,                          // local files only, never a CDN
		fonts: { ui: null, signature: null },  // airgapped: no Google Fonts
		theme: { preference: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark' },
		tabBar: 'never',
	});
	if (!container) throw new Error('EmbedPDF.init returned nothing');
	handle.container = container;

	const registry = await container.registry;
	const docManager = registry.getPlugin('document-manager')?.provides();
	if (!docManager) throw new Error('document-manager plugin unavailable');
	// Buffer, not URL: third-party URL loaders allowlist http(s)/blob and read
	// a clew-preview:// path as base64 data (the lesson Clew-iOS paid for).
	await docManager.openDocumentBuffer({
		buffer,
		name: rel.split('/').pop() ?? 'document.pdf',
	}).toPromise();
	onStatus('');

	// The annotation plugin fills its state after the document opens and
	// says so ('loaded'); a PDF with no annotations may say nothing at all.
	let loadedResolve;
	const loaded = new Promise((resolve) => { loadedResolve = resolve; });
	setTimeout(() => loadedResolve(), 5000);

	// ---- annotation autosave ----
	const exportCap = registry.getPlugin('export')?.provides();
	const annotationCap = registry.getPlugin('annotation')?.provides();
	if (exportCap && annotationCap) {
		let saving = false;
		let saveAgain = false;
		const saveNow = async () => {
			if (saving) { saveAgain = true; return; }
			saving = true;
			onStatus('saving…');
			try {
				const bytes = await exportCap.saveAsCopy().toPromise();
				await saveToVault(rel, new Uint8Array(bytes));
				onStatus('saved');
				window.__clewPdfSaves = (window.__clewPdfSaves ?? 0) + 1;
			} catch (err) {
				console.warn('[clew pdf] autosave failed:', err);
				window.__clewPdfSaveError = String(err?.message ?? err);
				onStatus('save failed');
			} finally {
				saving = false;
				if (saveAgain) { saveAgain = false; saveNow(); }
				reportDirty();
			}
		};
		handle.saveNow = saveNow;
		// Unsaved: an edit waiting on the debounce, a save running, or one
		// queued behind it. A FAILED save is not — the host must not keep a
		// frame for ever over an edit that will not land.
		handle.isDirty = () => Boolean(handle.saveTimer) || saving || saveAgain;
		liveHandles.add(handle);
		// The debounce keeps a burst of edits to one write; a pending edit is
		// written at once when the document is hidden or unloads (owner's
		// decision, 2026-09-29). visibilitychange is what this is FOR: a
		// document that lives on hidden (a minimised window; an app WebKit
		// suspends) finishes its save. pagehide is a last try only — a frame
		// being REMOVED fires it, but its async export never completes and
		// no message leaves it (measured), which is why the host keeps such
		// a frame alive until the edit lands (renderer/pdf-frames.js) and
		// asks for this flush itself.
		handle.flush = () => {
			if (!handle.saveTimer) return null;
			clearTimeout(handle.saveTimer);
			handle.saveTimer = null;
			return saveNow();
		};
		const onHidden = () => { if (document.visibilityState === 'hidden') handle.flush(); };
		const onPagehide = () => handle.flush();
		document.addEventListener('visibilitychange', onHidden);
		window.addEventListener('pagehide', onPagehide);
		handle.unlisten = () => {
			document.removeEventListener('visibilitychange', onHidden);
			window.removeEventListener('pagehide', onPagehide);
		};
		annotationCap.onAnnotationEvent((event) => {
			if (event?.type === 'loaded') { loadedResolve(); return; }   // opening a file is not a change
			onStatus('unsaved');
			clearTimeout(handle.saveTimer);
			handle.saveTimer = setTimeout(() => { handle.saveTimer = null; saveNow(); }, SAVE_DEBOUNCE_MS);
			reportDirty();
		});
	}

	// ---- annotations as data (§5.15) ----
	const engine = registry.getEngine?.();
	const scrollCap = registry.getPlugin('scroll')?.provides();
	const doc = () => docManager.getActiveDocument?.();
	const KIND = { 1: 'note', 3: 'freetext', 9: 'highlight', 10: 'underline', 11: 'squiggly', 12: 'strikeout', 15: 'ink' };
	/** The document text under `rects` on a page: the glyphs whose centres
	 *  fall inside, as one slice (the selection plugin's own method). */
	const textUnder = async (pageIndex, rects) => {
		const d = doc();
		if (!engine || !d?.pages?.[pageIndex] || !rects?.length) return '';
		const { runs } = await engine.getPageGeometry(d, d.pages[pageIndex]).toPromise();
		const inside = (x, y) => rects.some((r) => x >= r.origin.x && x <= r.origin.x + r.size.width && y >= r.origin.y && y <= r.origin.y + r.size.height);
		let lo = Infinity;
		let hi = -1;
		for (const run of runs ?? []) {
			run.glyphs.forEach((g, i) => {
				if (inside(g.x + g.width / 2, g.y + g.height / 2)) { lo = Math.min(lo, run.charStart + i); hi = Math.max(hi, run.charStart + i); }
			});
		}
		if (hi < 0) return '';
		const [text] = await engine.getTextSlices(d, [{ pageIndex, charIndex: lo, charCount: hi - lo + 1 }]).toPromise();
		return (text ?? '').replace(/\s+/g, ' ').trim();
	};
	/** Every annotation worth a note: markup, notes, free text, ink — not
	 *  popups, links or replies. Text under a markup annotation from the
	 *  engine; `custom.text` (what the UI stored at creation) as a fallback. */
	handle.listAnnotations = async () => {
		if (!annotationCap) return [];
		await loaded;
		// An edit still waiting on the autosave debounce is written NOW: the
		// note is about to name these annotations, so the PDF must hold them.
		await handle.flush?.();
		const out = [];
		for (const tracked of annotationCap.getAnnotations()) {
			const a = tracked?.object;
			if (!a || tracked.commitState === 'deleted' || !KIND[a.type] || a.inReplyToId) continue;
			const markup = a.type >= 9 && a.type <= 12;
			let text = '';
			if (markup) {
				try { text = await textUnder(a.pageIndex, a.segmentRects?.length ? a.segmentRects : [a.rect]); } catch { text = ''; }
				if (!text && typeof a.custom?.text === 'string') text = a.custom.text;
			}
			out.push({
				id: a.id, page: a.pageIndex + 1, kind: KIND[a.type], text,
				contents: a.contents ?? '', color: a.strokeColor ?? a.color ?? '',
				rect: a.rect,
			});
		}
		// Reading order: page, then top to bottom (EmbedPDF's y grows downward).
		return out.sort((x, y) => x.page - y.page || x.rect.origin.y - y.rect.origin.y || x.rect.origin.x - y.rect.origin.x);
	};
	handle.scrollToPage = (page) => {
		scrollCap?.scrollToPage?.({ pageNumber: Math.max(1, Number(page) || 1), behavior: 'instant' });
	};
	handle.currentPage = () => scrollCap?.getCurrentPage?.() ?? null;
	/**
	 * For scenarios: annotations made from script as the UI makes them — a
	 * highlight over the text run holding `match` on `page` (1-based), or a
	 * sticky note. Autosave then writes them into the PDF, as for any edit.
	 */
	handle.createAnnotations = async (specs) => {
		if (!annotationCap) return 0;
		let made = 0;
		for (const spec of specs) {
			const pageIndex = (spec.page ?? 1) - 1;
			const id = (crypto.randomUUID?.() ?? `${Date.now()}-${made}`);
			if (spec.kind === 'note') {
				annotationCap.createAnnotation(pageIndex, {
					id, type: 1, pageIndex, contents: spec.contents ?? '', strokeColor: '#FFCD45', opacity: 1, name: 0,
					rect: { origin: { x: 60, y: 60 }, size: { width: 24, height: 24 } }, flags: ['print', 'noRotate', 'noZoom'], created: new Date(),
				});
				made += 1;
				continue;
			}
			const d = doc();
			const runs = await engine.getPageTextRects(d, d.pages[pageIndex]).toPromise();
			const run = runs.find((r) => r.content.includes(spec.match));
			if (!run) continue;
			annotationCap.createAnnotation(pageIndex, {
				id, type: 9, pageIndex, rect: run.rect, segmentRects: [run.rect], strokeColor: '#FFCD45', color: '#FFCD45',
				opacity: 1, blendMode: 1, contents: spec.contents ?? '', created: new Date(),
			});
			made += 1;
		}
		await annotationCap.commit?.().toPromise?.();
		return made;
	};

	// Published (pdf-handles.js): the pen convention and the iOS port's own
	// modules act on every live viewer through this set.
	viewerHandles.add(handle);
	// Spike instrumentation.
	window.__clewPdfReady = (window.__clewPdfReady ?? 0) + 1;
	window.__clewPdfLastMs = Math.round(performance.now() - started);
	return handle;
}
