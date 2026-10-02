// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Native application menu ↔ renderer bridge. Menu clicks arrive as command
// ids and go through the registry (so `when` guards apply); store changes
// push back the state the menu needs — enablement context, checkmarks, and
// the effective keymap so accelerators display the user's real bindings.
import { ipc, CH } from '../ipc.js';
import { runCommand, buildContext, allCommands, effectiveKeymap } from './registry.js';
import { debounce } from '../lib/debounce.js';
import { workspaceStore } from '../state/workspace-store.js';
import { vaultStore } from '../state/vault-store.js';
import { settingsStore } from '../state/settings-store.js';
import { bookmarkStore } from '../state/bookmark-store.js';

export function installMenuBridge() {
	ipc.on(CH.EV_MENU_COMMAND, ({ id }) => runCommand(id));

	const push = debounce(() => {
		const ctx = buildContext();
		const chords = new Map(); // command id → first effective chord
		for (const [chord, id] of effectiveKeymap()) {
			if (!chords.has(id)) chords.set(id, chord);
		}
		const hotkeys = {};
		for (const command of allCommands()) hotkeys[command.id] = chords.get(command.id) ?? null;
		ipc.invoke(CH.MENU_STATE, {
			vaultOpen: ctx.vaultOpen,
			noteActive: ctx.notePath !== null,
			tabOpen: ctx.activeTab != null,
			readingMode: ctx.activeTab?.kind === 'note' && ctx.activeTab.view.mode === 'reading',
			viewMode: ctx.activeTab?.kind === 'note' ? (ctx.activeTab.view.mode ?? 'source') : null,
			toolbarVisible: (settingsStore.get('editorToolbar') ?? 'live') !== 'never',
			pinned: !!ctx.activeTab?.pinned,
			bookmarked: ctx.notePath !== null && bookmarkStore.has(ctx.notePath),
			leftSidebar: !!workspaceStore.state.sidebars.left?.open,
			rightSidebar: !!workspaceStore.state.sidebars.right?.open,
			shellOpen: !!workspaceStore.shell.open,
			theme: settingsStore.get('theme') ?? 'dark',
			// The Window menu lists every open vault with its active tab,
			// named as the title bar names it (clew-app.js#updateTitle).
			activeName: ctx.activeTab?.path ? ctx.activeTab.path.split('/').pop().replace(/\.(md|jmd)$/i, '') : null,
			hotkeys,
		}).catch(() => {});
	}, 50);

	for (const event of ['layout-changed', 'active-changed', 'sidebar-changed', 'shell-changed']) {
		workspaceStore.on(event, push);
	}
	vaultStore.on('vault-changed', push);
	settingsStore.on('settings-changed', push);
	bookmarkStore.on('bookmarks-changed', push);
	push();
}
