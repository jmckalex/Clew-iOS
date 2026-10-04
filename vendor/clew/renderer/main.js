// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Renderer entry: register components and commands, wire IPC events into
// stores, restore state, install hotkeys.
import { ipc, CH } from './ipc.js';
import { vaultStore } from './state/vault-store.js';
import { workspaceStore } from './state/workspace-store.js';
import { settingsStore } from './state/settings-store.js';
import { vaultSettingsStore } from './state/vault-settings-store.js';
import { bookmarkStore } from './state/bookmark-store.js';
import { editorPool } from './editor/pool.js';
import * as actions from './commands/actions.js';
import { setPreviewSession } from './lib/preview-url.js';
import { setCallerToken } from './lib/caller-token.js';
import { registerBuiltinCommands } from './commands/builtin.js';
import { installMenuBridge } from './commands/menu-bridge.js';
import { installHotkeys } from './commands/registry.js';
import { initPlugins } from './plugins.js';
import { installPdfSaveBridge, installOfficeSaveBridge, installOfficeThumbBridge, installExcalidrawSaveBridge, installExcalidrawLibraryBridge, installExcalidrawResolveBridge } from './pdf-save.js';
import { officeDock } from './office-dock.js';
import { installTrustBanner, trustBannerVaultShown } from './trust-banner.js';
import { installAppHost } from './app-host.js';
import { installUpdateNotice } from './update-notice.js';
import { installPdfQuote } from './pdf-quote.js';
import { installPdfConflicts } from './pdf-conflicts.js';
import { installDeepLinks, vaultShownForLinks } from './deep-link.js';
import { installBuildWarnings } from './build-warnings.js';
import { installConflictScans } from './conflicts.js';
import { installCalloutSync } from './callouts.js';
import './components/chrome/clew-app.js';
import './editor/toolbar/clew-selection-bubble.js';
import { linkPreview } from './editor/link-preview.js';
import { previewPane } from './editor/preview-pane.js';

// ---- IPC events → stores --------------------------------------------------

// Everything a window does to put its vault on screen, whichever way the
// vault arrived: main opening it (EV_VAULT_OPENED), or this window loading
// while it was already open — a reload, and every launch of the iOS port
// (VAULT_CURRENT, the boot below). ONE tail so the two cannot drift again:
// the reload path used to skip the vault's settings, so its editors took the
// grammar, the live config and the fragment warnings of `{}`, and it never
// greeted.
async function showVault(vault, tree, index = null) {
	// Before the workspace restores: the editors it opens await this (the
	// grammar depends on the vault's normalSyntax).
	vaultSettingsStore.load();
	// Whether this device trusts the vault's notes to run code, and what the
	// engine has refused so far (trust-banner.js).
	trustBannerVaultShown();
	setPreviewSession(vault?.sessionId);
	// The caller token goes to the one module that uses it, and no further:
	// nothing that stores or shows the vault holds it.
	const { callerToken = null, ...info } = vault ?? {};
	setCallerToken(callerToken);
	vaultStore.setVault(vault ? info : vault);
	vaultStore.setTree(tree);
	if (index) vaultStore.setIndex(index);
	await workspaceStore.restore((path) => vaultStore.pathExists(path));
	// A vault opening for the first time (no saved workspace) greets with
	// its own Welcome note when it has one, instead of an empty pane —
	// what makes the demo vault a tutorial from the very first screen.
	if (workspaceStore.openTabIds().size === 0 && vaultStore.pathExists('Welcome.md')) {
		workspaceStore.openNote('Welcome.md');
	}
	editorPool.reap(workspaceStore.openTabIds());
	bookmarkStore.load();
	applySnippets();
	// A clew:// link or `clew` command waiting for this vault (deep-link.js).
	vaultShownForLinks();
}

ipc.on(CH.EV_VAULT_OPENED, async ({ vault, tree }) => {
	editorPool.flushAll();
	await showVault(vault, tree);
});

// User CSS snippets from <vault>/.clew/snippets/*.css.
async function applySnippets() {
	document.querySelectorAll('style[data-clew-snippet]').forEach((el) => el.remove());
	const snippets = await ipc.invoke(CH.SNIPPETS_GET).catch(() => []);
	for (const { name, css } of snippets) {
		const style = document.createElement('style');
		style.dataset.clewSnippet = name;
		style.textContent = css;
		document.head.append(style);
	}
}

ipc.on(CH.EV_TREE_CHANGED, ({ tree }) => vaultStore.setTree(tree));
// The vault was too big to watch whole (a library folder, usually). Say so
// once, by name: what is not watched does not refresh by itself, and the
// alternative to the budget is an app that cannot render at all — past
// ~10,240 open descriptors the render worker cannot even be forked.
function watchCapNotice({ watched, skipped, first }) {
	import('./plugins.js').then(({ notice }) => notice(
		`Watching ${watched.toLocaleString()} files in this vault; ${skipped.toLocaleString()}+ more are not watched`
		+ (first ? ` (from ${first})` : '') + '. Changes there will not refresh on their own.', 9000));
}
ipc.on(CH.EV_WATCH_CAPPED, watchCapNotice);
ipc.on(CH.EV_FILE_CHANGED, ({ path }) => editorPool.externalChange(path));
ipc.on(CH.EV_INDEX_SNAPSHOT, (snapshot) => vaultStore.setIndex(snapshot));
ipc.on(CH.EV_INDEX_PATCH, ({ path, entry }) => vaultStore.patchIndex(path, entry));

// Reap orphaned editors whenever the layout changes.
workspaceStore.on('layout-changed', () => editorPool.reap(workspaceStore.openTabIds()));

// Never lose edits: flush saves when the window blurs or unloads.
window.addEventListener('blur', () => editorPool.flushAll());
window.addEventListener('beforeunload', () => editorPool.flushAll());

// ---- theme ----------------------------------------------------------------

settingsStore.on('settings-changed', () => {
	document.body.dataset.theme = settingsStore.get('theme') ?? 'dark';
	const fontSize = settingsStore.get('editorFontSize');
	const lineWidth = settingsStore.get('editorLineWidth');
	document.body.style.setProperty('--clew-editor-font-size', fontSize ? `${fontSize}px` : '');
	document.body.style.setProperty('--clew-editor-line-width', lineWidth ? `${lineWidth}em` : '');
});

// ---- commands & hotkeys ---------------------------------------------------

registerBuiltinCommands();
initPlugins();
installHotkeys();
installPdfSaveBridge();
installPdfQuote();
installPdfConflicts();
installDeepLinks();
installBuildWarnings();
installConflictScans();
installOfficeSaveBridge();
installOfficeThumbBridge();
installExcalidrawSaveBridge();
installExcalidrawLibraryBridge();
installExcalidrawResolveBridge();
installMenuBridge();
installTrustBanner();
installAppHost();
installUpdateNotice();
installCalloutSync();
officeDock.init();

// ---- dev hook -------------------------------------------------------------

// Exposed for dev-tools poking and the CLEW_SMOKE scenario scripts.
// One selection bubble per window (docs/dev/live-edit.md §6.7).
document.body.append(document.createElement('clew-selection-bubble'));
linkPreview(); // <clew-link-preview>, the window's one link popover
previewPane(); // <clew-preview-pane>, the window's one live preview pane

window.__clew = { linkPreview, previewPane, workspaceStore, vaultStore, vaultSettingsStore, editorPool, settingsStore, ipc, actions, officeDock };
// Live edit's in-place table cells, for scenarios (smoke/live-table-edit-scenario.js).
import('./editor/live/table-cell-editor.js').then((m) => { window.__clew.activeCellView = m.activeCellView; });
import('./commands/registry.js').then((registry) => { window.__clew.registry = registry; });
import('./editor/live/numbering.js').then((m) => { window.__clew.numbering = m; });
import('./pdf-annotations.js').then((m) => { window.__clew.pdfAnnotations = m; });
import('./pdf-quote.js').then((m) => { window.__clew.pdfQuote = m; });
import('./build-warnings.js').then((m) => { window.__clew.buildWarnings = m; });
import('./conflicts.js').then((m) => { window.__clew.conflicts = m; });
import('./app-host.js').then((m) => { window.__clew.appHost = m; });

// ---- boot -----------------------------------------------------------------

(async () => {
	await settingsStore.load();
	// After a window reload the vault may already be open in main.
	const vault = await ipc.invoke(CH.VAULT_CURRENT).catch(() => null);
	if (vault) {
		// The watcher may have finished — and given up — before this window
		// existed to be told, which a fast scan makes likely.
		if (vault.watchCap) watchCapNotice(vault.watchCap);
		const tree = await ipc.invoke(CH.VAULT_TREE).catch(() => null);
		const index = await ipc.invoke(CH.INDEX_GET).catch(() => null);
		await showVault(vault, tree, index);
	}
})();
