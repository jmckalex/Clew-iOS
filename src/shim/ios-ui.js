// iOS touch adaptations layered over the unmodified renderer. Kept small
// and additive: anything structural belongs upstream behind a capability
// check, not here.
import { EditorView } from '@codemirror/view';
import { runCommand } from '../../vendor/clew/renderer/commands/registry.js';
import { workspaceStore } from '../../vendor/clew/renderer/state/workspace-store.js';
import { vaultStore } from '../../vendor/clew/renderer/state/vault-store.js';
import * as actions from '../../vendor/clew/renderer/commands/actions.js';
// PDFs are no longer special-cased on iOS. Every PDF surface — note embeds,
// file tabs, canvas nodes, and canvas-embed scenes — is upstream's EmbedPDF
// viewer running in a clew-preview document, saving through CH.PDF_WRITE
// (src/shim/ipc.js) into the native coordinated write. What used to live here
// (a QuickLook override for .pdf tabs, a clew-pdf-save listener, a PDF.js
// reader for canvas nodes, and an ✎ Annotate overlay) was a parallel
// implementation of the same thing and is gone; the `quickLook` bridge itself
// stays available for anything that wants the system reader.

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
	if (!node.querySelector('video, audio, iframe, embed')) return;
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
