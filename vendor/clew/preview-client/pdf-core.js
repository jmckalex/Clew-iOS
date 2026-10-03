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
import { topOrigin, postTo } from '../shared/message-guard.js';
import { bandNumbers, edgeRuns, textPageOffset, usefulPageLabels } from '../shared/pdf-quote.js';
import { installQuietNavigator } from './pdf-quiet-nav.js';

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
		postTo(window.top, { source: 'clew-pdf', type: 'pdf-save', id, path: rel, bytes }, topOrigin());
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
	postTo(window.top, { source: 'clew-pdf', type: 'pdf-dirty', dirty }, topOrigin());
}
window.addEventListener('message', (event) => {
	const msg = event.data;
	// From the app page (window.top; renderer/pdf-frames.js asks nested viewers
	// directly) or this document's host.
	if ((event.source !== window.top && event.source !== window.parent)
		|| msg?.source !== 'clew-pdf-host' || msg.type !== 'pdf-flush') return;
	for (const h of liveHandles) h.flush?.();
});

// ---- quote-and-cite (FEATURE-IDEAS #2) -------------------------------------
// The app page (renderer/pdf-quote.js) puts the text selected in a PDF into
// the note being written. It needs to know WHERE a selection is — each
// document says when it gains or loses one (`pdf-selection`), and the app
// keeps the newest — and then the text: asked for by the app's command
// (`pdf-quote-request`), or sent unasked by the "Quote in note" item each
// viewer adds to EmbedPDF's selection menu. Either way the answer is one
// `pdf-quote` message.
let quoting = null;           // the viewer in this document with the newest selection
let reportedSelection = false;
function noteSelection(handle, has) {
	if (has) quoting = handle;
	else if (quoting === handle) quoting = null;
	if (has || reportedSelection !== Boolean(quoting)) {
		reportedSelection = Boolean(quoting);
		postTo(window.top, { source: 'clew-pdf', type: 'pdf-selection', has: reportedSelection }, topOrigin());
	}
}
window.addEventListener('message', (event) => {
	const msg = event.data;
	if (event.source !== window.top || msg?.source !== 'clew-pdf-host') return;
	if (msg.type === 'pdf-quote-request') {
		if (quoting) quoting.sendQuote(msg.requestId);
		else postTo(window.top, { source: 'clew-pdf', type: 'pdf-quote', requestId: msg.requestId, empty: true }, topOrigin());
	}
	// The page in view and what it is printed as — for "PDF: set the printed
	// page number…" (renderer/pdf-quote.js), asked of a tab's viewer.
	if (msg.type === 'pdf-current-page') {
		const handle = quoting ?? [...viewerHandles].find((h) => h.currentPage);
		const reply = (page, label = null, textOffset = null) => postTo(window.top, {
			source: 'clew-pdf', type: 'pdf-current-page', requestId: msg.requestId, path: handle?.path ?? null, page, label, textOffset,
		}, topOrigin());
		if (!handle) reply(null);
		else {
			const page = handle.currentPage?.() ?? null;
			(async () => {
				const label = page ? (await handle.pageLabels())?.[page - 1] ?? null : null;
				reply(page, label, await handle.textOffset().catch(() => null));
			})().catch(() => reply(page));
		}
	}
	// For scenarios (smoke/pdf-nav-scenario.js): the page navigator's state —
	// its opacity as drawn, its box in this document, whether it holds the
	// keyboard focus; `focus`/`blur` move the focus into its page field or
	// out first.
	if (msg.type === 'test-nav') {
		const root = [...viewerHandles].find((h) => h.container?.shadowRoot)?.container.shadowRoot;
		const pill = root?.querySelector('[data-overlay-id="page-controls"]');
		if (msg.focus) pill?.querySelector('input')?.focus();
		if (msg.blur) root?.activeElement?.blur?.();
		// A synthetic touch tap at a point in this document (the harness has
		// no touch input): the host hears it as a finger's pointerdown.
		if (msg.tap) {
			const host = root.host;
			host.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', clientX: msg.tap.x, clientY: msg.tap.y, bubbles: true, composed: true }));
		}
		const box = pill?.firstElementChild?.firstElementChild;
		const r = box?.getBoundingClientRect();
		postTo(window.top, {
			source: 'clew-pdf', type: 'test-nav', requestId: msg.requestId,
			opacity: box ? Number(getComputedStyle(box).opacity) : null,
			rect: r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null,
			focused: Boolean(pill?.matches(':has(:focus-visible)')),
		}, topOrigin());
	}
	// For scenarios (smoke/pdf-quote-scenario.js): select `match` on `page`,
	// through to `to.match` on `to.page` — EmbedPDF's own setSelection, which
	// is what a drag ends in, so its selection menu appears as for a drag.
	if (msg.type === 'test-select-text') {
		const handle = [...viewerHandles].find((h) => h.selectText);
		const reply = (ok, text = null) => postTo(window.top, { source: 'clew-pdf', type: 'test-selected', ok, text }, topOrigin());
		if (!handle) reply(false);
		else {
			handle.selectText(msg.page, msg.match, msg.to)
				.then(async (ok) => reply(ok, ok ? (await handle.selectedQuote())?.text ?? null : null), () => reply(false));
		}
	}
});
// A quotation-mark icon for the menu item, drawn here (no icon set copied).
const QUOTE_ICON = {
	viewBox: '0 0 24 24',
	strokeLinecap: 'round',
	strokeLinejoin: 'round',
	paths: [
		{ d: 'M5 7h4v5H5z M9 12c0 2.8-1.4 4.4-4 5', stroke: 'currentColor', fill: 'none', strokeWidth: 2 },
		{ d: 'M14 7h4v5h-4z M18 12c0 2.8-1.4 4.4-4 5', stroke: 'currentColor', fill: 'none', strokeWidth: 2 },
	],
};

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
 *
 * `readonly` (a web PDF — docs/dev/pdf-unification.md §4): somebody else's
 * document, cached on the device, so nothing is ever saved into it —
 * EmbedPDF's annotation and redaction features are switched off by its own
 * configuration (no fork change) and the autosave is never installed.
 * `buffer`, when the caller has already fetched the bytes, skips the fetch.
 */
export async function createViewer({ target, src, onStatus = () => {}, readonly = false, buffer: given = null, name = null }) {
	const rel = vaultRelOf(src);
	const handle = {
		target, container: null, saveTimer: null, path: rel, readonly,
		// An edit still waiting on the debounce is written before the viewer
		// goes (a note re-rendered without its embed, say), not dropped.
		dispose() {
			this.unlisten?.();
			this.unquote?.();
			this.unquiet?.();
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
		given ?? fetch(src).then((r) => r.arrayBuffer()),
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
		// The stamp tool's default library (@embedpdf/default-stamps, MIT,
		// served from __clew_assets__/stamps) — EmbedPDF fetches it from
		// cdn.jsdelivr.net otherwise, on every open: an outbound request the
		// preview CSP now blocks in a note (frame-bridge.md §4.9a). Built from
		// location.origin, not URL(): `{locale}` must reach EmbedPDF unescaped.
		stamp: { manifests: [{ url: `${location.origin}/__clew_assets__/stamps/{locale}/manifest.json`, fallbackLocale: 'en' }] },
		theme: { preference: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark' },
		tabBar: 'never',
		icons: { clewQuote: QUOTE_ICON },
		...(readonly ? { disabledCategories: ['annotation', 'redaction'] } : {}),
	});
	if (!container) throw new Error('EmbedPDF.init returned nothing');
	handle.container = container;

	const registry = await container.registry;
	// The page navigator shows when asked for, not on every scroll.
	handle.unquiet = installQuietNavigator(container);
	const docManager = registry.getPlugin('document-manager')?.provides();
	if (!docManager) throw new Error('document-manager plugin unavailable');
	// Buffer, not URL: third-party URL loaders allowlist http(s)/blob and read
	// a clew-preview:// path as base64 data (the lesson Clew-iOS paid for).
	await docManager.openDocumentBuffer({
		buffer,
		name: name ?? rel.split('/').pop() ?? 'document.pdf',
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
	if (exportCap && annotationCap && !readonly) {
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
	// The selection, for quote-and-cite: its text (one string per page) and
	// the first page it touches, 1-based.
	const selectionCap = registry.getPlugin('selection')?.provides();
	handle.selectedQuote = async () => {
		const formatted = selectionCap?.getFormattedSelection?.() ?? [];
		if (!formatted.length) return null;
		const text = await selectionCap.getSelectedText().toPromise();
		return { page: Math.min(...formatted.map((f) => f.pageIndex)) + 1, text };
	};
	/** [first, last] char index of `match` on `page` (1-based) — a string,
	 *  or { index, length } — or null. Searched run by run: the page's text
	 *  as one slice carries line breaks (CRLF) that are no char index. */
	const charsOf = async (page, match) => {
		const d = doc();
		const pageIndex = page - 1;
		if (!engine || !d?.pages?.[pageIndex]) return null;
		if (typeof match === 'object' && match) return [match.index, match.index + match.length - 1];
		const { runs } = await engine.getPageGeometry(d, d.pages[pageIndex]).toPromise();
		const slices = (runs ?? []).map((r) => ({ pageIndex, charIndex: r.charStart, charCount: r.glyphs.length }));
		const texts = slices.length ? await engine.getTextSlices(d, slices).toPromise() : [];
		let all = '';
		const index = [];
		texts.forEach((t, i) => {
			[...(t ?? '')].forEach((c, j) => { all += c; index.push(slices[i].charIndex + j); });
		});
		const at = all.indexOf(match);
		return at < 0 ? null : [index[at], index[at + match.length - 1]];
	};
	handle.selectText = async (page, match, to = null) => {
		const start = await charsOf(page, match);
		const end = to ? await charsOf(to.page, to.match) : start;
		if (!start || !end || !selectionCap?.setSelection) return false;
		await selectionCap.setSelection({ start: { page: page - 1, index: start[0] }, end: { page: (to?.page ?? page) - 1, index: end[1] } }).toPromise();
		return true;
	};
	// What its pages are PRINTED as (quote-and-cite cites that, not the PDF
	// page; shared/pdf-quote.js#printedPage decides between them): the
	// document's /PageLabels through the fork's getPageLabels, cleaned (null
	// when it has none, when they say nothing, or on a build without the
	// method); and the offset its header and footer numbers agree on. Each
	// asked once per viewer.
	let labelsTask = null;
	handle.pageLabels = () => (labelsTask ??= (async () => {
		const d = doc();
		if (!engine?.getPageLabels || !d) return null;
		try { return usefulPageLabels(await engine.getPageLabels(d).toPromise()); } catch { return null; }
	})());
	let offsetTask = null;
	handle.textOffset = () => (offsetTask ??= (async () => {
		const d = doc();
		const count = d?.pages?.length ?? 0;
		if (!engine?.getPageGeometry || !engine.getTextSlices || !count) return null;
		// Up to twelve pages, spread over the document: front matter, a page
		// with a figure, a blank page do not decide it alone.
		const picks = count <= 12 ? [...Array(count).keys()] : [...new Set(Array.from({ length: 12 }, (_, i) => Math.round((i * (count - 1)) / 11)))];
		const samples = [];
		for (const i of picks) {
			const page = d.pages[i];
			const height = page.size?.height ?? 0;
			if (!height) continue;
			// The runs that may hold the page's number (edgeRuns): its two
			// outermost lines at top and bottom, wherever they sit — LaTeX's
			// default article prints its number 1.5in up a letter page — and
			// the top and bottom 12% (a small journal format's margins are
			// proportionally wide: the Parekh PDF's "268" ends at 91% of its
			// height). A stray number in the body agrees with no other page.
			// Their text through getTextSlices, the selection's own reader:
			// getPageTextRects' text runs on into stale memory after a run's
			// last character ("212" + junk, measured), which can glue a digit
			// onto a page number.
			let runs = [];
			try { ({ runs } = await engine.getPageGeometry(d, page).toPromise()); } catch { continue; }
			// Text with a box: a line break is a run of its own, sized 0 at 0,0.
			const withText = (runs ?? []).filter((r) => r.glyphs?.length && r.rect.width > 0 && r.rect.height > 0);
			const band = edgeRuns(withText.map((r) => r.rect), height).map((k) => withText[k]);
			const numbers = [];
			if (band.length) {
				const slices = band.map((r) => ({ pageIndex: i, charIndex: r.charStart, charCount: r.glyphs.length }));
				let texts = [];
				try { texts = await engine.getTextSlices(d, slices).toPromise(); } catch { continue; }
				for (const t of texts ?? []) numbers.push(...bandNumbers(t));
			}
			samples.push({ page: i + 1, numbers });
		}
		return textPageOffset(samples);
	})());
	handle.sendQuote = async (requestId = null) => {
		let quote = null;
		let error = null;
		try { quote = await handle.selectedQuote(); } catch (err) {
			// EmbedPDF refuses a document that forbids copying its text.
			error = /permission/i.test(String(err?.message ?? err)) ? 'copy-denied' : String(err?.message ?? err);
		}
		let label = null;
		let textOffset = null;
		if (quote) {
			label = (await handle.pageLabels())?.[quote.page - 1] ?? null;
			textOffset = await handle.textOffset().catch(() => null);
		}
		postTo(window.top, {
			source: 'clew-pdf', type: 'pdf-quote', requestId,
			path: rel, remote: readonly, page: quote?.page ?? null, text: quote?.text ?? null,
			label, textOffset,
			empty: !quote && !error, error,
		}, topOrigin());
	};
	if (selectionCap) {
		let has = false;
		const off = selectionCap.onSelectionChange?.(() => {
			const now = (selectionCap.getFormattedSelection?.() ?? []).length > 0;
			if (now !== has) { has = now; noteSelection(handle, now); }
		});
		handle.unquote = () => { off?.(); if (has) noteSelection(handle, false); };
		// The item in EmbedPDF's own selection menu, beside Copy. Its schema is
		// read when the menu is drawn, so merging at runtime is enough — no
		// change to the vendored viewer.
		const commandsCap = registry.getPlugin('commands')?.provides();
		const uiCap = registry.getPlugin('ui')?.provides();
		const menus = uiCap?.getSchema?.()?.selectionMenus;
		const menu = menus?.selection;
		if (commandsCap?.registerCommand && menu && !menu.items.some((i) => i.id === 'clew-quote')) {
			commandsCap.registerCommand({
				id: 'clew:quote-in-note',
				label: 'Quote in note',
				icon: 'clewQuote',
				categories: ['selection', 'selection-quote'],
				action: () => { handle.sendQuote(); },
			});
			const item = { type: 'command-button', id: 'clew-quote', commandId: 'clew:quote-in-note', variant: 'icon', categories: ['selection', 'selection-quote'] };
			const copyAt = menu.items.findIndex((i) => i.id === 'copy-selection');
			const items = [...menu.items];
			items.splice(copyAt + 1, 0, item);
			const depends = menu.visibilityDependsOn
				? { ...menu.visibilityDependsOn, itemIds: [...(menu.visibilityDependsOn.itemIds ?? []), 'clew-quote'] }
				: menu.visibilityDependsOn;
			uiCap.mergeSchema({ selectionMenus: { ...menus, selection: { ...menu, items, visibilityDependsOn: depends } } });
		}
	}
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
