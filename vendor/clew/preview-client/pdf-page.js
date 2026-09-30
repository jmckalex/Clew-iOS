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
import { FAILURES } from './remote-failures.js';

const params = new URLSearchParams(location.search);
const src = params.get('src');

const root = document.getElementById('viewer');
const status = document.getElementById('status');
const onStatus = (text) => {
	status.textContent = text;
	status.style.opacity = text ? '1' : '0';
};

let viewer = null;

/** The page to open at: `?page=N`, or a `#page=N` a redirect carried over
 *  (a frame navigating straight to a vault PDF — protocol.js sends it here). */
const startPage = () => Number(params.get('page')) || Number(/(?:^#|&)page=(\d+)/.exec(location.hash)?.[1]) || 0;

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
// ---- a web PDF (docs/dev/pdf-unification.md §4) ---------------------------
// `readonly=1`: `src` is this session's __clew_remote_pdf__/<hash> route,
// which serves a copy Clew fetched and keeps on the DEVICE; `origin` is the
// web URL, used here only to NAME the document — the actions below name the
// hash, and the app looks the URL up in its own registrations. Nothing is
// ever saved into a web PDF: it opens read-only, and "Save a copy to the
// vault" is how it becomes the user's own, annotatable file.
const readonly = params.get('readonly') === '1';
const remoteKey = /\/__clew_remote_pdf__\/([0-9a-f]{64})$/.exec(src ?? '')?.[1] ?? null;
const origin = params.get('origin') ?? '';
const strip = document.getElementById('remote-strip');


const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };
const fileNameOf = (url) => {
	try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '') || 'web.pdf'; } catch { return 'web.pdf'; }
};
const dateOf = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return iso; } };

/** Ask the app page to act on this web PDF; resolves with its answer. */
let asked = 0;
function askHost(type) {
	const id = `r${++asked}`;
	return new Promise((resolve) => {
		const onReply = (event) => {
			const msg = event.data;
			if (event.source !== window.top || msg?.source !== 'clew-pdf-host' || msg.type !== `${type}-result` || msg.id !== id) return;
			window.removeEventListener('message', onReply);
			resolve(msg);
		};
		window.addEventListener('message', onReply);
		window.top.postMessage({ source: 'clew-pdf', type, key: remoteKey, id }, '*');
	});
}

/** The strip's copy-dependent actions: nothing to save or reload from
 *  until a copy exists (the failure panel offers Open in browser and Retry). */
function stripActions(haveCopy) {
	for (const act of ['save', 'reload']) strip.querySelector(`[data-act="${act}"]`).hidden = !haveCopy;
}

function showFailure({ error, message }) {
	onStatus('');
	stripActions(false);
	const box = document.createElement('div');
	box.id = 'remote-failure';
	const head = document.createElement('div');
	head.textContent = FAILURES[error] ?? 'This web PDF could not be shown.';
	const why = document.createElement('div');
	why.className = 'why';
	why.textContent = `${hostOf(origin)} — ${message ?? error}`;
	const buttons = document.createElement('div');
	for (const [act, label] of [['open', 'Open in browser'], ['retry', 'Retry']]) {
		const b = document.createElement('button');
		b.type = 'button';
		b.dataset.act = act;
		b.textContent = label;
		buttons.append(b, ' ');
	}
	box.append(head, why, buttons);
	root.replaceChildren(box);
	window.__clewRemoteFailure = error;   // scenarios
}

async function openRemote({ reload = false } = {}) {
	document.body.classList.add('is-remote');
	strip.querySelector('.what').textContent = `${fileNameOf(origin)} · ${hostOf(origin)} · read-only`;
	onStatus('loading…');
	let res;
	try {
		res = await fetch(reload ? `${src}?reload=1` : src);
	} catch (err) {
		showFailure({ error: 'network', message: String(err?.message ?? err) });
		return;
	}
	if (!res.ok) {
		let info = { error: 'http-status', message: `answered ${res.status}` };
		try { info = await res.json(); } catch { /* keep the status */ }
		showFailure(info);
		return;
	}
	const buffer = await res.arrayBuffer();
	stripActions(true);
	const fetched = res.headers.get('X-Clew-Remote-Fetched');
	const stale = res.headers.get('X-Clew-Remote-Error');
	const what = strip.querySelector('.what');
	what.textContent = `${fileNameOf(origin)} · ${hostOf(origin)} · read-only`;
	if (stale) {
		const note = document.createElement('span');
		note.className = 'stale';
		note.textContent = ` · offline — a saved copy from ${dateOf(fetched)}`;
		note.title = decodeURIComponent(stale);
		what.append(note);
	}
	window.__clewRemoteStale = Boolean(stale);
	viewer?.dispose?.();
	root.replaceChildren();
	viewer = await createViewer({ target: root, src, onStatus, readonly: true, buffer, name: fileNameOf(origin) });
	window.__clewPdfHandle = viewer;
	const page = startPage();
	if (page > 1) showPage(page);
}

document.addEventListener('click', async (event) => {
	const act = event.target.closest?.('button[data-act]')?.dataset.act;
	if (!act || !readonly) return;
	if (act === 'save') {
		const answer = await askHost('remote-pdf-save-copy');
		window.__clewRemoteSaved = answer.ok ? answer.path : `error: ${answer.error}`;
	} else if (act === 'open') {
		await askHost('remote-pdf-open');
	} else if (act === 'reload' || act === 'retry') {
		openRemote({ reload: true }).catch((err) => showFailure({ error: 'network', message: String(err?.message ?? err) }));
	}
});

if (!src) {
	onStatus('no PDF given');
} else if (readonly && remoteKey) {
	openRemote().catch((err) => {
		console.warn('[clew pdf] web PDF failed:', err);
		showFailure({ error: 'network', message: String(err?.message ?? err) });
	});
} else {
	createViewer({ target: root, src, onStatus }).then((handle) => {
		viewer = handle;
		window.__clewPdfHandle = handle;   // scenarios
		// `[[paper.pdf#page=12]]` (§5.15): open there.
		const page = startPage();
		if (page > 1) showPage(page);
	}).catch((err) => {
		console.warn('[clew pdf] page viewer failed:', err);
		window.__clewPdfError = String(err?.message ?? err);
		onStatus('viewer failed');
		root.textContent = `PDF viewer failed: ${err?.message ?? err}`;
	});
}

// Thumbnail mode (`&thumb=1`, main/pdf-thumbs.js): an offscreen window asks
// for page 1 as a PNG, base64, its long side `maxPx`. null until the document
// is open (main asks again); { error } when it cannot be drawn.
window.__clewThumb = async (maxPx = 1024) => {
	if (!params.get('thumb') || !viewer?.container) return window.__clewPdfError ? { error: window.__clewPdfError } : null;
	try {
		const registry = await viewer.container.registry;
		const render = registry?.getPlugin('render')?.provides();
		if (!render) return null;
		const draw = async (scaleFactor) => {
			const task = render.renderPage({ pageIndex: 0, options: { scaleFactor, dpr: 1, imageType: 'image/png' } });
			return typeof task?.toPromise === 'function' ? task.toPromise() : task;
		};
		// Once at a scale of 1 (points) to learn the page's size, then at the
		// scale that makes its long side maxPx.
		let blob = await draw(1);
		const probe = await createImageBitmap(blob);
		const scale = Math.min(4, maxPx / Math.max(probe.width, probe.height));
		probe.close?.();
		if (Math.abs(scale - 1) > 0.01) blob = await draw(scale);
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let binary = '';
		for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		return { png: btoa(binary) };
	} catch (err) {
		// "Document … not loaded": not yet — ask again.
		return /not loaded/i.test(String(err?.message)) ? null : { error: String(err?.message ?? err) };
	}
};

// The app page owns the theme; follow it so a PDF tab is not a white slab in
// a dark window (and vice versa). Same message shape the preview client uses.
window.addEventListener('message', (event) => {
	const msg = event.data;
	if (msg?.source === 'clew-preview-host' && msg.type === 'theme') {
		document.documentElement.dataset.theme = msg.theme;
	}
	// The host asks for the annotations (renderer/pdf-annotations.js) or a
	// page (a page anchor into an open tab) — the app page only (window.top;
	// a tab's viewer has it as its parent, a canvas scene's viewer inside a
	// note does not), or this page's own parent; never another frame that
	// happens to hold a reference to this one. Answers go back to the asker.
	if (event.source !== window.parent && event.source !== window.top) return;
	const asker = event.source;
	if (msg?.source === 'clew-preview-host' && msg.type === 'pdf-page' && viewer?.scrollToPage) {
		showPage(msg.page).then((ok) => {
			if (ok) asker.postMessage({ source: 'clew-preview', type: 'pdf-page-shown', page: msg.page }, '*');
		});
	}
	if (msg?.source === 'clew-preview-host' && msg.type === 'test-create-annotations') {
		viewer?.createAnnotations?.(msg.specs ?? []).then((made) => asker.postMessage({ source: 'clew-preview', type: 'test-created', made }, '*'));
	}
	if (msg?.source === 'clew-preview-host' && msg.type === 'list-annotations') {
		const reply = (annotations, error) => asker.postMessage({ source: 'clew-preview', type: 'annotations', requestId: msg.requestId, annotations, error }, '*');
		if (!viewer?.listAnnotations) reply([], 'The viewer is still loading');
		else viewer.listAnnotations().then((a) => reply(a, null), (err) => reply([], String(err?.message ?? err)));
	}
});
