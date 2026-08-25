// The inline PDF surface for preview documents on iOS. This file is
// appended verbatim to the preview client by scripts/build.js, so it runs
// in client.js's module scope — `post` (iframe → host bridge) is in scope.
//
// Each ![[x.pdf]] embed gets two modes:
//
//  - Reader (default): PDF.js canvas pages replace the <embed> WebKit
//    would render as one static page. Pages render lazily on scroll and
//    are released off-screen, so book-length PDFs stay cheap. Saved
//    annotations are part of the page appearance, so they show here too.
//
//  - Editor (✎ Annotate, or double-tap): the PDF.js viewer component
//    with the annotation editor enabled — highlight, ink (Pencil), text
//    notes — in a full-pane overlay. Save posts the updated bytes to the
//    host, which writes them into the vault file via the native bridge
//    (the same file QuickLook's Pencil markup edits in place).

const PDFJS_ASSETS = '/__clew_assets__/pdfjs';

let pdfLibPromise = null;
const loadPdfLib = () => pdfLibPromise ??= import(`${PDFJS_ASSETS}/pdf.min.mjs`).then((lib) => {
	lib.GlobalWorkerOptions.workerSrc = `${PDFJS_ASSETS}/pdf.worker.min.mjs`;
	return lib;
});

// pdf_viewer.mjs is the webpack components build: it binds to
// globalThis.pdfjsLib at import time, which pdf.min.mjs assigns while it
// evaluates — the chaining below is load-bearing, not just sequencing.
let pdfViewerModPromise = null;
const loadPdfViewerMod = () => pdfViewerModPromise ??=
	loadPdfLib().then(() => import(`${PDFJS_ASSETS}/pdf_viewer.mjs`));

// Glyph fidelity: CID-keyed fonts (cmaps), PDFs relying on the standard 14
// (standard_fonts), JPEG2000 scans (wasm), ICC color profiles (iccs).
const PDF_DOC_OPTS = {
	cMapUrl: `${PDFJS_ASSETS}/cmaps/`,
	cMapPacked: true,
	standardFontDataUrl: `${PDFJS_ASSETS}/standard_fonts/`,
	wasmUrl: `${PDFJS_ASSETS}/wasm/`,
	iccUrl: `${PDFJS_ASSETS}/iccs/`,
};

// The embed src is /<sid>/<vault path>; writeBinary wants the vault path.
const vaultRelOf = (src) => new URL(src, location.href).pathname
	.split('/').filter(Boolean).map(decodeURIComponent).slice(1).join('/');

// ---- reader ----------------------------------------------------------------

// Live readers, so re-renders can release worker memory: morphdom replaces
// the .pdf-pages div wholesale, and without an explicit destroy the
// document proxy (and its worker-side pages) would leak per re-render.
const readers = new Set();

const teardownReaders = (predicate) => {
	for (const state of readers) {
		if (!predicate(state)) continue;
		readers.delete(state);
		state.observer?.disconnect();
		// destroy() lives on the loading task, not the document proxy, and
		// works mid-load too (teardown can race the initial fetch+parse).
		state.task?.destroy().catch(() => {});
	}
};

function mountReader(host, src) {
	const state = { host, task: null, observer: null };
	readers.add(state);
	(async () => {
		try {
			const pdfjs = await loadPdfLib();
			const data = await (await fetch(src)).arrayBuffer();
			if (!host.isConnected) return; // re-rendered away while fetching
			state.task = pdfjs.getDocument({ data, ...PDF_DOC_OPTS });
			const doc = await state.task.promise;
			const first = await doc.getPage(1);
			const baseRatio = first.getViewport({ scale: 1 }).height / first.getViewport({ scale: 1 }).width;
			const render = async (holder, pageNumber) => {
				const page = await doc.getPage(pageNumber);
				const width = host.clientWidth || 600;
				const scale = width / page.getViewport({ scale: 1 }).width;
				const viewport = page.getViewport({ scale: scale * (window.devicePixelRatio || 2) });
				const canvas = document.createElement('canvas');
				canvas.width = viewport.width;
				canvas.height = viewport.height;
				canvas.style.cssText = 'width: 100%; display: block;';
				await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
				holder.style.aspectRatio = String(viewport.width / viewport.height);
				holder.replaceChildren(canvas);
			};
			const observer = new IntersectionObserver((entries) => {
				for (const entry of entries) {
					const holder = entry.target;
					const pageNumber = Number(holder.dataset.page);
					if (entry.isIntersecting && !holder.firstChild) {
						render(holder, pageNumber).catch(() => {});
					} else if (!entry.isIntersecting && holder.firstChild) {
						holder.replaceChildren(); // release off-screen canvases
					}
				}
			}, { root: host, rootMargin: '200% 0%' });
			state.observer = observer;
			for (let n = 1; n <= doc.numPages; n++) {
				const holder = document.createElement('div');
				holder.dataset.page = String(n);
				holder.style.cssText = `aspect-ratio: ${1 / baseRatio}; background: white; margin-bottom: 6px;`;
				host.append(holder);
				observer.observe(holder);
			}
		} catch (err) {
			console.warn('[clew pdf] inline render failed:', err);
		}
	})();
}

const remountReader = (host, src) => {
	teardownReaders((state) => state.host === host);
	host.replaceChildren();
	mountReader(host, src);
};

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

// ---- annotation editor -----------------------------------------------------

const EDITOR_CSS = `
.clew-pdf-editor { position: fixed; inset: 0; z-index: 2147483000; display: flex; flex-direction: column; background: Canvas; color: CanvasText; color-scheme: light dark; }
.clew-pdf-editor .clew-pdf-toolbar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; flex-wrap: wrap; background: rgba(128,128,128,0.12); }
.clew-pdf-editor .clew-pdf-toolbar button { font: inherit; min-height: 38px; min-width: 38px; padding: 4px 12px; border: none; border-radius: 7px; background: rgba(128,128,128,0.18); color: inherit; cursor: pointer; }
.clew-pdf-editor .clew-pdf-toolbar button.is-active { background: #3b82f6; color: #fff; }
.clew-pdf-editor .clew-pdf-toolbar button:disabled { opacity: 0.35; }
.clew-pdf-editor .clew-pdf-params { display: flex; align-items: center; gap: 6px; }
.clew-pdf-editor .clew-pdf-params input[type="range"] { width: 90px; }
.clew-pdf-editor .clew-pdf-status { font-size: 0.85em; opacity: 0.75; margin-left: auto; padding: 0 6px; }
.clew-pdf-editor .clew-pdf-stage { flex: 1; position: relative; }
.clew-pdf-editor .clew-pdf-container { position: absolute; inset: 0; overflow: auto; -webkit-overflow-scrolling: touch; }
.clew-pdf-editor .clew-pdf-message { padding: 24px; text-align: center; }
`;

function ensureEditorStyles() {
	if (document.getElementById('clew-pdf-editor-css')) return;
	// The components stylesheet (page/text/annotation/editor layers) plus
	// our overlay chrome. <head> is safe from morphdom (it morphs body).
	const link = document.createElement('link');
	link.rel = 'stylesheet';
	link.href = `${PDFJS_ASSETS}/pdf_viewer.css`;
	document.head.append(link);
	const style = document.createElement('style');
	style.id = 'clew-pdf-editor-css';
	style.textContent = EDITOR_CSS;
	document.head.append(style);
}

let editorOpen = false;

async function openEditor({ src, rel, onSaved }) {
	if (editorOpen) return;
	editorOpen = true;
	ensureEditorStyles();

	const root = document.createElement('div');
	root.className = 'clew-pdf-editor';
	// Survive morphdom: the client's re-render morphs document.body against
	// HTML that doesn't contain this overlay; data-clew-keep opts out of
	// the discard so in-progress annotations outlive note re-renders.
	root.setAttribute('data-clew-keep', '');

	const toolbar = document.createElement('div');
	toolbar.className = 'clew-pdf-toolbar';
	const stage = document.createElement('div');
	stage.className = 'clew-pdf-stage';
	const container = document.createElement('div');
	container.className = 'clew-pdf-container';
	const viewerEl = document.createElement('div');
	viewerEl.className = 'pdfViewer';
	container.append(viewerEl);
	stage.append(container);
	root.append(toolbar, stage);
	document.body.append(root);

	const button = (label, title, onTap) => {
		const el = document.createElement('button');
		el.textContent = label;
		el.title = title;
		el.setAttribute('aria-label', title);
		el.addEventListener('click', onTap);
		toolbar.append(el);
		return el;
	};

	let pdfjs, viewerMod, loadingTask, doc, pdfViewer, uiManager;
	let dirty = false;
	let savedAny = false;
	let savePromise = null;

	const status = document.createElement('span');
	status.className = 'clew-pdf-status';
	const setStatus = (text) => { status.textContent = text; };

	// -- mode buttons (enabled once the document is in the viewer) --
	const modeButtons = new Map(); // mode -> button
	const paramRows = new Map(); // mode -> params element
	const setMode = (mode) => {
		pdfViewer.annotationEditorMode = { mode };
		for (const [m, el] of modeButtons) el.classList.toggle('is-active', m === mode);
		for (const [m, el] of paramRows) el.style.display = m === mode ? '' : 'none';
		// Defaults only stick while the mode is active (updateParams is a
		// no-op with no current editor type), so push them on every entry.
		const P = pdfjs.AnnotationEditorParamsType;
		if (mode === pdfjs.AnnotationEditorType.INK) {
			uiManager?.updateParams(P.INK_COLOR, inkColor.value);
			uiManager?.updateParams(P.INK_THICKNESS, Number(inkThickness.value));
		} else if (mode === pdfjs.AnnotationEditorType.FREETEXT) {
			uiManager?.updateParams(P.FREETEXT_COLOR, textColor.value);
			uiManager?.updateParams(P.FREETEXT_SIZE, Number(textSize.value));
		}
	};
	const modeButton = (label, title, modeOf) => {
		const el = button(label, title, () => setMode(modeOf(pdfjs.AnnotationEditorType)));
		el.disabled = true;
		return el;
	};
	const browseBtn = modeButton('✋', 'Browse', (T) => T.NONE);
	const highlightBtn = modeButton('🖍', 'Highlight', (T) => T.HIGHLIGHT);
	const drawBtn = modeButton('✎', 'Draw', (T) => T.INK);
	const textBtn = modeButton('T', 'Text note', (T) => T.FREETEXT);

	// -- per-tool parameters, applied through the editor UI manager --
	const colorInput = (value) => {
		const el = document.createElement('input');
		el.type = 'color';
		el.value = value;
		return el;
	};
	const rangeInput = (min, max, value) => {
		const el = document.createElement('input');
		el.type = 'range';
		el.min = String(min);
		el.max = String(max);
		el.value = String(value);
		return el;
	};
	const inkColor = colorInput('#d02020');
	const inkThickness = rangeInput(1, 20, 3);
	const textColor = colorInput('#d02020');
	const textSize = rangeInput(8, 48, 14);
	const paramsRow = (controls) => {
		const row = document.createElement('div');
		row.className = 'clew-pdf-params';
		row.style.display = 'none';
		for (const [input, type] of controls) {
			input.addEventListener('input', () => {
				uiManager?.updateParams(type(pdfjs.AnnotationEditorParamsType),
					input.type === 'range' ? Number(input.value) : input.value);
			});
			row.append(input);
		}
		toolbar.append(row);
		return row;
	};
	const inkParamsRow = paramsRow([[inkColor, (P) => P.INK_COLOR], [inkThickness, (P) => P.INK_THICKNESS]]);
	const textParamsRow = paramsRow([[textColor, (P) => P.FREETEXT_COLOR], [textSize, (P) => P.FREETEXT_SIZE]]);

	// -- zoom / undo / redo / save / done --
	const zoom = (factor) => {
		pdfViewer.currentScale = Math.min(5, Math.max(0.25, pdfViewer.currentScale * factor));
	};
	const zoomOutBtn = button('−', 'Zoom out', () => zoom(0.8));
	const zoomInBtn = button('＋', 'Zoom in', () => zoom(1.25));
	const undoBtn = button('↺', 'Undo', () => uiManager?.undo());
	const redoBtn = button('↻', 'Redo', () => uiManager?.redo());
	for (const el of [zoomOutBtn, zoomInBtn, undoBtn, redoBtn]) el.disabled = true;
	toolbar.append(status);
	const saveBtn = button('Save', 'Save annotations into the vault file', () => { save(); });
	const doneBtn = button('Done', 'Save and close', () => { done(); });
	saveBtn.disabled = true;

	const setDirty = (value) => {
		dirty = value;
		saveBtn.disabled = !dirty;
		if (dirty) setStatus('unsaved changes');
		else if (!savedAny) setStatus('');
	};

	const save = () => savePromise ??= (async () => {
		if (!dirty || !doc) return;
		setStatus('Saving…');
		try {
			const bytes = await doc.saveDocument();
			await saveToVault(rel, bytes);
			doc.annotationStorage.resetModified(); // -> onResetModified -> clean
			savedAny = true;
			setStatus('Saved');
		} catch (err) {
			console.warn('[clew pdf] save failed:', err);
			setStatus(`Save failed — ${err.message}`);
		}
	})().finally(() => { savePromise = null; });

	const done = async () => {
		if (savePromise) await savePromise;
		if (dirty) await save();
		if (dirty) return; // save failed — keep the annotations on screen
		close();
	};

	const onKeydown = (e) => { if (e.key === 'Escape') done(); };
	document.addEventListener('keydown', onKeydown);

	const close = () => {
		document.removeEventListener('keydown', onKeydown);
		// The loading task owns destroy() and covers a close mid-load too.
		loadingTask?.destroy().catch(() => {});
		root.remove();
		editorOpen = false;
		if (savedAny) onSaved?.();
	};

	try {
		[pdfjs, viewerMod] = await Promise.all([loadPdfLib(), loadPdfViewerMod()]);
		const data = await (await fetch(src)).arrayBuffer();
		loadingTask = pdfjs.getDocument({ data, ...PDF_DOC_OPTS });
		doc = await loadingTask.promise;

		const eventBus = new viewerMod.EventBus();
		const linkService = new viewerMod.PDFLinkService({ eventBus });
		pdfViewer = new viewerMod.PDFViewer({
			container,
			viewer: viewerEl,
			eventBus,
			linkService,
			annotationEditorHighlightColors:
				'yellow=#FFFF98,green=#53FFBC,blue=#80EBFF,pink=#FFCBE6,red=#FF4F5F',
			enableHighlightFloatingButton: true,
			imageResourcesPath: `${PDFJS_ASSETS}/images/`,
		});
		linkService.setViewer(pdfViewer);

		eventBus.on('annotationeditoruimanager', ({ uiManager: manager }) => {
			uiManager = manager;
		});
		eventBus.on('annotationeditorstateschanged', ({ details }) => {
			undoBtn.disabled = !details.hasSomethingToUndo;
			redoBtn.disabled = !details.hasSomethingToRedo;
		});
		eventBus.on('pagesinit', () => {
			pdfViewer.currentScaleValue = 'page-width';
			for (const el of [browseBtn, highlightBtn, drawBtn, textBtn, zoomOutBtn, zoomInBtn]) {
				el.disabled = false;
			}
			setMode(pdfjs.AnnotationEditorType.NONE);
		});

		// Dirty-state tracking, the same hooks the reference viewer uses.
		doc.annotationStorage.onSetModified = () => setDirty(true);
		doc.annotationStorage.onResetModified = () => setDirty(false);

		pdfViewer.setDocument(doc);
		linkService.setDocument(doc, null);
		paramRows.set(pdfjs.AnnotationEditorType.INK, inkParamsRow);
		paramRows.set(pdfjs.AnnotationEditorType.FREETEXT, textParamsRow);
		modeButtons.set(pdfjs.AnnotationEditorType.NONE, browseBtn);
		modeButtons.set(pdfjs.AnnotationEditorType.HIGHLIGHT, highlightBtn);
		modeButtons.set(pdfjs.AnnotationEditorType.INK, drawBtn);
		modeButtons.set(pdfjs.AnnotationEditorType.FREETEXT, textBtn);
	} catch (err) {
		console.warn('[clew pdf] editor failed to open:', err);
		const message = document.createElement('div');
		message.className = 'clew-pdf-message';
		message.textContent = `Could not open the annotation editor: ${err.message}`;
		stage.replaceChildren(message);
	}
}

// ---- EMBEDPDF SPIKE --------------------------------------------------------
// (embedpdf-spike branch) Evaluating EmbedPDF (MIT, Pdfium-in-wasm, full
// viewer chrome + annotation suite) as the Annotate surface. Airgapped per
// their docs: no external requests — wasm, fonts and stamps all disabled
// or served from our own assets. The PDF.js editor above stays intact;
// clewPdfInit routes here on this branch.

const EMBEDPDF_ASSETS = '/__clew_assets__/embedpdf';

let embedPdfPromise = null;
// ESM bundle; its hashed chunks resolve relative to this URL.
const loadEmbedPdf = () => embedPdfPromise ??= import(`${EMBEDPDF_ASSETS}/embedpdf.js`);

let epOpen = false;

async function openEmbedPdfEditor({ src, rel, onSaved }) {
	if (epOpen) return;
	epOpen = true;
	ensureEditorStyles(); // reuse the overlay chrome

	const root = document.createElement('div');
	root.className = 'clew-pdf-editor';
	root.setAttribute('data-clew-keep', '');
	const toolbar = document.createElement('div');
	toolbar.className = 'clew-pdf-toolbar';
	const stage = document.createElement('div');
	stage.className = 'clew-pdf-stage';
	const viewerEl = document.createElement('div');
	viewerEl.id = 'clew-embedpdf';
	viewerEl.style.cssText = 'position: absolute; inset: 0;';
	stage.append(viewerEl);
	root.append(toolbar, stage);
	document.body.append(root);

	const status = document.createElement('span');
	status.className = 'clew-pdf-status';
	const setStatus = (text) => { status.textContent = text; };

	let registry = null;
	let savedAny = false;
	let saving = false;

	const save = async () => {
		if (saving || !registry) return;
		saving = true;
		setStatus('Saving…');
		try {
			const exportCap = registry.getPlugin('export')?.provides();
			if (!exportCap) throw new Error('export plugin unavailable');
			const buffer = await exportCap.saveAsCopy().toPromise();
			await saveToVault(rel, new Uint8Array(buffer));
			savedAny = true;
			setStatus('Saved');
		} catch (err) {
			console.warn('[clew pdf embedpdf] save failed:', err);
			setStatus(`Save failed — ${err?.message ?? err}`);
		} finally {
			saving = false;
		}
	};
	const close = () => {
		root.remove(); // disconnects the custom element; it cleans itself up
		epOpen = false;
		delete window.__clewSpikeViewer;
		if (savedAny) onSaved?.();
	};

	const button = (label, onTap) => {
		const el = document.createElement('button');
		el.textContent = label;
		el.title = label;
		el.addEventListener('click', onTap);
		toolbar.append(el);
		return el;
	};
	toolbar.append(status);
	button('Save', () => { save(); });
	button('Done', async () => { await save(); close(); });

	try {
		setStatus('loading EmbedPDF…');
		const { default: EmbedPDF } = await loadEmbedPdf();
		const container = EmbedPDF.init({
			type: 'container',
			target: viewerEl,
			wasmUrl: new URL(`${EMBEDPDF_ASSETS}/pdfium.wasm`, location.href).href,
			fontFallback: null,          // airgapped: no jsDelivr fonts
			fonts: { ui: null, signature: null }, // airgapped: no Google Fonts
			theme: { preference: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark' },
		});
		if (!container) throw new Error('EmbedPDF.init returned nothing');
		registry = await container.registry;
		// Load via buffer, not src URL: lesson from the Syncfusion spike —
		// URL loaders tend to allowlist http(s)/blob and mangle custom
		// schemes, while a buffer has no provenance to argue about.
		setStatus('opening document…');
		const buffer = await (await fetch(src)).arrayBuffer();
		const docManager = registry.getPlugin('document-manager')?.provides();
		if (!docManager) throw new Error('document-manager plugin unavailable');
		await docManager.openDocumentBuffer({
			buffer,
			name: rel.split('/').pop() ?? 'document.pdf',
		}).toPromise();
		window.__clewSpikeViewer = { container, registry, save }; // sim automation
		setStatus('loaded');
	} catch (err) {
		console.warn('[clew pdf embedpdf] editor failed to open:', err);
		const message = document.createElement('div');
		message.className = 'clew-pdf-message';
		message.textContent = `EmbedPDF editor failed: ${err?.message ?? err}`;
		stage.replaceChildren(message);
	}
}

// ---- embed wiring -----------------------------------------------------------

const clewPdfInit = () => {
	teardownReaders((state) => !state.host.isConnected);
	for (const embed of document.querySelectorAll('.pdf-embed-box embed.pdf-embed')) {
		const src = embed.getAttribute('src');
		const rel = vaultRelOf(src);
		const host = document.createElement('div');
		host.className = 'pdf-pages';
		host.style.cssText = 'max-height: 70vh; overflow-y: auto; -webkit-overflow-scrolling: touch; border-radius: 4px; background: rgba(128,128,128,0.08);';
		embed.replaceWith(host);
		const titleBar = host.closest('.pdf-embed-box')?.querySelector('.embed-title');
		if (titleBar && !titleBar.querySelector('.pdf-annotate')) {
			const annotate = document.createElement('button');
			annotate.className = 'pdf-annotate';
			annotate.textContent = '✎ Annotate';
			annotate.style.cssText = 'float: right; font: inherit; font-size: 0.85em; color: inherit; background: rgba(128,128,128,0.15); border: none; border-radius: 5px; padding: 2px 10px; cursor: pointer;';
			annotate.addEventListener('click', (e) => {
				e.preventDefault();
				// SPIKE: route to the EmbedPDF editor; openEditor is the
				// PDF.js editor this branch is evaluating against.
				openEmbedPdfEditor({ src, rel, onSaved: () => remountReader(host, src) });
			});
			titleBar.append(annotate);
			host.addEventListener('dblclick', () => annotate.click());
		}
		mountReader(host, src);
	}
};
clewPdfInit();
document.addEventListener('clew:render', clewPdfInit);
