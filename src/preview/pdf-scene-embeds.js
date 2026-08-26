// Canvas-embed scenes: the one PDF surface upstream still leaves as a raw
// <embed type="application/pdf">. Appended by scripts/build.js to client.js,
// so it runs inside the rendered-note preview document.
//
// A canvas embedded in a note (![[board.canvas]]) is drawn by canvas-embed.js
// as a miniature scene, and a PDF card in it becomes a bare <embed>. Chromium
// hands that to its PDF plugin; WebKit paints ONE static, unscrollable page.
// So swap each for the same viewer page the file tab and canvas nodes use —
// one PDF stack in the whole app, and these PDFs become readable and
// annotatable like every other.
//
// The save relay below is the part that is not obvious. pdf-core.js posts its
// saves to `window.parent` because on all three of upstream's surfaces the
// parent IS the app page. A scene PDF is one frame deeper —
//   app page → note preview → pdf-page.html
// — so its `window.parent` is THIS document, and the save would stop here.
// We forward it up and route the answer back down.

const CLEW_SCENE_PDF_PAGE = '/__clew_assets__/clewpdf/pdf-page.html';

// ---- save relay (scene viewer → this document → app page) -------------------

let clewSceneSaveSeq = 0;
// Our relay id -> { childWindow, childId }. Ids are STRINGS ('scene:1', …):
// pdf-core's own listener in this same document keys its pending saves by the
// numbers it generates, and would otherwise resolve one of ours by collision.
const clewSceneSaves = new Map();

window.addEventListener('message', (event) => {
	const msg = event.data;
	if (!msg || msg.source !== 'clew-pdf' || msg.type !== 'pdf-save') return;
	// A viewer in THIS document posts to window.parent, which never delivers
	// here — so anything arriving is from a scene iframe below us.
	const id = `scene:${++clewSceneSaveSeq}`;
	clewSceneSaves.set(id, { childWindow: event.source, childId: msg.id });
	window.parent.postMessage({ ...msg, id }, '*');
});

window.addEventListener('message', (event) => {
	const msg = event.data;
	if (!msg || msg.source !== 'clew-pdf-host' || msg.type !== 'pdf-save-result') return;
	const pending = clewSceneSaves.get(msg.id);
	if (!pending) return; // one of this document's own note-embed saves
	clewSceneSaves.delete(msg.id);
	pending.childWindow?.postMessage({ ...msg, id: pending.childId }, '*');
});

// ---- the swap ---------------------------------------------------------------

function clewUpgradeScenePdfs() {
	for (const embed of document.querySelectorAll('.canvas-embed-scene embed[type="application/pdf"]')) {
		const src = embed.getAttribute('src');
		if (!src) continue;
		const frame = document.createElement('iframe');
		frame.className = 'clew-scene-pdf-frame';
		frame.setAttribute('allow', 'fullscreen');
		frame.style.cssText = 'width: 100%; height: 100%; border: 0;';
		// Same origin as this document, so the viewer can fetch the PDF and
		// postMessage to us. The PDF's own session-scoped URL travels in ?src.
		frame.src = `${CLEW_SCENE_PDF_PAGE}?src=${encodeURIComponent(new URL(src, location.href).href)}`;
		embed.replaceWith(frame);
	}
}

// Scenes are built asynchronously after clew:render (canvas-embed.js fetches
// the .canvas file first), so a one-shot pass at render time is too early.
let clewSceneSweep = null;
new MutationObserver(() => {
	clearTimeout(clewSceneSweep);
	clewSceneSweep = setTimeout(clewUpgradeScenePdfs, 100);
}).observe(document.body, { childList: true, subtree: true });

clewUpgradeScenePdfs();
document.addEventListener('clew:render', clewUpgradeScenePdfs);
