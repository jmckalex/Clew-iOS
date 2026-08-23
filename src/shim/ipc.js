// The iOS replacement for Electron's main process: every clew:* channel the
// renderer uses (per the port audit — 35 invokes, 9 events), implemented
// in-page against the vault mirror, the vendored services, and the native
// bridge. Installs window.clew with exact preload semantics: invoke returns
// a promise; on returns an unsubscribe function; handlers get payload only.
import { CH } from '../../vendor/clew/shared/channels.js';
import { parseBib } from '../../vendor/clew/shared/bib.js';
import { Indexer } from '../../vendor/clew/main/indexer.js';
import { SearchService } from '../../vendor/clew/main/search.js';
import { KvStore, KV_FILE } from '../../vendor/clew/main/kv-store.js';
import { propagateRename } from '../../vendor/clew/main/rename-links.js';
import { listPlugins } from '../../vendor/clew/main/plugins.js';
import { direntKind, shouldRecurse, walkGuard } from '../../vendor/clew/main/fs-utils.js';
import fs from 'node:fs';
import nodePath from 'node:path';
import { vfs } from '../worker/shims/vfs.js';
import { VaultManager, VAULT_ROOT } from './vault-manager.js';
import { RenderService } from './render-service.js';
import { settings } from './settings.js';
import { bridgeCall, toBase64 } from './native-bridge.js';

const SESSION_ID = 's1';

export function createClewShim({ workerFactory, assetLoader } = {}) {
	// ---- event plumbing ---------------------------------------------------
	const listeners = new Map(); // channel -> Set<fn>
	const send = (channel, payload) => {
		const set = listeners.get(channel);
		if (!set) return;
		// Decouple from the caller's stack, like real IPC does.
		queueMicrotask(() => {
			for (const fn of [...set]) {
				try { fn(payload); } catch (err) { console.error(`[clew-ios] ${channel} listener:`, err); }
			}
		});
	};

	// ---- services (one session, wired like main/session.js) --------------
	const vaults = new VaultManager();
	vaults.sessionId = SESSION_ID;
	const indexer = new Indexer();
	const renderService = new RenderService({ workerFactory, assetLoader });
	renderService.sessionId = SESSION_ID;
	const kvStore = new KvStore();
	const searchService = new SearchService({ vaults, indexer });

	vaults.send = send;
	indexer.send = send;
	renderService.send = send;
	kvStore.send = send;

	vaults.hooks = {
		onOpen: (root) => {
			renderService.openVault(root);
			indexer.openVault(root);
			kvStore.open(root);
		},
		onClose: () => {
			renderService.closeVault();
			indexer.closeVault();
			kvStore.close();
		},
		onFileChanged: (rel) => {
			renderService.onFileChanged(rel);
			indexer.onFileChanged(rel);
			if (rel === KV_FILE) kvStore.externalChange();
		},
		onStructureChanged: () => indexer.onStructureChanged(),
	};

	// A renderer-originated save must ripple exactly like a watcher 'change'
	// on desktop: preview re-render, index patch, kv reload. The editor pool
	// ignores echoes of its own saves via lastWrittenText.
	const fileChanged = (rel) => {
		send(CH.EV_FILE_CHANGED, { path: rel });
		vaults.hooks.onFileChanged?.(rel);
	};
	const structureChanged = () => {
		send(CH.EV_TREE_CHANGED, { tree: vaults.tree() });
		vaults.hooks.onStructureChanged?.();
	};

	let openInflight = null;
	const openVault = (path, { silent = false } = {}) => {
		openInflight ??= (async () => {
			try {
				const wasSilent = silent;
				if (wasSilent) {
					// Boot path: the caller handles tree/index/workspace itself.
					const send0 = vaults.send;
					vaults.send = (ch, payload) => { if (ch !== CH.EV_VAULT_OPENED) send0(ch, payload); };
					try { await vaults.open(path); } finally { vaults.send = send0; }
				} else {
					await vaults.open(path);
				}
				return vaults.info;
			} finally {
				openInflight = null;
			}
		})();
		return openInflight;
	};

	const sanitizeStateName = (name) => {
		if (!/^[\w-]+\.json$/.test(name)) throw new Error(`Bad state name: ${name}`);
		return name;
	};

	// ---- channel handlers -------------------------------------------------
	const handlers = {
		[CH.VAULT_OPEN_DIALOG]: async () => {
			const picked = await bridgeCall('pickFolder');
			if (!picked?.path) return null;
			return openVault(picked.path);
		},
		[CH.VAULT_OPEN_PATH]: ({ path }) => openVault(path),
		[CH.VAULT_CURRENT]: async () => {
			if (vaults.isOpen) return vaults.info;
			const boot = await bridgeCall('vaultBootstrap');
			if (!boot?.path) return null;
			return openVault(boot.path, { silent: true });
		},
		[CH.VAULT_RECENT]: () => settings.get('recentVaults'),
		[CH.VAULT_TREE]: () => vaults.tree(),

		[CH.NOTE_READ]: ({ path }) => vaults.readNote(path),
		[CH.NOTE_WRITE]: ({ path, content }) => {
			vaults.writeNote(path, content);
			fileChanged(path);
		},
		[CH.NOTE_CREATE]: ({ path }) => {
			const rel = vaults.createNote(path);
			structureChanged();
			return rel;
		},
		[CH.FS_CREATE_FOLDER]: ({ path }) => {
			vaults.createFolder(path);
			structureChanged();
		},
		[CH.FS_RENAME]: ({ path, newPath }) => {
			vaults.rename(path, newPath);
			const result = propagateRename({ oldRel: path, newRel: newPath, indexer, vaults });
			structureChanged();
			return result;
		},
		[CH.FS_TRASH]: ({ path }) => vaults.trash(path),
		[CH.FS_REVEAL]: () => {},
		[CH.ATTACH_SAVE]: ({ name, data }) =>
			vaults.saveAttachment(name, data, settings.get('attachmentFolder') || 'Attachments'),

		[CH.INDEX_GET]: () => (vaults.isOpen ? indexer.snapshot() : null),
		[CH.SEARCH]: ({ query }) => searchService.search(query),
		[CH.UNLINKED_MENTIONS]: ({ path }) => searchService.unlinkedMentions(path),

		[CH.BIB_ENTRIES]: () => {
			if (!vaults.isOpen) return [];
			const out = [];
			const seen = walkGuard(VAULT_ROOT);
			const walk = (dir) => {
				let entries;
				try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
				for (const entry of entries) {
					if (entry.name.startsWith('.') || ['node_modules', '.trash'].includes(entry.name)) continue;
					const abs = nodePath.join(dir, entry.name);
					const kind = direntKind(dir, entry);
					if (kind === 'dir') {
						if (shouldRecurse(abs, seen)) walk(abs);
					} else if (kind === 'file' && entry.name.toLowerCase().endsWith('.bib')) {
						const rel = abs.slice(VAULT_ROOT.length + 1);
						try {
							out.push(...parseBib(String(vfs.read(abs))).map((e) => ({ ...e, file: rel })));
						} catch { /* unreadable bib */ }
					}
				}
			};
			walk(VAULT_ROOT);
			return out;
		},

		[CH.MENU_STATE]: (state) => { globalThis.__clewMenuState = state; },

		[CH.KV_GET]: ({ key }) => (vaults.isOpen ? kvStore.get(key) ?? null : null),
		[CH.KV_SET]: ({ key, value }) => (vaults.isOpen ? kvStore.set(key, value) : null),
		[CH.KV_DELETE]: ({ key }) => (vaults.isOpen ? kvStore.delete(key) : null),
		[CH.KV_LIST]: ({ prefix } = {}) => (vaults.isOpen ? kvStore.list(prefix ?? '') : {}),

		[CH.RENDER_SUBSCRIBE]: ({ path }) => renderService.subscribe(path),
		[CH.RENDER_UNSUBSCRIBE]: ({ path }) => renderService.unsubscribe(path),
		[CH.SHELL_OPEN_EXTERNAL]: ({ url }) => {
			if (/^https?:|^mailto:/i.test(url)) bridgeCall('openExternal', { url }).catch(() => {});
		},

		[CH.WORKSPACE_LOAD]: () => vaults.loadState('workspace.json'),
		[CH.WORKSPACE_SAVE]: (state) => vaults.saveState('workspace.json', state),
		[CH.SETTINGS_GET]: () => settings.get(),
		[CH.SETTINGS_SET]: ({ key, value }) => settings.set(key, value),
		[CH.VSTATE_LOAD]: ({ name }) => vaults.loadState(sanitizeStateName(name)),
		[CH.VSTATE_SAVE]: ({ name, data }) => vaults.saveState(sanitizeStateName(name), data),

		[CH.VAULT_SETTINGS_GET]: () => vaults.loadState('vault-settings.json') ?? {},
		[CH.VAULT_SETTINGS_SET]: ({ key, value }) => {
			const current = vaults.loadState('vault-settings.json') ?? {};
			current[key] = value;
			vaults.saveState('vault-settings.json', current);
			if (key === 'jmarkdownProject' || key === 'normalSyntax') {
				renderService.reconfigure({ [key]: value === true });
			}
			if (key === 'plugins') renderService.reconfigure({ plugins: value });
			return current;
		},

		[CH.PLUGINS_LIST]: () => {
			if (!vaults.isOpen) return { plugins: [], enabled: [] };
			const vaultSettings = vaults.loadState('vault-settings.json') ?? {};
			return {
				plugins: listPlugins(VAULT_ROOT),
				enabled: Array.isArray(vaultSettings.plugins) ? vaultSettings.plugins : [],
			};
		},

		[CH.EXPORT_NOTE]: async ({ path, format }) => {
			if (format !== 'html') {
				throw new Error(`${format} export needs a LaTeX toolchain and is not available on iOS`);
			}
			const html = await renderService.ensureRendered(path);
			const name = path.split('/').pop().replace(/\.(md|jmd)$/i, '') + '.html';
			await bridgeCall('shareText', { name, text: html });
			return { shared: true };
		},
		[CH.CANVAS_EXPORT_PNG]: async ({ data, name }) => {
			await bridgeCall('shareBase64', { name: name ?? 'drawing.png', base64: data });
			return name ?? 'drawing.png';
		},
		[CH.EXPORT_SITE]: () => {
			throw new Error('Site export is not yet available on iOS');
		},

		[CH.SNIPPETS_GET]: () => {
			if (!vaults.isOpen) return [];
			try {
				return vfs.readdir(`${VAULT_ROOT}/.clew/snippets`)
					.filter((f) => f.endsWith('.css'))
					.map((f) => ({ name: f, css: String(vfs.read(`${VAULT_ROOT}/.clew/snippets/${f}`)) }));
			} catch {
				return [];
			}
		},
	};

	// ---- the window.clew bridge ------------------------------------------
	const clew = {
		invoke(channel, payload) {
			const handler = handlers[channel];
			if (!handler) return Promise.reject(new Error(`Unknown channel: ${channel}`));
			try {
				return Promise.resolve(handler(payload ?? {}));
			} catch (err) {
				return Promise.reject(err);
			}
		},
		on(channel, fn) {
			if (!channel.startsWith('clew:')) throw new Error(`Blocked channel: ${channel}`);
			if (!listeners.has(channel)) listeners.set(channel, new Set());
			listeners.get(channel).add(fn);
			return () => listeners.get(channel)?.delete(fn);
		},
	};

	// Surface the Swift side needs (scheme handler + lifecycle callbacks).
	const native = {
		renderNote: (rel) => renderService.ensureRendered(rel),
		renderFragment: (text) => renderService.renderFragment(text),
		externalDiff: (diff) => vaults.applyExternalDiff(diff),
		flush: () => vaults.flush(),
		sessionId: SESSION_ID,
	};

	return { clew, native, send, services: { vaults, indexer, renderService, kvStore, searchService, settings } };
}

export { CH, SESSION_ID, VAULT_ROOT, toBase64 };
