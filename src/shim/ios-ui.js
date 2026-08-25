// iOS touch adaptations layered over the unmodified renderer. Kept small
// and additive: anything structural belongs upstream behind a capability
// check, not here.
import { EditorView } from '@codemirror/view';
import { runCommand } from '../../vendor/clew/renderer/commands/registry.js';
import { workspaceStore } from '../../vendor/clew/renderer/state/workspace-store.js';
import * as actions from '../../vendor/clew/renderer/commands/actions.js';
import { bridgeCall, toBase64 } from './native-bridge.js';
import { createPdfReader, vaultRelOf } from '../preview/pdf-reader-core.js';

// ---- PDFs open in QuickLook ------------------------------------------------
// WebKit has no inline PDF viewer worth the name (an <embed> shows one
// static page), so opening a PDF — from the explorer, a wikilink, or a
// preview embed's title — presents the system reader instead: scrolling,
// search, and Pencil markup that saves back into the vault file. The
// inline first-page render in reading mode stays as a preview.
const originalOpenFile = workspaceStore.openFile.bind(workspaceStore);
workspaceStore.openFile = (path, opts) => {
	if (/\.pdf$/i.test(path ?? '')) {
		bridgeCall('quickLook', { rel: path }).catch((err) =>
			console.error('[clew-ios] quickLook failed:', err));
		return null;
	}
	return originalOpenFile(path, opts);
};

// ---- PDF annotation saves (preview iframe → vault) ------------------------
// The inline PDF.js annotation editor (src/preview/pdf-viewer.js) posts the
// re-saved document bytes up from the preview iframe; the vendored preview
// host ignores the unknown message type, and this listener overwrites the
// vault file through the native bridge's coordinated updateBinary. Each
// request carries an id; the reply goes back to the posting iframe only.
window.addEventListener('message', async (event) => {
	const msg = event.data;
	if (!msg || msg.source !== 'clew-preview' || msg.type !== 'clew-pdf-save') return;
	if (!String(event.origin).startsWith('clew-preview://')) return;
	const reply = (ok, error) => event.source?.postMessage({
		source: 'clew-preview-host', type: 'clew-pdf-save-result',
		id: msg.id, ok, ...(error ? { error } : {}),
	}, '*');
	const rel = typeof msg.rel === 'string' ? msg.rel : '';
	const bytes = msg.bytes instanceof Uint8Array ? msg.bytes : null;
	if (!/\.pdf$/i.test(rel) || rel.split('/').some((part) => !part || part === '..')
		|| !bytes?.length) {
		return reply(false, 'malformed save request');
	}
	try {
		await bridgeCall('updateBinary', { rel, base64: toBase64(bytes) });
		reply(true);
	} catch (err) {
		console.error('[clew-ios] pdf save failed:', err);
		reply(false, String(err?.message ?? err));
	}
});

// ---- canvas PDF nodes: scrolling reader + inline annotate -------------------
// The canvas renders PDF file nodes as an <iframe> onto the raw file,
// which WebKit shows as ONE static, unscrollable page. Swap each for the
// shared lazy PDF.js reader (all pages, scrollable inside the node) plus
// an ✎ Annotate button that opens the EmbedPDF annotator over the
// workspace; its edits autosave straight into the vault file through the
// native bridge. App-page asset paths differ from the preview's: the same
// staged files are served from WebRoot by the clew-app scheme.
const canvasPdfReader = createPdfReader('/preview-assets/pdfjs');
const EMBEDPDF_APP_ASSETS = '/preview-assets/embedpdf';
let embedPdfAppPromise = null;
const loadEmbedPdfApp = () => embedPdfAppPromise ??= import(`${EMBEDPDF_APP_ASSETS}/embedpdf.js`);

const CANVAS_PDF_CSS = `
.clew-canvas-pdf { overflow-y: auto; -webkit-overflow-scrolling: touch; position: relative; }
.clew-canvas-pdf-annotate { position: absolute; top: 6px; right: 6px; z-index: 2; font: inherit; font-size: 0.85em; color: #333; background: rgba(255,255,255,0.85); border: none; border-radius: 5px; padding: 3px 10px; cursor: pointer; }
.clew-pdf-overlay { position: fixed; inset: 0; z-index: 2147483000; display: flex; flex-direction: column; background: var(--clew-bg-primary, Canvas); color: inherit; }
.clew-pdf-overlay-bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: rgba(128,128,128,0.12); }
.clew-pdf-overlay-bar .clew-pdf-overlay-status { font-size: 0.85em; opacity: 0.75; margin-left: auto; }
.clew-pdf-overlay-bar button { font: inherit; min-height: 38px; padding: 4px 16px; border: none; border-radius: 7px; background: rgba(128,128,128,0.18); color: inherit; cursor: pointer; }
.clew-pdf-overlay-stage { flex: 1; position: relative; }
`;
const ensureCanvasPdfStyles = () => {
	if (document.getElementById('clew-canvas-pdf-css')) return;
	const style = document.createElement('style');
	style.id = 'clew-canvas-pdf-css';
	style.textContent = CANVAS_PDF_CSS;
	document.head.append(style);
};

const CANVAS_DRAW_TOOLS = new Set(['ink', 'inkHighlighter', 'circle', 'square',
	'line', 'lineArrow', 'polyline', 'polygon']);
let canvasPdfOverlay = null; // one at a time

async function openCanvasPdfAnnotator({ src, rel, onSaved }) {
	if (canvasPdfOverlay) return;
	ensureCanvasPdfStyles();
	const root = document.createElement('div');
	root.className = 'clew-pdf-overlay';
	canvasPdfOverlay = root;
	const bar = document.createElement('div');
	bar.className = 'clew-pdf-overlay-bar';
	const title = document.createElement('span');
	title.textContent = rel.split('/').pop() ?? rel;
	const status = document.createElement('span');
	status.className = 'clew-pdf-overlay-status';
	const doneBtn = document.createElement('button');
	doneBtn.textContent = 'Done';
	bar.append(title, status, doneBtn);
	const stage = document.createElement('div');
	stage.className = 'clew-pdf-overlay-stage';
	root.append(bar, stage);
	document.body.append(root);
	const setStatus = (text) => { status.textContent = text; };

	let savedAny = false;
	let saveTimer = null;
	let saving = false;
	let saveAgain = false;
	let saveNow = async () => {};
	let drawToolActive = false;
	let container = null;

	// Pencil-aware inking, scoped to the overlay: once a Pencil has been
	// seen (ios-ui's canvas tracking), a finger PANS while a draw tool is
	// active instead of inking. Their layers set touch-action: none, so
	// the pan is manual against the viewer's scroller.
	let pan = null;
	const findScroller = (x, y) => {
		let el = container?.shadowRoot?.elementFromPoint?.(x, y) ?? null;
		while (el) {
			if (el.scrollHeight > el.clientHeight + 1) {
				const overflow = getComputedStyle(el).overflowY;
				if (overflow === 'auto' || overflow === 'scroll') return el;
			}
			el = el.parentElement ?? el.getRootNode()?.host ?? null;
		}
		return null;
	};
	const onDown = (e) => {
		if (e.pointerType !== 'touch' || !pencilSeen || pan || !drawToolActive) return;
		if (!e.composedPath().includes(root)) return;
		const scroller = findScroller(e.clientX, e.clientY);
		if (!scroller) return;
		e.stopImmediatePropagation();
		e.preventDefault();
		pan = { pointerId: e.pointerId, scroller, x: e.clientX, y: e.clientY };
	};
	const onMove = (e) => {
		if (!pan || e.pointerId !== pan.pointerId) return;
		e.stopImmediatePropagation();
		e.preventDefault();
		pan.scroller.scrollLeft += pan.x - e.clientX;
		pan.scroller.scrollTop += pan.y - e.clientY;
		pan.x = e.clientX;
		pan.y = e.clientY;
	};
	const onUp = (e) => {
		if (!pan || e.pointerId !== pan.pointerId) return;
		e.stopImmediatePropagation();
		pan = null;
	};
	document.addEventListener('pointerdown', onDown, true);
	document.addEventListener('pointermove', onMove, true);
	document.addEventListener('pointerup', onUp, true);
	document.addEventListener('pointercancel', onUp, true);

	const close = () => {
		document.removeEventListener('pointerdown', onDown, true);
		document.removeEventListener('pointermove', onMove, true);
		document.removeEventListener('pointerup', onUp, true);
		document.removeEventListener('pointercancel', onUp, true);
		clearTimeout(saveTimer);
		root.remove();
		canvasPdfOverlay = null;
		if (savedAny) onSaved?.();
	};
	doneBtn.addEventListener('click', async () => {
		if (saveTimer) { clearTimeout(saveTimer); await saveNow(); }
		close();
	});

	try {
		setStatus('loading…');
		const [{ default: EmbedPDF }, buffer] = await Promise.all([
			loadEmbedPdfApp(),
			fetch(src).then((response) => response.arrayBuffer()),
		]);
		container = EmbedPDF.init({
			type: 'container',
			target: stage,
			wasmUrl: new URL(`${EMBEDPDF_APP_ASSETS}/pdfium.wasm`, location.href).href,
			// Module-worker spawns never come up under the clew-app scheme
			// (verified 2026-08-24; the same worker engine runs fine in
			// clew-preview documents). The overlay is modal, so the
			// main-thread direct engine is acceptable here.
			worker: false,
			fontFallback: null, // airgapped
			fonts: { ui: null, signature: null },
			theme: { preference: document.body.dataset.theme === 'light' ? 'light' : 'dark' },
			tabBar: 'never',
		});
		if (!container) throw new Error('EmbedPDF.init returned nothing');
		const registry = await container.registry;
		window.__clewCanvasPdfRegistry = registry; // smoke-test hook
		const docManager = registry.getPlugin('document-manager')?.provides();
		await docManager.openDocumentBuffer({
			buffer,
			name: rel.split('/').pop() ?? 'document.pdf',
		}).toPromise();
		setStatus('');
		const exportCap = registry.getPlugin('export')?.provides();
		const annotationCap = registry.getPlugin('annotation')?.provides();
		saveNow = async () => {
			if (saving) { saveAgain = true; return; }
			saving = true;
			setStatus('saving…');
			try {
				const bytes = new Uint8Array(await exportCap.saveAsCopy().toPromise());
				await bridgeCall('updateBinary', { rel, base64: toBase64(bytes) });
				savedAny = true;
				setStatus('saved');
			} catch (err) {
				console.warn('[clew-ios] canvas pdf autosave failed:', err);
				setStatus('save failed');
			} finally {
				saving = false;
				if (saveAgain) { saveAgain = false; saveNow(); }
			}
		};
		annotationCap?.onAnnotationEvent((event) => {
			if (event.type === 'loaded') return;
			setStatus('unsaved');
			clearTimeout(saveTimer);
			saveTimer = setTimeout(saveNow, 2500);
		});
		annotationCap?.onActiveToolChange((event) => {
			const tool = event && typeof event === 'object' && 'tool' in event ? event.tool : event;
			drawToolActive = !!tool && CANVAS_DRAW_TOOLS.has(tool.id);
		});
	} catch (err) {
		console.warn('[clew-ios] canvas pdf annotator failed:', err);
		setStatus(`failed — ${err?.message ?? err}`);
	}
}

const upgradeCanvasPdfFrames = () => {
	for (const iframe of document.querySelectorAll('iframe.canvas-pdf-frame')) {
		ensureCanvasPdfStyles();
		const src = iframe.src;
		const rel = vaultRelOf(src, location.href);
		const host = document.createElement('div');
		// Keep the vendored class: it carries the node layout (flex sizing).
		host.className = 'canvas-pdf-frame clew-canvas-pdf';
		const annotate = document.createElement('button');
		annotate.className = 'clew-canvas-pdf-annotate';
		annotate.textContent = '✎ Annotate';
		annotate.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			openCanvasPdfAnnotator({ src, rel, onSaved: () => {
				annotate.remove();
				canvasPdfReader.remount(host, src);
				host.append(annotate);
			} });
		});
		iframe.replaceWith(host);
		canvasPdfReader.mount(host, src);
		host.append(annotate);
	}
};
let canvasPdfSweep = null;
new MutationObserver(() => {
	clearTimeout(canvasPdfSweep);
	canvasPdfSweep = setTimeout(() => {
		canvasPdfReader.teardown((state) => !state.host.isConnected);
		upgradeCanvasPdfFrames();
	}, 100);
}).observe(document.body, { childList: true, subtree: true });
upgradeCanvasPdfFrames();

// ---- canvas media engages on a single tap ---------------------------------
// Canvas node content is inert until the node is "engaged" (double-click on
// desktop) — so a tap on a video's play button hit an inert overlay. On
// touch, a single tap on a node holding playable/interactive content
// engages it via the canvas's own dblclick path; the next tap reaches the
// controls. Non-media nodes keep desktop semantics.
document.addEventListener('click', (e) => {
	if (lastPointerType !== 'touch') return;
	const node = e.target.closest?.('.canvas-node');
	if (!node || node.classList.contains('is-engaged')) return;
	if (!node.querySelector('video, audio, iframe, embed, .clew-canvas-pdf')) return;
	node.dispatchEvent(new MouseEvent('dblclick', {
		bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY,
	}));
}, true);

// ---- long-press → contextmenu ---------------------------------------------
// Five surfaces put rename/delete/pin/canvas-styling exclusively behind
// right-click (see PORT-PLAN). WebKit on iOS does not fire contextmenu for
// long-press, so synthesize one: press-and-hold 500ms without moving 10px.
const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE = 10;

let press = null;
let suppressNextClick = false;

document.addEventListener('pointerdown', (e) => {
	if (e.pointerType !== 'touch') return;
	press = {
		x: e.clientX, y: e.clientY, target: e.target,
		timer: setTimeout(() => {
			const { x, y, target } = press ?? {};
			press = null;
			target?.dispatchEvent(new MouseEvent('contextmenu', {
				bubbles: true, cancelable: true, clientX: x, clientY: y,
			}));
			suppressNextClick = true;
		}, LONG_PRESS_MS),
	};
}, true);

const cancelPress = () => { if (press) { clearTimeout(press.timer); press = null; } };
document.addEventListener('pointermove', (e) => {
	if (!press) return;
	if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) cancelPress();
}, true);
document.addEventListener('pointerup', cancelPress, true);
document.addEventListener('pointercancel', cancelPress, true);
document.addEventListener('click', (e) => {
	if (suppressNextClick) {
		suppressNextClick = false;
		e.stopPropagation();
		e.preventDefault();
	}
}, true);

// ---- wikilinks in the editor on touch -------------------------------------
// Desktop follows [[links]] with Cmd-click. Touch: the first tap places the
// cursor (normal editing); a second tap on the same link — or a long-press
// (which lands here as the synthesized contextmenu) — follows it.
const LINK_RE = /(!?)\[\[([^\[\]|#\n]*)(?:#([^\[\]|\n]+))?(?:\|([^\[\]\n]+))?\]\]/g;

function editorLinkAt(clientX, clientY, target) {
	const content = target.closest?.('.cm-content');
	if (!content) return null;
	const view = EditorView.findFromDOM(content);
	if (!view) return null;
	const pos = view.posAtCoords({ x: clientX, y: clientY });
	if (pos === null) return null;
	const line = view.state.doc.lineAt(pos);
	const column = pos - line.from;
	LINK_RE.lastIndex = 0;
	let match;
	while ((match = LINK_RE.exec(line.text)) !== null) {
		if (column >= match.index && column <= match.index + match[0].length) {
			return {
				view,
				from: line.from + match.index,
				to: line.from + match.index + match[0].length,
				target: match[2].trim() + (match[3] ? `#${match[3].trim()}` : ''),
			};
		}
	}
	return null;
}

let preTapHead = null;
let lastPointerType = 'mouse';
document.addEventListener('pointerdown', (e) => {
	lastPointerType = e.pointerType;
	const content = e.target.closest?.('.cm-content');
	preTapHead = content ? EditorView.findFromDOM(content)?.state.selection.main.head ?? null : null;
}, true);

document.addEventListener('click', (e) => {
	if (lastPointerType !== 'touch') return;
	const link = editorLinkAt(e.clientX, e.clientY, e.target);
	if (!link || !link.target) return;
	if (preTapHead === null || preTapHead < link.from || preTapHead > link.to) return;
	e.preventDefault();
	e.stopPropagation();
	actions.openWikilink(link.target, {});
});

document.addEventListener('contextmenu', (e) => {
	const link = editorLinkAt(e.clientX, e.clientY, e.target);
	if (!link || !link.target) return;
	e.preventDefault();
	e.stopPropagation();
	actions.openWikilink(link.target, {});
}, true);

// ---- Pencil-aware canvas input --------------------------------------------
// Once an Apple Pencil has been used, fingers stop inking: while an ink-ish
// tool is active, a single finger PANS the canvas instead of drawing, and a
// resting palm can neither draw nor long-press its way into the context
// menu (which was silently selecting nodes under the writing hand). The
// select/pan tools keep full finger behavior — switching tools is the
// escape hatch — and the Pencil always applies the active tool.
let pencilSeen = false;
document.addEventListener('pointerdown', (e) => {
	if (e.pointerType === 'pen') pencilSeen = true;
}, true);

const INKY_TOOLS = new Set(['draw', 'erase', 'rectangle', 'ellipse', 'diamond', 'arrow', 'line']);

const fingerShouldPan = (viewport) => {
	if (!pencilSeen) return false;
	const view = viewport.closest('clew-canvas-view');
	const active = view?.querySelector('.canvas-toolbar .canvas-tool.is-active:not(.canvas-width)');
	return INKY_TOOLS.has((active?.title ?? '').split(' (')[0].toLowerCase());
};

// ---- canvas touch navigation ----------------------------------------------
// Desktop pans/zooms the canvas with the wheel (plain = pan, ctrl = zoom at
// cursor). Touch: one finger keeps its tool meaning (Pencil draws, finger
// marquees/drags); TWO fingers navigate — pan with the centroid, pinch to
// zoom — translated into the synthetic wheel events the canvas's existing
// #onWheel already understands. When the second finger lands, the
// in-progress single-finger interaction is cancelled with a synthesized
// pointercancel so a marquee or stray stroke never commits.
const canvasTouches = new Map(); // pointerId -> {x, y}
let gestureViewport = null;
let gestureLast = null; // {cx, cy, dist}

const viewportOf = (target) => target.closest?.('.canvas-viewport') ?? null;

const syntheticWheel = (viewport, { dx = 0, dy = 0, zoom = null, cx, cy }) => {
	viewport.dispatchEvent(new WheelEvent('wheel', {
		bubbles: true,
		cancelable: true,
		clientX: cx,
		clientY: cy,
		deltaX: dx,
		deltaY: zoom !== null ? -Math.log(zoom) / 0.01 : dy,
		ctrlKey: zoom !== null,
	}));
};

let singlePan = null; // {viewport, pointerId, x, y} — finger-pan while inking

document.addEventListener('pointerdown', (e) => {
	if (e.pointerType !== 'touch') return;
	const viewport = viewportOf(e.target);
	if (!viewport) return;
	canvasTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
	if (canvasTouches.size === 1 && fingerShouldPan(viewport)) {
		// Swallow before the canvas can start a stroke; moves become pans.
		singlePan = { viewport, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
		cancelPress();
		e.stopPropagation();
		e.preventDefault();
		return;
	}
	if (canvasTouches.size === 2) {
		// Take over: cancel the first finger's tool interaction, swallow the
		// second finger before the canvas sees it.
		gestureViewport = viewport;
		gestureLast = null;
		singlePan = null;
		cancelPress();
		e.stopPropagation();
		e.preventDefault();
		for (const id of canvasTouches.keys()) {
			if (id !== e.pointerId) {
				viewport.dispatchEvent(new PointerEvent('pointercancel', {
					bubbles: true, pointerId: id, pointerType: 'touch',
				}));
			}
		}
	}
}, true);

document.addEventListener('pointermove', (e) => {
	if (singlePan && e.pointerId === singlePan.pointerId && !gestureViewport) {
		canvasTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
		e.stopPropagation();
		e.preventDefault();
		const dx = singlePan.x - e.clientX;
		const dy = singlePan.y - e.clientY;
		if (dx || dy) syntheticWheel(singlePan.viewport, { dx, dy, cx: e.clientX, cy: e.clientY });
		singlePan.x = e.clientX;
		singlePan.y = e.clientY;
		return;
	}
	if (!gestureViewport || !canvasTouches.has(e.pointerId)) return;
	canvasTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
	e.stopPropagation();
	e.preventDefault();
	const points = [...canvasTouches.values()];
	if (points.length < 2) return;
	const cx = (points[0].x + points[1].x) / 2;
	const cy = (points[0].y + points[1].y) / 2;
	const dist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
	if (gestureLast) {
		const dx = gestureLast.cx - cx;
		const dy = gestureLast.cy - cy;
		if (dx || dy) syntheticWheel(gestureViewport, { dx, dy, cx, cy });
		const scale = dist / gestureLast.dist;
		if (Math.abs(scale - 1) > 0.004) syntheticWheel(gestureViewport, { zoom: scale, cx, cy });
	}
	gestureLast = { cx, cy, dist };
}, true);

const endCanvasTouch = (e) => {
	if (e.pointerType !== 'touch') return;
	if (singlePan && e.pointerId === singlePan.pointerId) {
		singlePan = null;
		canvasTouches.delete(e.pointerId);
		e.stopPropagation();
		e.preventDefault();
		return;
	}
	const wasGesture = gestureViewport && canvasTouches.has(e.pointerId);
	canvasTouches.delete(e.pointerId);
	if (wasGesture) {
		e.stopPropagation();
		e.preventDefault();
		gestureLast = null;
		if (canvasTouches.size < 2) gestureViewport = null;
	}
};
document.addEventListener('pointerup', endCanvasTouch, true);
document.addEventListener('pointercancel', (e) => {
	if (e.isTrusted) endCanvasTouch(e);
}, true);

// ---- device classes -------------------------------------------------------
document.body.classList.add('is-ios');
const compact = matchMedia('(max-width: 700px)');
const syncCompact = () => document.body.classList.toggle('is-compact', compact.matches);
syncCompact();
compact.addEventListener('change', syncCompact);

// ---- toolbar --------------------------------------------------------------
// With no native menu and (usually) no hardware keyboard, commands need a
// visible surface. The palette command covers the long tail; the toolbar
// covers the constant motions.
const BUTTONS = [
	['☰', 'Sidebar', 'workspace:toggle-left-sidebar'],
	['‹', 'Back', 'nav:back'],
	['›', 'Forward', 'nav:forward'],
	['＋', 'New note', 'file:new-note'],
	['⌕', 'Find note', 'nav:quick-switcher'],
	['⌘', 'Commands', 'app:command-palette'],
	['👁', 'Read/Edit', 'workspace:toggle-mode'],
	['ⓘ', 'Panels', 'workspace:toggle-right-sidebar'],
];

const toolbar = document.createElement('div');
toolbar.className = 'ios-toolbar';
let modeButton = null;
for (const [glyph, label, command] of BUTTONS) {
	const button = document.createElement('button');
	button.className = 'ios-toolbar-button';
	button.textContent = glyph;
	button.title = label;
	button.setAttribute('aria-label', label);
	// pointerdown, not click: the editor keeps focus/keyboard, and the
	// synthetic-click suppressor never interferes.
	button.addEventListener('pointerdown', (e) => {
		e.preventDefault();
		runCommand(command);
	});
	if (command === 'workspace:toggle-mode') modeButton = button;
	toolbar.append(button);
}
document.body.append(toolbar);

// The mode button mirrors the active note tab: 👁 = "switch to reading",
// ✎ = "switch to editing"; dimmed when the active tab is not a note.
const syncModeButton = () => {
	const tab = workspaceStore.activeTab();
	const isNote = tab?.kind === 'note';
	modeButton.style.opacity = isNote ? '' : '0.35';
	modeButton.textContent = isNote && tab.view?.mode === 'reading' ? '✎' : '👁';
	modeButton.title = isNote && tab.view?.mode === 'reading' ? 'Edit' : 'Read';
};
for (const event of ['layout-changed', 'active-changed']) {
	workspaceStore.on(event, syncModeButton);
}
syncModeButton();

// ---- compact-mode sidebar behavior ---------------------------------------
// Sidebars overlay the workspace on phones (ios.css); tapping the workspace
// closes them, and they start closed.
// Unconditional setSidebar even when already closed: restore() swaps the
// state object and emits only layout-changed, which clew-app does not
// re-apply to the sidebar DOM — the commit here re-syncs it. (Upstream
// candidate: #applySidebars on layout-changed.)
const closeSidebars = () => {
	for (const side of ['left', 'right']) {
		workspaceStore.setSidebar(side, { open: false });
	}
};

if (compact.matches) {
	// The workspace restore re-opens whatever the (possibly desktop-synced)
	// workspace.json persisted. Restore's commit is the first layout-changed:
	// close once right after it, so the user's own toggles stay untouched.
	const unsubscribe = workspaceStore.on('layout-changed', () => {
		unsubscribe();
		setTimeout(closeSidebars, 30);
	});
	window.clew.on('clew:ev-vault-opened', () => setTimeout(closeSidebars, 50));
	document.addEventListener('pointerdown', (e) => {
		if (e.target.closest('.sidebar, .sidebar-resizer, .ios-toolbar, .tool-tabs')) return;
		closeSidebars();
	}, true);
}
