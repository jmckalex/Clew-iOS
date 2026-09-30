// The note-embed PDF surface.
//
// Upgrades the engine's <embed class="pdf-embed"> (from ![[paper.pdf]]) into a
// live EmbedPDF viewer at reading height: read, search, zoom and annotate in
// place, with annotations saved back into the vault's own file. The viewer
// itself lives in pdf-core.js, shared with the standalone viewer page that
// the file tab and canvas nodes use.
import { createViewer } from './pdf-core.js';

const CSS = `
.clew-pdf-inline { height: 70vh; position: relative; border-radius: 4px; overflow: hidden; }
.clew-pdf-message { padding: 24px; text-align: center; opacity: 0.8; }

/* The engine's own <embed> is re-inserted by every morph (the incoming HTML
   still contains it) and Chromium starts loading its PDF plugin the moment it
   lands — a visible flash before initPdfEmbeds removes it again. Hiding it
   wherever a live viewer already exists means it never paints. Scoped with
   :has() so a document whose viewer never started still falls back to the
   plugin rather than showing nothing. */
.pdf-embed-box:has(.clew-pdf-inline) embed.pdf-embed { display: none !important; }

/* ---- title-bar chrome ---- */
.clew-pdf-status { float: right; font-size: 0.85em; opacity: 0.7; padding: 2px 8px; }
.clew-pdf-wide {
	float: right;
	margin-left: 6px;
	border: 0; border-radius: 4px;
	background: transparent; color: inherit;
	opacity: 0.55; cursor: pointer;
	font: inherit; font-size: 1.05em; line-height: 1;
	padding: 2px 7px;
}
.clew-pdf-wide:hover { opacity: 1; background: rgba(127, 127, 127, 0.18); }
.clew-pdf-wide[aria-pressed='true'] { opacity: 1; }

/* ---- expanded ("expand to width") ----
   The note column is narrow, and EmbedPDF stacks its page and comment
   sidebars BELOW the document rather than flanking it when there is no room.
   Breaking the box out to the window width gives them somewhere to sit. The
   flag lives on the host element, which carries data-clew-keep and therefore
   survives a re-render — put it on the engine-rendered box instead and the
   next morph would strip it. */
.pdf-embed-box:has(.clew-pdf-inline[data-wide]) {
	width: 96vw;
	max-width: 96vw;
	margin-left: calc(50% - 48vw);
	margin-right: calc(50% - 48vw);
}
.clew-pdf-inline[data-wide] { height: 88vh; }
`;

function ensureStyles() {
	if (document.getElementById('clew-pdf-inline-css')) return;
	const style = document.createElement('style');
	style.id = 'clew-pdf-inline-css';
	style.textContent = CSS;
	document.head.append(style);
}

const viewers = new Set();
window.__clewPdfViewers = viewers; // smoke-test hook

// Scenarios: the host has this document's first viewer make annotations,
// as pdf-page.js lets it in a PDF tab (smoke/pdf-flush-scenario.js) — the
// app page only, never another frame holding a reference to this one.
window.addEventListener('message', (event) => {
	const msg = event.data;
	if (event.source !== window.parent || msg?.source !== 'clew-preview-host' || msg.type !== 'test-create-annotations') return;
	const inst = [...viewers].find((v) => v.handle?.createAnnotations);
	(inst ? inst.handle.createAnnotations(msg.specs ?? []) : Promise.resolve(-1))
		.then((made) => window.parent.postMessage({ source: 'clew-preview', type: 'test-created', made }, '*'));
});

function reapDetached() {
	for (const inst of viewers) {
		if (inst.host.isConnected) continue;
		viewers.delete(inst);
		inst.handle?.dispose();
	}
}

/**
 * A re-render is about to discard `node` (client.js's morph) — the note no
 * longer embeds this PDF, say. If a viewer inside holds an unsaved
 * annotation, keep the node, hidden but still ATTACHED — EmbedPDF stops
 * working once detached (measured: a save started after removal never
 * finished) — until the edit is written, then remove it. Returns whether it
 * was kept; the morph must then leave it be.
 */
export function holdIfUnsaved(node) {
	if (node.nodeType !== 1) return false;
	if (node.hasAttribute('data-clew-held')) return true;
	const held = [...viewers].filter((v) => v.handle?.isDirty?.() && (node === v.host || node.contains(v.host)));
	if (held.length === 0) return false;
	node.setAttribute('data-clew-held', '');
	node.style.display = 'none';
	Promise.all(held.map((v) => settled(v.handle))).finally(() => {
		node.remove();
		reapDetached();
	});
	return true;
}

/** Save now, and resolve once nothing is left unsaved (or after `ms`). */
async function settled(handle, ms = 10_000) {
	handle.flush?.();
	for (const t0 = Date.now(); handle.isDirty?.() && Date.now() - t0 < ms;) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

export function initPdfEmbeds() {
	reapDetached();
	for (const embed of document.querySelectorAll('embed.pdf-embed')) {
		// A morph re-inserts the engine's own <embed> beside the viewer we kept
		// (data-clew-keep), so without this a second Pdfium engine would spin up
		// for the same PDF on every re-render. The live viewer wins.
		const box = embed.closest('.pdf-embed-box');
		if (box?.querySelector('.clew-pdf-inline')) {
			embed.remove();
			continue;
		}
		mount(embed);
	}
	// The title bar is engine-rendered, so a morph resets it to plain markup
	// and takes our controls with it. Put them back.
	for (const host of document.querySelectorAll('.clew-pdf-inline')) ensureChrome(host);
}

/** Status chip + expand-to-width toggle in the embed's title bar. */
function ensureChrome(host) {
	const titleBar = host.closest('.pdf-embed-box')?.querySelector('.embed-title');
	if (!titleBar) return;

	// Rightmost first: both controls float right, so DOM order is right-to-left.
	if (!titleBar.querySelector('.clew-pdf-wide')) {
		const button = document.createElement('button');
		button.className = 'clew-pdf-wide';
		button.type = 'button';
		button.textContent = '⟷';
		const sync = () => {
			const wide = host.hasAttribute('data-wide');
			button.setAttribute('aria-pressed', String(wide));
			button.title = wide ? 'Restore column width' : 'Expand to window width';
			button.setAttribute('aria-label', button.title);
		};
		button.addEventListener('click', () => {
			host.toggleAttribute('data-wide');
			sync();
			// Nudge anything sizing itself from its container.
			window.dispatchEvent(new Event('resize'));
			if (host.hasAttribute('data-wide')) {
				host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
			}
		});
		sync();
		titleBar.append(button);
	}

	if (!titleBar.querySelector('.clew-pdf-status')) {
		const statusEl = document.createElement('span');
		statusEl.className = 'clew-pdf-status';
		statusEl.textContent = host.dataset.status ?? '';
		titleBar.append(statusEl);
	}
}

/** Status setter that survives the title bar being rebuilt by a morph. */
function statusFor(host) {
	return (text) => {
		host.dataset.status = text;
		const el = host.closest('.pdf-embed-box')?.querySelector('.clew-pdf-status');
		if (el) el.textContent = text;
	};
}

function mount(embed) {
	ensureStyles();
	// data-src: the preview's placeholder loads nothing (wikilinks.js); src:
	// an engine from before that.
	const src = embed.dataset.src ?? embed.getAttribute('src');
	const host = document.createElement('div');
	host.className = 'clew-pdf-inline';
	// The viewer is expensive to build and holds document state (including
	// unsaved annotations), so it must survive morphdom rather than be rebuilt.
	host.setAttribute('data-clew-keep', '');
	embed.replaceWith(host);
	ensureChrome(host);

	// A note may hold several PDFs and each viewer is its own Pdfium engine,
	// so build one only as its box approaches the viewport.
	const observer = new IntersectionObserver((entries) => {
		if (!entries.some((entry) => entry.isIntersecting)) return;
		observer.disconnect();
		build(host, src);
	}, { rootMargin: '100% 0%' });
	observer.observe(host);
}

async function build(host, src) {
	const inst = { host, handle: null };
	viewers.add(inst);
	const onStatus = statusFor(host);
	try {
		inst.handle = await createViewer({ target: host, src, onStatus });
	} catch (err) {
		console.warn('[clew pdf] inline viewer failed:', err);
		window.__clewPdfError = String(err?.message ?? err);
		onStatus('viewer failed');
		const message = document.createElement('div');
		message.className = 'clew-pdf-message';
		message.textContent = `PDF viewer failed: ${err?.message ?? err}`;
		host.replaceChildren(message);
	}
}
