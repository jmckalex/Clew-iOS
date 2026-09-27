// iOS touch adaptations layered over the unmodified renderer. Kept small
// and additive: anything structural belongs upstream behind a capability
// check, not here.
import { EditorView } from '@codemirror/view';
import { runCommand } from '../../vendor/clew/renderer/commands/registry.js';
import { workspaceStore } from '../../vendor/clew/renderer/state/workspace-store.js';
import { vaultStore } from '../../vendor/clew/renderer/state/vault-store.js';
import * as actions from '../../vendor/clew/renderer/commands/actions.js';
import { linkAt } from '../../vendor/clew/renderer/editor/link-at.js';
import { showCitation } from '../../vendor/clew/renderer/editor/live/events.js';
import { numberDocument } from '../../vendor/clew/renderer/editor/live/numbering.js';
import { openExternal } from '../../vendor/clew/renderer/lib/external-links.js';
// PDFs are no longer special-cased on iOS. Every PDF surface — note embeds,
// file tabs, canvas nodes, and canvas-embed scenes — is upstream's EmbedPDF
// viewer running in a clew-preview document, saving through CH.PDF_WRITE
// (src/shim/ipc.js) into the native coordinated write. What used to live here
// (a QuickLook override for .pdf tabs, a clew-pdf-save listener, a PDF.js
// reader for canvas nodes, and an ✎ Annotate overlay) was a parallel
// implementation of the same thing and is gone; the `quickLook` bridge itself
// stays available for anything that wants the system reader.

// ---- canvas nodes engage on a double tap ----------------------------------
// A canvas node's content is inert until the node is "engaged" (canvas.css:
// `.canvas-node > * { pointer-events: none }`); upstream engages on dblclick
// and disengages on a pointerdown outside.
//
// iOS used to engage a node holding <video>/<iframe>/<embed> on a SINGLE
// tap. That armed exactly the nodes whose content is worth touching — video,
// web pages, PDFs — on the very tap that selected them, and an armed node
// looked no different from a selected one, so the NEXT tap went somewhere
// the reader had not predicted. One gesture for every node type is easier
// to hold in the head, and a double tap cannot be mistaken for the tap that
// begins a drag. The armed state is legible now: its own border colour
// (ios.css) and no resize handles (scripts/build.js).
//
// WebKit does synthesize dblclick from a double tap, but the viewport's
// `touch-action: none` and the two-finger layer below both sit in that
// path, so the gesture is recognised here too — and dispatched only when no
// native dblclick arrived first, since a second one would open a .canvas
// node in two tabs.
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_SLOP = 24;
const NATIVE_DBLCLICK_GRACE = 60;

let lastTap = null; // {x, y, at, node}
let nativeDblclickAt = -Infinity;

// A note embedded in a canvas node cannot scroll its own root scroller under
// the canvas's scale transform, so the frame is asked to scroll its body
// instead (src/preview/embed-scroll.js has the measurement and the reasoning).
// Sent on engage, which is the moment before the first drag; the preview
// client ignores it (it answers only to `clew-preview-host`), and so does
// every frame without our module in it.
const armEmbedScroll = (node) => {
	const frame = node?.querySelector?.('.canvas-note-frame');
	if (!frame) return;
	const post = () => {
		try {
			frame.contentWindow?.postMessage({ source: 'clew-ios', type: 'canvas-embed' }, '*');
		} catch { /* frame not ready; the load listener below covers it */ }
	};
	post();
	if (frame.dataset.clewEmbedScroll) return;
	frame.dataset.clewEmbedScroll = '1';
	frame.addEventListener('load', post); // a re-rendered frame loses the style
};

document.addEventListener('dblclick', (e) => {
	nativeDblclickAt = performance.now();
	armEmbedScroll(e.target.closest?.('.canvas-node'));
}, true);

document.addEventListener('click', (e) => {
	if (lastPointerType !== 'touch') return;
	const node = e.target.closest?.('.canvas-node');
	// An engaged node's taps are its content's; a card being edited owns its
	// textarea. Neither starts a fresh double tap.
	if (!node || node.classList.contains('is-engaged') || node.classList.contains('is-editing')) {
		lastTap = null;
		return;
	}
	const at = performance.now();
	const first = lastTap;
	lastTap = { x: e.clientX, y: e.clientY, at, node };
	if (!first || first.node !== node) return;
	if (at - first.at > DOUBLE_TAP_MS) return;
	if (Math.hypot(e.clientX - first.x, e.clientY - first.y) > DOUBLE_TAP_SLOP) return;
	lastTap = null;
	const { clientX, clientY } = e;
	// WebKit's own dblclick, if it comes at all, lands just after this click.
	setTimeout(() => {
		if (performance.now() - nativeDblclickAt < NATIVE_DBLCLICK_GRACE) return;
		node.dispatchEvent(new MouseEvent('dblclick', {
			bubbles: true, cancelable: true, clientX, clientY,
		}));
	}, NATIVE_DBLCLICK_GRACE);
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
	// Inside an engaged node the press belongs to the content — a live web
	// page or PDF has its own press-and-hold.
	if (e.target.closest?.('.canvas-node.is-engaged')) return;
	press = {
		x: e.clientX, y: e.clientY, target: e.target,
		timer: setTimeout(() => {
			const { x, y, target } = press ?? {};
			press = null;
			lastTap = null; // a long press never opens a double tap

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

// ---- links in the editor on touch --------------------------------------
// Desktop follows a source-mode link with ⌘-click (wikilink-click.js) and a
// LIVE-mode concealed link with a plain click (live/events.js: click
// follows, ⌥-click places the caret, ⌘-click opens a new tab). Touch has
// one tap and no modifiers, so the two modes get one convention each,
// documented in the guide as the one place their gestures differ:
//
//   source mode   the first tap places the caret (normal editing); a
//                 second tap on the same link — or a long-press — follows
//                 it. Links are read through upstream's link-at.js, so a
//                 [[wikilink]], a [text](url), a \cite{key} and an
//                 @ref[label] all follow, exactly as ⌘-click would.
//   live mode     a tap on a concealed link IS upstream's click and
//                 follows (WebKit synthesises the mousedown liveEvents
//                 wants); the port's second-tap rule stands OFF such
//                 targets, or the note would open twice. ⌥ has no touch
//                 equivalent, so the long-press — which already
//                 synthesises contextmenu — is it: a long-press on any
//                 concealed stand-in (a link, a chip, an image, a maths
//                 widget, a frame's placeholder) places the caret there,
//                 upstream's own placeCursor, which reveals the source.
//                 Table cells are left to upstream's contextmenu handler
//                 (the table menu), which is the only one it has.

/** The concealed stand-ins liveEvents acts on (its TARGETS, mirrored). */
const LIVE_TARGETS = '[data-le-cite],[data-le-cell],[data-le-task],[data-le-fold],[data-le-copy],[data-le-goto],[data-le-command],[data-le-href],[data-le-target],[data-le-tag],[data-le-ref],[data-le-blockid],.le-reveal-on-click';
/** What a long-press reveals, beyond those: every rendered stand-in. */
const LIVE_REVEALABLE = `${LIVE_TARGETS},.le-math,.le-math-block,.le-image,.le-image-block,.le-frame-slot,.le-frame-edge,.le-chip,.le-hr,.le-fence-head,.le-table-wrap`;

const viewOf = (target) => {
	const content = target?.closest?.('.cm-content');
	return content ? EditorView.findFromDOM(content) : null;
};

/** The source-mode link under a point, through link-at.js. */
function editorLinkAt(clientX, clientY, target) {
	const view = viewOf(target);
	if (!view) return null;
	const pos = view.posAtCoords({ x: clientX, y: clientY });
	if (pos === null) return null;
	const line = view.state.doc.lineAt(pos);
	const link = linkAt(line.text, pos - line.from);
	if (!link) return null;
	return { view, link, from: line.from + link.from, to: line.from + link.to };
}

/** Follow a source-mode link the way ⌘-click (and a live-mode click) would. */
function followLink(view, link) {
	switch (link.kind) {
		case 'wikilink':
			if (link.embed && !link.target) return false;
			if (link.external && link.target) { actions.openFileExternally(link.target); return true; }
			if (!link.target && !link.heading) return false;
			actions.openWikilink(link.target + (link.heading ? `#${link.heading}` : ''), {});
			return true;
		case 'markdown': {
			const url = link.url;
			if (!url) return false;
			if (/^[a-z][a-z0-9+.-]*:/i.test(url)) openExternal(url);
			else actions.openWikilink(decodeURI(url).replace(/\.(md|jmd)$/i, ''), {});
			return true;
		}
		case 'cite':
			showCitation(link.keys[0]);
			return true;
		case 'xref': {
			// As live/events.js does for a concealed @ref: jump to the label,
			// leaving a Back entry.
			const target = numberDocument(view.state.doc).labels.get(link.key);
			if (!target) return false;
			const from = view.state.doc.lineAt(view.state.selection.main.head).number;
			const at = view.state.doc.line(Math.min(target.line, view.state.doc.lines)).from;
			const tab = workspaceStore.activeTab();
			if (tab) workspaceStore.recordAnchorJump(tab.id, from, target.line, { editor: true });
			view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) });
			view.focus();
			return true;
		}
		default:
			return false;
	}
}

/** Upstream's placeCursor: the caret at `pos`, which reveals the construct. */
function placeCursor(view, pos) {
	view.dispatch({ selection: { anchor: pos } });
	view.focus();
}

let preTapHead = null;
let lastPointerType = 'mouse';
document.addEventListener('pointerdown', (e) => {
	lastPointerType = e.pointerType;
	preTapHead = viewOf(e.target)?.state.selection.main.head ?? null;
}, true);

document.addEventListener('click', (e) => {
	if (lastPointerType !== 'touch') return;
	// Live mode's concealed stand-ins are liveEvents' — its mousedown has
	// already followed the link (or revealed the construct); a second open
	// from here would be one too many.
	if (e.target.closest?.('.cm-live') && e.target.closest?.(LIVE_TARGETS)) return;
	const hit = editorLinkAt(e.clientX, e.clientY, e.target);
	if (!hit) return;
	if (preTapHead === null || preTapHead < hit.from || preTapHead > hit.to) return;
	if (!followLink(hit.view, hit.link)) return;
	e.preventDefault();
	e.stopPropagation();
});

document.addEventListener('contextmenu', (e) => {
	const view = viewOf(e.target);
	if (!view) return;
	if (view.dom.classList.contains('cm-live')) {
		// A table cell's contextmenu is upstream's (the table menu).
		if (e.target.closest?.('[data-le-cell]')) return;
		const el = e.target.closest?.(LIVE_REVEALABLE);
		if (!el || !view.contentDOM.contains(el)) return;
		e.preventDefault();
		e.stopPropagation();
		// A frame's slot sits at its fence's first line; posAtDOM of the
		// slot (or its edge) is that line, as upstream reveals it.
		placeCursor(view, view.posAtDOM(el));
		return;
	}
	const hit = editorLinkAt(e.clientX, e.clientY, e.target);
	if (!hit) return;
	if (!followLink(hit.view, hit.link)) return;
	e.preventDefault();
	e.stopPropagation();
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
	// Touches that land inside an engaged node are the content's: two fingers
	// scroll and pinch the embedded page, they do not pan the canvas. They are
	// not recorded, so they cannot combine with a finger on the canvas either.
	if (e.target.closest?.('.canvas-node.is-engaged')) return;
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

// ---- first-open greeting --------------------------------------------------
// Upstream opens a vault's root Welcome.md when the vault opens with no
// saved workspace — in the renderer's EV_VAULT_OPENED handler, which is
// what a desktop launch goes through. iOS boots through the VAULT_CURRENT
// branch instead (desktop's "window reload" path), which never fires that
// event, so the seeded demo vault came up on an empty pane the first time.
// Apply the same rule after every restore commit: the boot one, and each
// vault switch. Idempotent with the upstream handler — whichever runs
// first opens the note; the other sees a tab and does nothing.
let greetPending = true;
window.clew.on('clew:ev-vault-opened', () => { greetPending = true; });
workspaceStore.on('layout-changed', () => {
	if (!greetPending) return;
	greetPending = false;
	if (workspaceStore.openTabIds().size === 0 && vaultStore.pathExists('Welcome.md')) {
		workspaceStore.openNote('Welcome.md');
	}
});

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
