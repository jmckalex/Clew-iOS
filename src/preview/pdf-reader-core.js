// The lazy scrolling PDF.js reader, shared by the preview client (note
// and canvas-embed PDFs — appended source, bundled into client.js) and
// the app page (canvas file nodes via the shim). Framework-free; the
// caller provides the asset base because the two documents see different
// roots for the same staged files (clew-preview:///__clew_assets__/pdfjs
// vs clew-app:///preview-assets/pdfjs).
//
// Pages render lazily on scroll and are released off-screen, so
// book-length PDFs stay cheap. Annotations saved into the file are part
// of the page appearance, so they show here too.
export function createPdfReader(assetBase) {
	let libPromise = null;
	const loadLib = () => libPromise ??= import(`${assetBase}/pdf.min.mjs`).then((lib) => {
		lib.GlobalWorkerOptions.workerSrc = `${assetBase}/pdf.worker.min.mjs`;
		return lib;
	});

	// Glyph fidelity: CID-keyed fonts (cmaps), PDFs relying on the
	// standard 14 (standard_fonts), JPEG2000 scans (wasm), ICC profiles.
	const docOpts = {
		cMapUrl: `${assetBase}/cmaps/`,
		cMapPacked: true,
		standardFontDataUrl: `${assetBase}/standard_fonts/`,
		wasmUrl: `${assetBase}/wasm/`,
		iccUrl: `${assetBase}/iccs/`,
	};

	// Live readers, so re-renders can release worker memory: hosts get
	// replaced wholesale (morphdom, canvas rebuilds) and without an
	// explicit destroy the worker-side document would leak per rebuild.
	const readers = new Set();

	const teardown = (predicate) => {
		for (const state of readers) {
			if (!predicate(state)) continue;
			readers.delete(state);
			state.observer?.disconnect();
			// destroy() lives on the loading task, not the document proxy,
			// and works mid-load too (teardown can race the fetch+parse).
			state.task?.destroy().catch(() => {});
		}
	};

	function mount(host, src) {
		const state = { host, task: null, observer: null };
		readers.add(state);
		(async () => {
			try {
				const pdfjs = await loadLib();
				const data = await (await fetch(src)).arrayBuffer();
				if (!host.isConnected) return; // host replaced while fetching
				state.task = pdfjs.getDocument({ data, ...docOpts });
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

	const remount = (host, src) => {
		teardown((state) => state.host === host);
		host.replaceChildren();
		mount(host, src);
	};

	return { mount, remount, teardown };
}

// /<sid>/<vault path> (or an absolute clew URL) → the vault-relative path
// the native write bridge wants; the first path segment is the session id.
export const vaultRelOf = (src, base) => new URL(src, base).pathname
	.split('/').filter(Boolean).map(decodeURIComponent).slice(1).join('/');
