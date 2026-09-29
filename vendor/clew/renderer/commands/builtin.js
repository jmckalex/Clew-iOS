// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Built-in commands: everything the palette and hotkeys can do. Registered
// once at boot. Chord notation is CodeMirror's ('Mod-Shift-p').
import { registerCommand, buildContext, allCommands, isEnabled, effectiveKeymap } from './registry.js';
import { openSearchPanel } from '@codemirror/search';
import { deleteGroupForward } from '@codemirror/commands';
import { registerFormatCommands, activeEditorView, activeMainView, formatTableKeepingCell, needsEditor } from './format.js';
import { formatTableAtCursor } from '../editor/tables.js';
import { fillAtCursor } from '../editor/fill.js';
import { blockRefEdit, blockRefLink } from '../editor/block-ids.js';
import { openDiaryDay } from './diary.js';
import { notice } from '../plugins.js';
import { substituteTemplate } from '../../shared/diary.js';
import * as actions from './actions.js';
import { workspaceStore } from '../state/workspace-store.js';
import { vaultStore, isNotePath } from '../state/vault-store.js';
import { settingsStore } from '../state/settings-store.js';
import { bookmarkStore } from '../state/bookmark-store.js';
import { editorPool } from '../editor/pool.js';
import { openQuickSwitcher } from '../components/modals/clew-quick-switcher.js';
import { extractAnnotations } from '../pdf-annotations.js';
import { openListModal } from '../components/modals/list-modal.js';
import { openHistoryModal } from '../components/modals/clew-history-modal.js';
import { ipc, CH } from '../ipc.js';

const needsVault = (ctx) => ctx.vaultOpen;
const needsNote = (ctx) => ctx.notePath !== null;

function templateFiles() {
	const folder = (settingsStore.get('templatesFolder') ?? 'Templates').toLowerCase();
	return vaultStore.notePaths().filter((p) => p.toLowerCase().startsWith(folder + '/'));
}

function insertTemplate() {
	const ctx = buildContext();
	const entry = editorPool.get(ctx.activeTab?.id);
	if (!entry?.view) return;
	const items = templateFiles().map((path) => ({
		label: path.split('/').pop().replace(/\.(md|jmd)$/i, ''),
		detail: path,
		run: async () => {
			const raw = await ipc.invoke(CH.NOTE_READ, { path }).catch(() => null);
			if (raw === null) return;
			const title = ctx.notePath?.split('/').pop().replace(/\.(md|jmd)$/i, '') ?? '';
			const text = substituteTemplate(raw, { title });
			const { view } = entry;
			view.dispatch(view.state.replaceSelection(text));
			view.focus();
		},
	}));
	openListModal({ placeholder: 'Insert template…', items, emptyText: 'No templates found (folder: Templates/)' });
}

/**
 * Obsidian's "Copy link to block": name the block under the cursor, writing
 * the marker into the note if it has none, and put `[[Note#^id]]` on the
 * clipboard. Running it twice on the same block copies the same link — the
 * marker is only ever written once.
 */
async function copyBlockReference() {
	const ctx = buildContext();
	const view = activeEditorView();
	if (!view || !ctx.notePath) return;
	const { state } = view;
	const lineNo = state.doc.lineAt(state.selection.main.head).number - 1;
	const edit = blockRefEdit(state.doc.toString().split('\n'), lineNo);
	if (!edit) { notice('Put the cursor inside a block first'); return; }

	if (edit.insert) {
		const line = state.doc.line(edit.insert.line + 1);
		view.dispatch({
			changes: { from: line.from + edit.insert.column, insert: edit.insert.text },
			userEvent: 'input.blockid',
		});
		// The link is only good once the marker is on disk, since resolving it
		// reads the indexed file rather than the editor.
		editorPool.flush(ctx.activeTab.id);
	}
	const link = blockRefLink(ctx.notePath, edit.id, (name) => vaultStore.resolveNoteName(name));
	// The clipboard refuses an unfocused document. The marker is written
	// either way, so say what the link is rather than failing silently — it
	// can be retyped, and running the command again will copy it.
	try {
		await navigator.clipboard.writeText(link);
		notice(`Copied ${link}`);
	} catch {
		notice(`Block reference: ${link}`);
	}
}

async function exportActiveNote(format) {
	const ctx = buildContext();
	if (!ctx.notePath) return;
	editorPool.flush(ctx.activeTab.id);
	try {
		const result = await ipc.invoke(CH.EXPORT_NOTE, { path: ctx.notePath, format });
		if (result?.output) console.log(`Exported to ${result.output}`);
	} catch (err) {
		console.error('Export failed:', err);
		alert(`Export failed: ${err.message ?? err}`);
	}
}

// ---- the commands ----------------------------------------------------------

export function registerBuiltinCommands() {
	const commands = [
		// files
		{ id: 'file:new-note', name: 'Create new note', hotkeys: ['Mod-n'], when: needsVault,
			run: () => document.querySelector('clew-file-explorer')?.createNote?.() },
		{ id: 'file:new-folder', name: 'Create new folder', when: needsVault,
			run: () => document.querySelector('clew-file-explorer')?.createFolder?.('') },
		{ id: 'file:new-canvas', name: 'Create new canvas', when: needsVault,
			run: () => document.querySelector('clew-file-explorer')?.createCanvas?.('') },
		{ id: 'file:new-drawing', name: 'Create new drawing (Excalidraw)', when: needsVault,
			run: () => document.querySelector('clew-file-explorer')?.createDrawing?.('') },
		{ id: 'editor:copy-block-ref', name: 'Copy link to block', when: needsEditor,
			run: () => copyBlockReference() },
		{ id: 'editor:format-table', name: 'Format table at cursor', when: needsEditor,
			run: () => {
				// The note's editor, not a cell being edited in place — a
				// reflow is a whole-table change (and keeps editing the cell).
				const view = activeMainView();
				if (view && !formatTableKeepingCell(view)) formatTableAtCursor(view);
			} },
		{ id: 'editor:fill-paragraph', name: 'Fill paragraph (hard-wrap)', hotkeys: ['Alt-q'],
			when: needsEditor,
			run: () => {
				const view = activeEditorView();
				if (view) fillAtCursor(view, settingsStore.get('fillColumn') ?? 72);
			} },
		// The forward twin of mac's own ⌥⌫, on the Emacs letter. A command
		// rather than a keymap entry so the palette and the hotkey editor
		// see it — and so the dispatcher claims the chord before CodeMirror
		// can type the Option character it produces on mac (`∂`).
		{ id: 'editor:delete-word-forward', name: 'Delete word forward', hotkeys: ['Alt-d'],
			when: needsEditor,
			run: () => {
				const view = activeEditorView();
				if (view) deleteGroupForward(view);
			} },
		{ id: 'file:save', name: 'Save note', hotkeys: ['Mod-s'], when: needsNote,
			run: (ctx) => editorPool.flush(ctx.activeTab.id) },
		{ id: 'file:open-vault', name: 'Open another vault…',
			run: () => ipc.invoke(CH.VAULT_OPEN_DIALOG).catch(() => {}) },
		{ id: 'file:reveal', name: 'Reveal active note in Finder', when: needsNote,
			run: (ctx) => ipc.invoke(CH.FS_REVEAL, { path: ctx.notePath }) },
		{ id: 'file:bookmark', name: 'Bookmark / unbookmark active note', when: needsNote,
			run: (ctx) => bookmarkStore.toggle(ctx.notePath) },
		// Flush first: the newest snapshot comparison and any restore should
		// see the note as it is on screen, not as of the last auto-save.
		{ id: 'file:history', name: 'View note history…', when: needsNote,
			run: (ctx) => {
				editorPool.flush(ctx.activeTab.id);
				openHistoryModal(ctx.notePath);
			} },

		// navigation
		// §5.15: the active PDF tab's annotations, as a note beside it.
		{ id: 'pdf:extract-annotations', name: 'PDF: extract annotations to a note',
			when: (ctx) => ctx.activeTabKind === 'file' && /\.pdf$/i.test(ctx.activeTab?.path ?? ''),
			run: (ctx) => extractAnnotations(ctx.activeTab.path) },
		{ id: 'nav:quick-switcher', name: 'Open quick switcher', hotkeys: ['Mod-o'], when: needsVault,
			inModal: false, run: () => openQuickSwitcher() },
		{ id: 'nav:back', name: 'Navigate back', hotkeys: ['Mod-[', 'Mod-Alt-ArrowLeft'], when: needsVault,
			run: () => actions.historyBack() },
		{ id: 'nav:forward', name: 'Navigate forward', hotkeys: ['Mod-]', 'Mod-Alt-ArrowRight'], when: needsVault,
			run: () => actions.historyForward() },
		// Disabled on a canvas so Mod-g reaches the canvas view, where it means
		// Group — the binding every drawing app uses, and the one users reach
		// for first. The global dispatcher runs in the capture phase and stops
		// propagation, so without this guard the canvas would never see the
		// chord at all. The graph stays reachable from the palette and menu.
		{ id: 'nav:graph', name: 'Open graph view', hotkeys: ['Mod-g'],
			when: (ctx) => needsVault(ctx) && ctx.activeTabKind !== 'canvas',
			run: () => actions.openGraph() },
		{ id: 'nav:search', name: 'Search in all files', hotkeys: ['Mod-Shift-f'], when: needsVault,
			run: () => document.querySelector('clew-app')?.openSearch?.() },
		{ id: 'nav:daily-note', name: "Open today's diary entry", hotkeys: ['Mod-Shift-d'], when: needsVault,
			run: () => openDiaryDay(new Date()) },
		{ id: 'nav:diary', name: 'Open diary calendar', when: needsVault,
			run: () => workspaceStore.setSidebar('left', { open: true, activeTool: 'diary' }) },

		// workspace
		{ id: 'workspace:close-tab', name: 'Close tab', hotkeys: ['Mod-w'],
			run: () => actions.closeActiveTab() },
		{ id: 'workspace:pin-tab', name: 'Pin / unpin tab',
			when: (ctx) => ctx.activeTab != null,
			run: (ctx) => workspaceStore.pinTab(ctx.activeTab.id, !ctx.activeTab.pinned) },
		{ id: 'workspace:new-tab', name: 'New tab', hotkeys: ['Mod-t'],
			run: () => actions.newTab() },
		// Ctrl-Tab everywhere: on mac Ctrl is a real modifier (Cmd-Tab belongs
		// to the app switcher); away from mac normalizeChord folds it to Mod.
		{ id: 'workspace:next-tab', name: 'Next tab', hotkeys: ['Ctrl-Tab'],
			run: () => cycleTab(1) },
		{ id: 'workspace:prev-tab', name: 'Previous tab', hotkeys: ['Ctrl-Shift-Tab'],
			run: () => cycleTab(-1) },
		{ id: 'workspace:split-right', name: 'Split right', hotkeys: ['Mod-\\'],
			run: () => actions.splitActive('right') },
		{ id: 'workspace:split-down', name: 'Split down', hotkeys: ['Mod-Shift-\\'],
			run: () => actions.splitActive('bottom') },
		// The id stays `close-split` though the name no longer says so: hotkey
		// customisations are persisted against command ids, and renaming it
		// would silently orphan anyone's rebinding of ⌘⇧W.
		{ id: 'workspace:close-split', name: 'Close current pane', hotkeys: ['Mod-Shift-w'],
			when: () => workspaceStore.allGroups().length > 1,
			run: () => actions.closeCurrentPane() },
		{ id: 'workspace:close-other-pane', name: 'Close other pane',
			when: () => workspaceStore.allGroups().length > 1,
			run: () => actions.closeOtherPane() },
		{ id: 'workspace:toggle-mode', name: 'Toggle reading mode', hotkeys: ['Mod-e'], when: needsNote,
			run: () => actions.toggleReadingMode() },
		// Live edit (docs/dev/live-edit.md): ⌘⇧E flips source ↔ live;
		// the three explicit modes are for the menu's radios and the palette.
		{ id: 'workspace:toggle-live', name: 'Toggle live edit / source', hotkeys: ['Mod-Shift-e'], when: needsNote,
			run: () => actions.toggleLiveEdit() },
		{ id: 'workspace:mode-source', name: 'View mode: source', when: needsNote,
			run: () => actions.setViewMode('source') },
		{ id: 'workspace:mode-live', name: 'View mode: live edit', when: needsNote,
			run: () => actions.setViewMode('live') },
		{ id: 'workspace:mode-reading', name: 'View mode: reading', when: needsNote,
			run: () => actions.setViewMode('reading') },
		// The editor toolbar (docs/dev/live-edit.md §6.8): hide/show, remembering
		// which of 'live'/'always' it was; and a keyboard way in.
		{ id: 'view:toggle-toolbar', name: 'Toggle editor toolbar',
			run: () => {
				const now = settingsStore.get('editorToolbar') ?? 'live';
				if (now === 'never') settingsStore.set('editorToolbar', settingsStore.get('editorToolbarPrev') ?? 'live');
				else {
					settingsStore.set('editorToolbarPrev', now);
					settingsStore.set('editorToolbar', 'never');
				}
			} },
		{ id: 'view:focus-toolbar', name: 'Focus editor toolbar', hotkeys: ['Alt-Shift-t'], when: needsNote,
			run: () => {
				const tab = workspaceStore.activeTab();
				const host = [...document.querySelectorAll('clew-editor-view:not([data-clew-retiring]), clew-preview-view:not([data-clew-retiring])')].find((v) => v.tabId === tab?.id);
				host?.querySelector('clew-editor-toolbar')?.focusFirst();
			} },
		// The shell panel. Ctrl-` is every editor's terminal chord, and it is
		// free here — Clew's own chords are all Mod-based.
		{ id: 'shell:toggle', name: 'Toggle shell panel', hotkeys: ['Ctrl-`'], when: needsVault,
			run: () => {
				const open = !workspaceStore.shell.open;
				workspaceStore.setShell({ open });
				if (open) {
					// Opening it should put the caret in it; nobody toggles a
					// terminal open in order to keep typing somewhere else.
					requestAnimationFrame(() => document.querySelector('clew-shell-panel')?.focusTerminal());
				}
			} },
		// ⌘B / ⌘⇧B are strong and intense (format.js) — the chord every editor
		// gives bold; the sidebars moved to ⌘⌥B / ⌘⌥⇧B (2026-09-27).
		{ id: 'workspace:toggle-left-sidebar', name: 'Toggle left sidebar', hotkeys: ['Mod-Alt-b'],
			run: () => toggleSidebar('left') },
		{ id: 'workspace:toggle-right-sidebar', name: 'Toggle right sidebar', hotkeys: ['Mod-Alt-Shift-b'],
			run: () => toggleSidebar('right') },

		// editing
		{ id: 'edit:insert-template', name: 'Insert template…', hotkeys: ['Mod-Alt-t'],
			when: needsEditor, run: () => insertTemplate() },
		{ id: 'edit:find-in-note', name: 'Find in note', hotkeys: ['Mod-f'], when: needsEditor,
			run: () => { const view = activeEditorView(); if (view) { openSearchPanel(view); } } },

		// view
		{ id: 'view:properties', name: 'Open properties panel', when: needsVault,
			run: () => workspaceStore.setSidebar('right', { open: true, activeTool: 'props' }) },
		{ id: 'app:settings', name: 'Open settings', hotkeys: ['Mod-,'],
			run: () => actions.openSettings() },
		{ id: 'view:toggle-theme', name: 'Toggle light/dark theme',
			run: () => settingsStore.set('theme', settingsStore.get('theme') === 'dark' ? 'light' : 'dark') },
		{ id: 'view:theme-dark', name: 'Use dark theme',
			run: () => settingsStore.set('theme', 'dark') },
		{ id: 'view:theme-light', name: 'Use light theme',
			run: () => settingsStore.set('theme', 'light') },

		// export
		{ id: 'export:html', name: 'Export note as HTML', when: needsNote,
			run: () => exportActiveNote('html') },
		{ id: 'export:latex', name: 'Export note as LaTeX (.tex)', when: needsNote,
			run: () => exportActiveNote('latex') },
		{ id: 'export:site', name: 'Export vault as website…', when: (ctx) => ctx.vaultOpen,
			run: async () => {
				notice('Exporting website…');
				try {
					const result = await ipc.invoke(CH.EXPORT_SITE, {});
					if (!result) return; // dialog cancelled
					const failed = result.failures.length ? ` (${result.failures.length} failed)` : '';
					notice(`Website exported: ${result.notes} pages → ${result.outDir}${failed}`, 6000);
				} catch (err) {
					notice(`Website export failed: ${err.message}`, 6000);
				}
			} },
		{ id: 'export:pdf', name: 'Export note as PDF (via LaTeX)', when: needsNote,
			run: () => exportActiveNote('pdf') },
		{ id: 'export:print-pdf', name: 'Export note as PDF (reading view)', when: needsNote,
			run: () => exportActiveNote('print-pdf') },
	];
	for (const command of commands) registerCommand(command);
	registerFormatCommands();

	// The palette itself.
	registerCommand({
		id: 'app:command-palette',
		name: 'Open command palette',
		hotkeys: ['Mod-p'],
		run: () => openCommandPalette(),
	});
}

function cycleTab(direction) {
	const group = workspaceStore.activeGroup();
	if (!group || group.tabs.length < 2) return;
	const index = group.tabs.findIndex((t) => t.id === group.activeTabId);
	const next = (index + direction + group.tabs.length) % group.tabs.length;
	workspaceStore.activateTab(group.tabs[next].id);
}

function toggleSidebar(side) {
	workspaceStore.setSidebar(side, { open: !workspaceStore.state.sidebars[side].open });
}

export function openCommandPalette() {
	const ctx = buildContext();
	const keymap = effectiveKeymap();
	const chordFor = (id) => {
		for (const [chord, mapped] of keymap) {
			if (mapped === id) return prettifyChord(chord);
		}
		return '';
	};
	const items = allCommands()
		.filter((c) => isEnabled(c, ctx))
		.map((c) => ({ label: c.name, hint: chordFor(c.id), run: () => c.run(buildContext()) }));
	openListModal({ placeholder: 'Run a command…', items });
}

export function prettifyChord(chord) {
	const isMac = navigator.platform.startsWith('Mac');
	return chord
		.replace('Mod', isMac ? '⌘' : 'Ctrl')
		.replace('Alt', isMac ? '⌥' : 'Alt')
		.replace('Shift', '⇧')
		.replace('ArrowLeft', '←')
		.replace('ArrowRight', '→')
		.replace('ArrowUp', '↑')
		.replace('ArrowDown', '↓')
		.replaceAll('-', isMac ? '' : '+');
}

export { isNotePath };
