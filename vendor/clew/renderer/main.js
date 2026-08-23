// Renderer entry: register components and commands, wire IPC events into
// stores, restore state, install hotkeys.
import { ipc, CH } from './ipc.js';
import { vaultStore } from './state/vault-store.js';
import { workspaceStore } from './state/workspace-store.js';
import { settingsStore } from './state/settings-store.js';
import { bookmarkStore } from './state/bookmark-store.js';
import { editorPool } from './editor/pool.js';
import * as actions from './commands/actions.js';
import { setPreviewSession } from './lib/preview-url.js';
import { registerBuiltinCommands } from './commands/builtin.js';
import { installMenuBridge } from './commands/menu-bridge.js';
import { installHotkeys } from './commands/registry.js';
import { initPlugins } from './plugins.js';
import './components/chrome/clew-app.js';

// ---- IPC events → stores --------------------------------------------------

ipc.on(CH.EV_VAULT_OPENED, async ({ vault, tree }) => {
	editorPool.flushAll();
	setPreviewSession(vault?.sessionId);
	vaultStore.setVault(vault);
	vaultStore.setTree(tree);
	await workspaceStore.restore((path) => vaultStore.pathExists(path));
	editorPool.reap(workspaceStore.openTabIds());
	bookmarkStore.load();
	applySnippets();
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
installMenuBridge();

// ---- dev hook -------------------------------------------------------------

// Exposed for dev-tools poking and the CLEW_SMOKE scenario scripts.
window.__clew = { workspaceStore, vaultStore, editorPool, settingsStore, ipc, actions };
import('./commands/registry.js').then((registry) => { window.__clew.registry = registry; });

// ---- boot -----------------------------------------------------------------

(async () => {
	await settingsStore.load();
	// After a window reload the vault may already be open in main.
	const vault = await ipc.invoke(CH.VAULT_CURRENT).catch(() => null);
	if (vault) {
		setPreviewSession(vault.sessionId);
		vaultStore.setVault(vault);
		vaultStore.setTree(await ipc.invoke(CH.VAULT_TREE).catch(() => null));
		const index = await ipc.invoke(CH.INDEX_GET).catch(() => null);
		if (index) vaultStore.setIndex(index);
		await workspaceStore.restore((path) => vaultStore.pathExists(path));
		bookmarkStore.load();
		applySnippets();
	}
})();
