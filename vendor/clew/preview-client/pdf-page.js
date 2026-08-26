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

if (!src) {
	onStatus('no PDF given');
} else {
	createViewer({ target: root, src, onStatus }).catch((err) => {
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
});
