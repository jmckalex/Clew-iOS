// iOS touch adaptations layered over the unmodified renderer. Kept small
// and additive: anything structural belongs upstream behind a capability
// check, not here.
import { EditorView } from '@codemirror/view';
import { runCommand } from '../../vendor/clew/renderer/commands/registry.js';
import { workspaceStore } from '../../vendor/clew/renderer/state/workspace-store.js';
import * as actions from '../../vendor/clew/renderer/commands/actions.js';

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
	['¶', 'Read/Edit', 'workspace:toggle-mode'],
	['ⓘ', 'Panels', 'workspace:toggle-right-sidebar'],
];

const toolbar = document.createElement('div');
toolbar.className = 'ios-toolbar';
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
	toolbar.append(button);
}
document.body.append(toolbar);

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
