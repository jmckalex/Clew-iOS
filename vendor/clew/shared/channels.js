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
	VAULT_CREATE_DIALOG: 'clew:vault-create-dialog',
	VAULT_OPEN_DEMO: 'clew:vault-open-demo',

	// invoke: file operations (paths are vault-relative)
	NOTE_READ: 'clew:note-read',
	NOTE_WRITE: 'clew:note-write',
	NOTE_CREATE: 'clew:note-create',
	FS_CREATE_FOLDER: 'clew:fs-create-folder',
	FS_RENAME: 'clew:fs-rename',
	FS_TRASH: 'clew:fs-trash',
	ATTACH_SAVE: 'clew:attach-save',
	FS_REVEAL: 'clew:fs-reveal',

	// invoke: note history (.clew/history/ snapshots)
	HISTORY_LIST: 'clew:history-list',
	HISTORY_READ: 'clew:history-read',
	HISTORY_RESTORE: 'clew:history-restore',
	HISTORY_KEEP: 'clew:history-keep',
	PDF_META_GET: 'clew:pdf-meta-get',
	PDF_META_SET: 'clew:pdf-meta-set',

	// invoke: persistence
	WORKSPACE_LOAD: 'clew:workspace-load',
	WORKSPACE_SAVE: 'clew:workspace-save',
	SETTINGS_GET: 'clew:settings-get',
	SETTINGS_SET: 'clew:settings-set',
	VSTATE_LOAD: 'clew:vstate-load',
	VSTATE_SAVE: 'clew:vstate-save',
	VAULT_SETTINGS_GET: 'clew:vault-settings-get',
	PLUGINS_LIST: 'clew:plugins-list',
	PLUGINS_REVEAL_GLOBAL: 'clew:plugins-reveal-global',
	VAULT_SETTINGS_SET: 'clew:vault-settings-set',
	// invoke: custom callout types for the window's vault, both scopes
	// resolved (main/callout-types.js) → { custom, problems }.
	CALLOUTS_RESOLVED: 'clew:callouts-resolved',
	// invoke: the Font Awesome table, for Settings only — whole for the icon
	// picker → { version, icons: { 'solid:pencil': [w, h, d], … } }, or
	// { names } → { version, icons: { name: { key, icon: [w, h, d] } } }.
	CALLOUT_ICONS: 'clew:callout-icons',
	// invoke: this device's trust in the window's vault (main/vault-trust.js):
	// GET → { trusted, refused: [names] }; SET { trusted } → { trusted }.
	VAULT_TRUST_GET: 'clew:vault-trust-get',
	VAULT_TRUST_SET: 'clew:vault-trust-set',
	// The full vault-trust design (docs/dev/frame-bridge.md §4): what this
	// window's vault may run on this device, what it contains that would
	// run (the prompt's counts), and every vault the device has decided on.
	VAULT_ACCESS_GET: 'clew:vault-access-get',
	VAULT_ACCESS_SET: 'clew:vault-access-set',
	VAULT_CODE_SUMMARY: 'clew:vault-code-summary',
	TRUSTED_VAULTS_LIST: 'clew:trusted-vaults-list',
	TRUSTED_VAULTS_SET: 'clew:trusted-vaults-set',
	// Apps in notes (frame-bridge.md §7–§9): the app page's bridge host asks
	// main what an embedded app may do, records the user's answer, and relays
	// each port request — main decides every one.
	APP_STATUS: 'clew:app-status',
	APP_ANSWER: 'clew:app-answer',
	APP_CALL: 'clew:app-call',
	APPS_LIST: 'clew:apps-list',
	APP_REVOKE: 'clew:app-revoke',
	// The update check (docs/dev/auto-update.md): Help → Check for Updates…,
	// and Skip this version.
	UPDATE_CHECK: 'clew:update-check',
	UPDATE_SKIP: 'clew:update-skip',
	// invoke: a web PDF the window's renders registered (main/remote-pdfs.js),
	// named by its hash — { key } → { path } / { url }.
	REMOTE_PDF_SAVE_COPY: 'clew:remote-pdf-save-copy',
	REMOTE_PDF_OPEN: 'clew:remote-pdf-open',

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
	RENDER_HTML: 'clew:render-html',
	PDF_WRITE: 'clew:pdf-write',
	PDF_VERSION_RESTORE: 'clew:pdf-version-restore',
	OFFICE_WRITE: 'clew:office-write',

	// invoke: office tabs (ZetaOffice). The slot is the app-global
	// one-LibreOffice-at-a-time guard; the engine channels manage the
	// downloaded wasm bundle; convert/open-external are the no-engine rung.
	OFFICE_SLOT_ACQUIRE: 'clew:office-slot-acquire',
	OFFICE_SLOT_RELEASE: 'clew:office-slot-release',
	OFFICE_ENGINE_STATUS: 'clew:office-engine-status',
	OFFICE_ENGINE_DOWNLOAD: 'clew:office-engine-download',
	OFFICE_ENGINE_REMOVE: 'clew:office-engine-remove',
	OFFICE_CONVERT_PDF: 'clew:office-convert-pdf',
	OFFICE_OPEN_EXTERNAL: 'clew:office-open-external',
	OFFICE_THUMBNAIL: 'clew:office-thumbnail',
	PDF_THUMBNAIL: 'clew:pdf-thumbnail',
	CONFIRM_DISCARD: 'clew:confirm-discard',
	WINDOW_CLOSE_RESOLVED: 'clew:window-close-resolved',
	EXCALIDRAW_LIB_GET: 'clew:excalidraw-lib-get',
	EXCALIDRAW_LIB_SET: 'clew:excalidraw-lib-set',
	PDF_FONTS_STATUS: 'clew:pdf-fonts-status',
	PDF_FONTS_DOWNLOAD: 'clew:pdf-fonts-download',
	PDF_FONTS_REMOVE: 'clew:pdf-fonts-remove',
	SHELL_OPEN_EXTERNAL: 'clew:shell-open-external',
	SHELL_OPEN_PATH: 'clew:shell-open-path',

	// invoke: native application menu (renderer pushes context + hotkeys)
	MENU_STATE: 'clew:menu-state',

	// events: main → renderer
	EV_VAULT_OPENED: 'clew:ev-vault-opened',
	// The watcher hit its descriptor budget: part of the vault is not being
	// watched, so the explorer and previews can go stale there (vault.js).
	EV_WATCH_CAPPED: 'clew:ev-watch-capped',
	// The engine refused a note's code in a vault this device does not trust
	// (render-service.js#noteRefusals): { path, names }.
	EV_NOTE_CODE_REFUSED: 'clew:ev-note-code-refused',
	// This window's vault was trusted or revoked: { trusted }.
	EV_VAULT_TRUST_CHANGED: 'clew:ev-vault-trust-changed',
	EV_VAULT_ACCESS_CHANGED: 'clew:ev-vault-access-changed',
	EV_TRUST_NOTICE: 'clew:ev-trust-notice',
	EV_APP_GRANTS_CHANGED: 'clew:ev-app-grants-changed',
	EV_UPDATE_AVAILABLE: 'clew:ev-update-available',
	// Custom callout types changed — in Settings, or a hand edit of the
	// vault's vault-settings.json: re-ask CALLOUTS_RESOLVED. No payload.
	EV_CALLOUTS_CHANGED: 'clew:ev-callouts-changed',
	// The shell panel: one real shell per window (main/shell-core.js).
	SHELL_OPEN: 'clew:shell-open',
	SHELL_WRITE: 'clew:shell-write',
	SHELL_RESIZE: 'clew:shell-resize',
	SHELL_CLOSE: 'clew:shell-close',
	EV_SHELL_DATA: 'clew:ev-shell-data',
	EV_SHELL_EXIT: 'clew:ev-shell-exit',
	EV_TREE_CHANGED: 'clew:ev-tree-changed',
	EV_FILE_CHANGED: 'clew:ev-file-changed',
	EV_RENDER_DONE: 'clew:ev-render-done',
	EV_RENDER_ERROR: 'clew:ev-render-error',
	EV_INDEX_SNAPSHOT: 'clew:ev-index-snapshot',
	EV_INDEX_PATCH: 'clew:ev-index-patch',
	EV_MENU_COMMAND: 'clew:ev-menu-command',
	EV_KV_CHANGED: 'clew:ev-kv-changed',
	EV_OFFICE_SLOT: 'clew:ev-office-slot',
	EV_CLOSE_REQUESTED: 'clew:ev-close-requested',
};

// Notes are what Clew opens in an editor.
export const NOTE_EXTENSIONS = ['.md', '.jmd'];
