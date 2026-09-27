// The standalone PDF viewer page.
//
// The file tab (<clew-file-view>) and canvas PDF nodes point an iframe at a
// raw PDF today, which is what makes Chromium's plugin appear. There is no
// HTML document there, so there is nothing for the preview client to upgrade
// — those surfaces need a page of their own. This is it:
//
//   clew-preview://vault/<sid>/__clew_assets__/clewpdf/pdf-page.html?src=<url>
//
// It is served from the clew-preview origin, so it can fetch the PDF and
// postMessage its saves to the app page exactly as the note-embed viewer
// does. Same pdf-core.js, same autosave, same annotations.
import { createViewer } from './pdf-core.js';

const params = new URLSearchParams(location.search);
const src = params.get('src');

const root = document.getElementById('viewer');
const status = document.getElementById('status');
const onStatus = (text) => {
	status.textContent = text;
	status.style.opacity = text ? '1' : '0';
};

let viewer = null;

/** Scroll to `page` once the viewer has laid its pages out: a scroll asked
 *  for too early lands nowhere (measured — it worked only when something
 *  slowed the page down), so try until the current page says so. */
async function showPage(page) {
	for (let i = 0; i < 20; i += 1) {
		viewer?.scrollToPage?.(page);
		await new Promise((r) => setTimeout(r, 250));
		if (viewer?.currentPage?.() === page) return true;
	}
	return false;
}
if (!src) {
	onStatus('no PDF given');
} else {
	createViewer({ target: root, src, onStatus }).then((handle) => {
		viewer = handle;
		window.__clewPdfHandle = handle;   // scenarios
		// `[[paper.pdf#page=12]]` (§5.15): open there.
		const page = Number(params.get('page'));
		if (page > 1) showPage(page);
	}).catch((err) => {
		console.warn('[clew pdf] page viewer failed:', err);
		window.__clewPdfError = String(err?.message ?? err);
		onStatus('viewer failed');
		root.textContent = `PDF viewer failed: ${err?.message ?? err}`;
	});
}

// The app page owns the theme; follow it so a PDF tab is not a white slab in
// a dark window (and vice versa). Same message shape the preview client uses.
window.addEventListener('message', (event) => {
	const msg = event.data;
	if (msg?.source === 'clew-preview-host' && msg.type === 'theme') {
		document.documentElement.dataset.theme = msg.theme;
	}
	// The host asks for the annotations (renderer/pdf-annotations.js) or a
	// page (a page anchor into an open tab) — the app page only, never
	// another frame that happens to hold a reference to this one.
	if (event.source !== window.parent) return;
	if (msg?.source === 'clew-preview-host' && msg.type === 'pdf-page' && viewer?.scrollToPage) {
		showPage(msg.page).then((ok) => {
			if (ok) window.parent.postMessage({ source: 'clew-preview', type: 'pdf-page-shown', page: msg.page }, '*');
		});
	}
	if (msg?.source === 'clew-preview-host' && msg.type === 'test-create-annotations') {
		viewer?.createAnnotations?.(msg.specs ?? []).then((made) => window.parent.postMessage({ source: 'clew-preview', type: 'test-created', made }, '*'));
	}
	if (msg?.source === 'clew-preview-host' && msg.type === 'list-annotations') {
		const reply = (annotations, error) => window.parent.postMessage({ source: 'clew-preview', type: 'annotations', requestId: msg.requestId, annotations, error }, '*');
		if (!viewer?.listAnnotations) reply([], 'The viewer is still loading');
		else viewer.listAnnotations().then((a) => reply(a, null), (err) => reply([], String(err?.message ?? err)));
	}
});
