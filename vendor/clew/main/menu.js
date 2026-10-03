// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The native application menu. Command items dispatch renderer command ids
// over EV_MENU_COMMAND — the renderer's command registry stays the single
// source of truth for behavior, and its keydown dispatcher owns every chord
// (user rebindings, modal guards). Accelerators here are therefore
// display-only on macOS (registerAccelerator: false); each renderer pushes
// its effective keymap over MENU_STATE so the menu shows real bindings.
//
// Multi-window: state pushes are stored per session, and the one macOS
// menu always reflects — and dispatches into — the FOCUSED window. Focus
// changes rebuild it (main.js wires browser-window-focus).
import { app, Menu, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { CH } from '../shared/channels.js';
import { FORMAT_MENU } from '../shared/format-spec.js';
import { settings } from './settings.js';
import { allSessions, focusedSession, sessionForVault } from './session.js';
import { createWindow, openVaultAnywhere, openVaultDialog, createVaultDialog, openDemoVault, focusWindow } from './main.js';

const isMac = process.platform === 'darwin';

const KEY_NAMES = {
	ArrowLeft: 'Left',
	ArrowRight: 'Right',
	ArrowUp: 'Up',
	ArrowDown: 'Down',
};

/** CM chord ('Mod-Shift-p') → Electron accelerator ('CmdOrCtrl+Shift+P'). */
export function chordToAccelerator(chord) {
	// A trailing '--' means the key itself is '-'.
	const parts = chord.endsWith('--')
		? [...chord.slice(0, -2).split('-'), '-']
		: chord.split('-');
	const key = parts.pop();
	// 'Mod' is the platform command key; 'Ctrl' is a real, distinct modifier
	// (mac emacs-style bindings live on it, and tab cycling uses Ctrl-Tab).
	const MODS = { Mod: 'CmdOrCtrl', Ctrl: 'Control', Meta: 'Super' };
	const out = parts.map((p) => MODS[p] ?? p);
	out.push(KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key));
	return out.join('+');
}

const defaultState = () => ({
	vaultOpen: false,
	noteActive: false,
	tabOpen: false,
	readingMode: false,
	/** the active note tab's 'source' | 'live' | 'reading', or null */
	viewMode: null,
	toolbarVisible: true,
	pinned: false,
	bookmarked: false,
	leftSidebar: true,
	rightSidebar: true,
	shellOpen: false,
	theme: 'dark',
	/** the active tab's name as the title bar shows it, or null — the Window
	 *  menu tells windows on the same vault's neighbours apart by it */
	activeName: null,
	/** command id → CM chord or null, from the renderer's effective keymap */
	hotkeys: {},
});

class AppMenu {
	#rootDir = null;
	#lastBuilt = null;
	#stateBySession = new WeakMap();

	init({ rootDir }) {
		this.#rootDir = rootDir;
		this.rebuild();
	}

	/** A renderer's push over MENU_STATE, stored against its session. */
	update(session, partial) {
		const state = this.#stateBySession.get(session) ?? defaultState();
		Object.assign(state, partial);
		this.#stateBySession.set(session, state);
		this.rebuild();
	}

	/** The focused window's state (defaults before its first push). */
	#currentState() {
		const session = focusedSession();
		const state = (session && this.#stateBySession.get(session)) ?? defaultState();
		state.theme = settings.get('theme') ?? state.theme;
		return state;
	}

	#send(channel, payload) {
		focusedSession()?.send(channel, payload);
	}

	rebuild() {
		const snapshot = JSON.stringify([
			focusedSession()?.id ?? null,
			this.#currentState(),
			settings.get('recentVaults'),
			// Every window's vault and active tab: the Window menu lists them.
			allSessions().map((s) => [s.id, s.vaults.root, this.#stateBySession.get(s)?.activeName ?? null]),
		]);
		if (snapshot === this.#lastBuilt) return;
		this.#lastBuilt = snapshot;
		Menu.setApplicationMenu(Menu.buildFromTemplate(this.#template()));
	}

	// ---- item helpers ------------------------------------------------------

	/** A menu item that dispatches a renderer command id. */
	#cmd(state, id, label, { chord, needs, type, checked } = {}) {
		const enabled =
			needs === 'vault' ? state.vaultOpen
			: needs === 'note' ? state.noteActive
			: needs === 'editor' ? state.noteActive && !state.readingMode
			: needs === 'tab' ? state.tabOpen
			: true;
		const item = { label, enabled, click: () => this.#send(CH.EV_MENU_COMMAND, { id }) };
		// The renderer's map wins even when it says "unbound" (null).
		const effective = id in state.hotkeys ? state.hotkeys[id] : chord;
		if (effective) {
			item.accelerator = chordToAccelerator(effective);
			item.registerAccelerator = false; // display-only; renderer dispatches
		}
		if (type) {
			item.type = type;
			item.checked = !!checked;
		}
		return item;
	}

	#openVault(vaultPath) {
		try {
			openVaultAnywhere(vaultPath, { preferSession: focusedSession() });
		} catch (err) {
			console.error('Failed to open vault from menu:', err);
			// Prune recent entries whose folder no longer exists.
			settings.set('recentVaults', (settings.get('recentVaults') ?? []).filter((p) => p !== vaultPath));
			this.#lastBuilt = null;
			this.rebuild();
		}
	}

	#recentSubmenu() {
		const recents = settings.get('recentVaults') ?? [];
		return [
			...recents.map((vaultPath) => ({
				label: path.basename(vaultPath),
				toolTip: vaultPath,
				type: 'checkbox',
				checked: sessionForVault(vaultPath) !== null,
				click: () => this.#openVault(vaultPath),
			})),
			{ type: 'separator' },
			{
				label: 'Clear Recent Vaults',
				enabled: recents.length > 0,
				click: () => {
					settings.set('recentVaults', []);
					this.#lastBuilt = null;
					this.rebuild();
				},
			},
		];
	}

	/**
	 * Every open window, by VAULT name (the owner's ask, 2026-10-01: nothing
	 * else showed which vaults were open). The window's own title is "Clew"
	 * in every window (the title bar is drawn by the page), so macOS's
	 * automatic list would only have said "Clew" three times; this menu is
	 * deliberately NOT role 'windowMenu', and this list is the one there is,
	 * the same on every platform. The active tab follows the vault name, as
	 * the title bar shows it; two vaults with one folder name are told apart
	 * by their parent folder. The focused window is checked; choosing one
	 * brings it forward (main.js#focusWindow).
	 */
	#windowItems() {
		const sessions = allSessions().filter((s) => s.win && !s.win.isDestroyed());
		const focused = focusedSession();
		const names = sessions.map((s) => (s.vaults.root ? path.basename(s.vaults.root) : null));
		return sessions.map((session, i) => {
			const root = session.vaults.root;
			let label = root ? names[i] : 'Welcome';
			if (root && names.filter((n) => n === names[i]).length > 1) {
				label += ` (${path.basename(path.dirname(root))})`;
			}
			const active = this.#stateBySession.get(session)?.activeName;
			if (active) label += ` — ${active}`;
			return {
				label,
				type: 'checkbox',
				checked: session === focused,
				click: () => focusWindow(session),
			};
		});
	}

	// ---- the template ------------------------------------------------------

	#template() {
		const s = this.#currentState();
		const c = (id, label, opts) => this.#cmd(s, id, label, opts);

		const appMenu = {
			label: app.name,
			submenu: [
				{ role: 'about' },
				{ type: 'separator' },
				c('app:settings', 'Settings…', { chord: 'Mod-,' }),
				{ type: 'separator' },
				{ role: 'services' },
				{ type: 'separator' },
				{ role: 'hide' },
				{ role: 'hideOthers' },
				{ role: 'unhide' },
				{ type: 'separator' },
				{ role: 'quit' },
			],
		};

		const fileMenu = {
			label: 'File',
			submenu: [
				c('file:new-note', 'New Note', { chord: 'Mod-n', needs: 'vault' }),
				c('file:new-canvas', 'New Canvas', { needs: 'vault' }),
				c('file:new-drawing', 'New Drawing (Excalidraw)', { needs: 'vault' }),
				c('file:new-folder', 'New Folder', { needs: 'vault' }),
				c('workspace:new-tab', 'New Tab', { chord: 'Mod-t' }),
				{
					label: 'New Window',
					accelerator: 'CmdOrCtrl+Shift+N',
					click: () => createWindow(null),
				},
				{ type: 'separator' },
				{
					label: 'Open Vault…',
					accelerator: 'CmdOrCtrl+Shift+O',
					click: () => openVaultDialog(focusedSession()),
				},
				{
					label: 'New Vault…',
					click: () => createVaultDialog(focusedSession()),
				},
				{ label: 'Open Recent Vault', submenu: this.#recentSubmenu() },
				{ type: 'separator' },
				c('file:save', 'Save', { chord: 'Mod-s', needs: 'note' }),
				c('file:history', 'View Note History…', { needs: 'note' }),
				{ type: 'separator' },
				c('file:bookmark', 'Bookmark This Note', { needs: 'note', type: 'checkbox', checked: s.bookmarked }),
				c('file:reveal', isMac ? 'Reveal in Finder' : 'Show in File Manager', { needs: 'note' }),
				{ type: 'separator' },
				{
					label: 'Export',
					submenu: [
						c('export:html', 'As HTML…', { needs: 'note' }),
						c('export:latex', 'As LaTeX…', { needs: 'note' }),
						c('export:pdf', 'As PDF (via LaTeX)…', { needs: 'note' }),
						c('export:print-pdf', 'As PDF (reading view)…', { needs: 'note' }),
						{ type: 'separator' },
						c('export:site', 'Vault as Website…', { needs: 'vault' }),
					],
				},
				{ type: 'separator' },
				c('workspace:close-tab', 'Close Tab', { chord: 'Mod-w', needs: 'tab' }),
				...(isMac ? [] : [
					{ type: 'separator' },
					c('app:settings', 'Settings…', { chord: 'Mod-,' }),
					{ type: 'separator' },
					{ role: 'quit' },
				]),
			],
		};

		const editMenu = {
			label: 'Edit',
			submenu: [
				{ role: 'undo' },
				{ role: 'redo' },
				{ type: 'separator' },
				{ role: 'cut' },
				{ role: 'copy' },
				{ role: 'paste' },
				{ role: 'pasteAndMatchStyle' },
				{ role: 'selectAll' },
				{ type: 'separator' },
				// Obsidian's "Copy link to block". It lives here rather than in
				// the palette alone because an identifier nobody can discover
				// is an identifier nobody writes.
				c('editor:copy-block-ref', 'Copy Link to Block', { needs: 'editor' }),
				// Same reason: ⌥Q is Emacs' M-q and nothing on screen says so
				// (the owner's ask, 2026-09-18). The gloss is for the word the
				// hand reaches for; the command's own name stays the manual's.
				c('editor:fill-paragraph', 'Fill Paragraph (Reflow)', { chord: 'Alt-q', needs: 'editor' }),
				// Select text in a PDF, and this puts it in the note being
				// written: a quote, its citation and its page (pdf-quote.js).
				c('pdf:quote-selection', 'Quote PDF Selection in Note', { chord: 'Mod-Alt-q', needs: 'vault' }),
				{ type: 'separator' },
				c('edit:find-in-note', 'Find in Note', { chord: 'Mod-f', needs: 'editor' }),
				c('nav:search', 'Search in All Files', { chord: 'Mod-Shift-f', needs: 'vault' }),
			],
		};

		// The whole jmarkdown dialect, one submenu per family — generated from
		// the shared spec so it can never drift from the registered commands.
		const formatMenu = {
			label: 'Format',
			submenu: FORMAT_MENU.map((group) => ({
				label: group.label,
				submenu: group.items.map((item) => (item.separator
					? { type: 'separator' }
					: c(item.id, item.label, { needs: 'editor', chord: item.chord }))),
			})),
		};

		const viewMenu = {
			label: 'View',
			submenu: [
				c('app:command-palette', 'Command Palette…', { chord: 'Mod-p' }),
				{ type: 'separator' },
				c('workspace:toggle-mode', 'Reading Mode', { chord: 'Mod-e', needs: 'note', type: 'checkbox', checked: s.readingMode }),
				c('workspace:toggle-live', 'Live Edit', { chord: 'Mod-Shift-e', needs: 'note', type: 'checkbox', checked: s.viewMode === 'live' }),
				{
					label: 'Mode',
					submenu: [
						c('workspace:mode-source', 'Source', { needs: 'note', type: 'radio', checked: s.viewMode === 'source' }),
						c('workspace:mode-live', 'Live Edit', { needs: 'note', type: 'radio', checked: s.viewMode === 'live' }),
						c('workspace:mode-reading', 'Reading', { needs: 'note', type: 'radio', checked: s.viewMode === 'reading' }),
					],
				},
				c('view:toggle-toolbar', 'Editor Toolbar', { type: 'checkbox', checked: s.toolbarVisible }),
				c('view:properties', 'Properties Panel', { needs: 'vault' }),
				{ type: 'separator' },
				{
					label: 'Appearance',
					submenu: [
						c('view:theme-dark', 'Dark', { type: 'radio', checked: s.theme === 'dark' }),
						c('view:theme-light', 'Light', { type: 'radio', checked: s.theme === 'light' }),
					],
				},
				{ type: 'separator' },
				c('workspace:toggle-left-sidebar', 'Left Sidebar', { chord: 'Mod-Alt-b', type: 'checkbox', checked: s.leftSidebar }),
				c('workspace:toggle-right-sidebar', 'Right Sidebar', { chord: 'Mod-Alt-Shift-b', type: 'checkbox', checked: s.rightSidebar }),
				c('shell:toggle', 'Shell Panel', { chord: 'Ctrl-`', needs: 'vault', type: 'checkbox', checked: s.shellOpen }),
				{ type: 'separator' },
				{ role: 'resetZoom' },
				{ role: 'zoomIn' },
				{ role: 'zoomOut' },
				{ type: 'separator' },
				{ role: 'reload' },
				{ role: 'toggleDevTools' },
			],
		};

		const goMenu = {
			label: 'Go',
			submenu: [
				c('nav:back', 'Back', { chord: 'Mod-[', needs: 'vault' }),
				c('nav:forward', 'Forward', { chord: 'Mod-]', needs: 'vault' }),
				{ type: 'separator' },
				c('nav:quick-switcher', 'Quick Switcher…', { chord: 'Mod-o', needs: 'vault' }),
				c('nav:graph', 'Graph View', { chord: 'Mod-g', needs: 'vault' }),
				c('nav:daily-note', "Today's Diary Entry", { chord: 'Mod-Shift-d', needs: 'vault' }),
				c('nav:diary', 'Diary Calendar', { needs: 'vault' }),
				{ type: 'separator' },
				c('workspace:next-tab', 'Next Tab', { chord: 'Ctrl-Tab' }),
				c('workspace:prev-tab', 'Previous Tab', { chord: 'Ctrl-Shift-Tab' }),
				{
					label: 'Tab',
					submenu: [
						...[1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
							c(`workspace:goto-tab-${n}`, `Tab ${n}`, { chord: `Mod-${n}`, needs: 'tab' })),
						c('workspace:goto-last-tab', 'Last Tab', { chord: 'Mod-9', needs: 'tab' }),
					],
				},
			],
		};

		const windowMenu = {
			label: 'Window',
			submenu: [
				{ role: 'minimize' },
				{ role: 'zoom' },
				{ type: 'separator' },
				c('workspace:split-right', 'Split Right', { chord: 'Mod-\\', needs: 'tab' }),
				c('workspace:close-split', 'Close Current Pane', { chord: 'Mod-Shift-w' }),
				c('workspace:close-other-pane', 'Close Other Pane'),
				c('workspace:split-down', 'Split Down', { chord: 'Mod-Shift-\\', needs: 'tab' }),
				{ type: 'separator' },
				c('workspace:pin-tab', 'Pin Tab', { needs: 'tab', type: 'checkbox', checked: s.pinned }),
				...(isMac ? [{ type: 'separator' }, { role: 'front' }] : []),
				{ type: 'separator' },
				...this.#windowItems(),
			],
		};

		// The demo vault is the documentation: bundled when packaged (opened
		// as the user's own copy in Documents), the repo's in dev.
		const helpMenu = {
			role: 'help',
			submenu: [
				{
					label: 'Clew Documentation (Demo Vault)',
					click: () => openDemoVault(focusedSession()),
				},
				// Asks the feed now and always answers (main/updater.js).
				c('app:check-updates', 'Check for Updates…'),
				{
					// Licences have to REACH the reader to mean anything. The
					// file ships in Resources/ (extraResources) and sits at the
					// repo root in development.
					label: 'Third-Party Notices',
					click: () => {
						const candidates = [
							path.join(process.resourcesPath ?? '', 'THIRD-PARTY-NOTICES.md'),
							this.#rootDir ? path.join(this.#rootDir, 'THIRD-PARTY-NOTICES.md') : null,
						].filter(Boolean);
						const found = candidates.find((file) => fs.existsSync(file));
						if (found) shell.openPath(found);
					},
				},
				...(isMac ? [] : [{ type: 'separator' }, { role: 'about' }]),
			],
		};

		return [
			...(isMac ? [appMenu] : []),
			fileMenu,
			editMenu,
			formatMenu,
			viewMenu,
			goMenu,
			windowMenu,
			helpMenu,
		];
	}
}

export const appMenu = new AppMenu();
