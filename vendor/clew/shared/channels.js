// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// IPC channel names, imported by both processes. Renderer→main channels are
// invoked; main→renderer channels are events pushed over webContents.send.
export const CH = {
	// invoke: vault lifecycle
	VAULT_OPEN_DIALOG: 'clew:vault-open-dialog',
	VAULT_OPEN_PATH: 'clew:vault-open-path',
	VAULT_CURRENT: 'clew:vault-current',
	VAULT_RECENT: 'clew:vault-recent',
	VAULT_TREE: 'clew:vault-tree',

	// invoke: file operations (paths are vault-relative)
	NOTE_READ: 'clew:note-read',
	NOTE_WRITE: 'clew:note-write',
	NOTE_CREATE: 'clew:note-create',
	FS_CREATE_FOLDER: 'clew:fs-create-folder',
	FS_RENAME: 'clew:fs-rename',
	FS_TRASH: 'clew:fs-trash',
	ATTACH_SAVE: 'clew:attach-save',
	FS_REVEAL: 'clew:fs-reveal',

	// invoke: persistence
	WORKSPACE_LOAD: 'clew:workspace-load',
	WORKSPACE_SAVE: 'clew:workspace-save',
	SETTINGS_GET: 'clew:settings-get',
	SETTINGS_SET: 'clew:settings-set',
	VSTATE_LOAD: 'clew:vstate-load',
	VSTATE_SAVE: 'clew:vstate-save',
	VAULT_SETTINGS_GET: 'clew:vault-settings-get',
	PLUGINS_LIST: 'clew:plugins-list',
	VAULT_SETTINGS_SET: 'clew:vault-settings-set',

	// invoke: vault key-value store (clewdata.json — the note API's state)
	KV_GET: 'clew:kv-get',
	KV_SET: 'clew:kv-set',
	KV_DELETE: 'clew:kv-delete',
	KV_LIST: 'clew:kv-list',

	// invoke: export via the engine
	EXPORT_NOTE: 'clew:export-note',
	CANVAS_EXPORT_PNG: 'clew:canvas-export-png',
	EXPORT_SITE: 'clew:export-site',
	SNIPPETS_GET: 'clew:snippets-get',

	// invoke: index & search
	INDEX_GET: 'clew:index-get',
	SEARCH: 'clew:search',
	UNLINKED_MENTIONS: 'clew:unlinked-mentions',
	BIB_ENTRIES: 'clew:bib-entries',

	// invoke: rendering (reading mode / preview)
	RENDER_SUBSCRIBE: 'clew:render-subscribe',
	RENDER_UNSUBSCRIBE: 'clew:render-unsubscribe',
	SHELL_OPEN_EXTERNAL: 'clew:shell-open-external',

	// invoke: native application menu (renderer pushes context + hotkeys)
	MENU_STATE: 'clew:menu-state',

	// events: main → renderer
	EV_VAULT_OPENED: 'clew:ev-vault-opened',
	EV_TREE_CHANGED: 'clew:ev-tree-changed',
	EV_FILE_CHANGED: 'clew:ev-file-changed',
	EV_RENDER_DONE: 'clew:ev-render-done',
	EV_RENDER_ERROR: 'clew:ev-render-error',
	EV_INDEX_SNAPSHOT: 'clew:ev-index-snapshot',
	EV_INDEX_PATCH: 'clew:ev-index-patch',
	EV_MENU_COMMAND: 'clew:ev-menu-command',
	EV_KV_CHANGED: 'clew:ev-kv-changed',
};

// Notes are what Clew opens in an editor.
export const NOTE_EXTENSIONS = ['.md', '.jmd'];
