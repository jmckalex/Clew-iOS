// The EmbedPDF viewer, shared by every PDF
// surface: note embeds (pdf-embed.js, inside a rendered preview document) and
// the standalone viewer page (pdf-page.js) that the file tab and canvas PDF
// nodes load in an iframe.
//
// Both live on the clew-preview:// origin, and in both cases window.parent is
// the app page — so one save bridge serves them both.
//
// Annotations autosave INTO the vault's PDF file, the way Clew-iOS does it:
// there is no Save button to miss, and the file on disk (and therefore
// Finder, QuickLook, and a synced iPad) is never more than a debounce behind.
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
	if (!msg || msg.source !== 'clew-pdf-host' || msg.type !== 'pdf-save-result') return;
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
		window.parent.postMessage({ source: 'clew-pdf', type: 'pdf-save', id, path: rel, bytes }, '*');
	});
}

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
	const handle = { target, container: null, saveTimer: null,
		dispose() { clearTimeout(this.saveTimer); this.container?.destroy?.(); } };
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
			}
		};
		handle.saveNow = saveNow;
		annotationCap.onAnnotationEvent((event) => {
			if (event?.type === 'loaded') return;   // opening a file is not a change
			onStatus('unsaved');
			clearTimeout(handle.saveTimer);
			handle.saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
		});
	}

	// Spike instrumentation.
	window.__clewPdfReady = (window.__clewPdfReady ?? 0) + 1;
	window.__clewPdfLastMs = Math.round(performance.now() - started);
	return handle;
}
