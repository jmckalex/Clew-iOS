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
import { planOpen, pathFromFileUrl } from '../../vendor/clew/main/open-file.js';
import { direntKind, shouldRecurse, walkGuard } from '../../vendor/clew/main/fs-utils.js';
import { listSnapshots, readSnapshot } from '../../vendor/clew/main/history.js';
import fs from 'node:fs';
import nodePath from 'node:path';
import { vfs } from '../worker/shims/vfs.js';
import { VaultManager, VAULT_ROOT, GLOBAL_PLUGINS_ROOT } from './vault-manager.js';
import { RenderService } from './render-service.js';
import { settings } from './settings.js';
import { bridgeCall, toBase64 } from './native-bridge.js';
import { ARM_SCRIPT, READY_PROBE, LIGHT_THEME_SCRIPT, PAPER_SIZES } from './print-pdf.js';

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
	// A note embedding another goes stale when that other one changes, and
	// only the index knows which notes those are (main/session.js does the
	// same wiring).
	renderService.embeddersOf = (rel) => indexer.embeddersOf(rel);
	// The note's typeface as font files, for `font=note` figures: the bridge
	// builds NoteFont-*.ttf from CoreText once and the scheme handler serves
	// them; the engine needs the face → file map in its env before its first
	// standby spawns (render-service.js#noteFontsReady). A bridge without
	// the op (tests, an older build) leaves the map empty: Latin Modern.
	renderService.noteFontsReady = bridgeCall('noteFonts')
		.then((result) => { renderService.noteFonts = result?.faces ?? null; })
		.catch(() => { renderService.noteFonts = null; });
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

	// Office paths are reachable from preview documents (vault-authored
	// content) through the app page's office bridges, so as narrow as
	// upstream's writeOffice: an office extension, no '..', inside the vault.
	const officeRel = (path) => {
		const rel = typeof path === 'string' ? path : '';
		if (!/\.(odt|ods|odp|docx|xlsx|pptx)$/i.test(rel)) throw new Error(`Not an office document: ${rel}`);
		if (rel.split('/').some((seg) => seg === '..' || seg === '')) throw new Error(`Bad office path: ${rel}`);
		vaults.resolve(rel);
		return rel;
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
		// The welcome screen's other two ways in (upstream dd703e7). Create
		// asks the name in a native sheet and makes the folder in Documents;
		// the demo vault is the one Swift seeds on first launch anyway.
		[CH.VAULT_CREATE_DIALOG]: async () => {
			const created = await bridgeCall('createVault');
			if (!created?.path) return null;
			return openVault(created.path);
		},
		[CH.VAULT_OPEN_DEMO]: async () => {
			const demo = await bridgeCall('demoVaultPath');
			if (!demo?.path) return null;
			return openVault(demo.path);
		},
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

		// Note history: list/read snapshots, and restore one — upstream's
		// ipc.js shape (resolve() validates the path, history.js the id).
		// Restore force-snapshots the text it displaces, writes through
		// writeNote, and then ripples like NOTE_WRITE: on iOS a write is
		// renderer-originated, so the open editor learns of it from here,
		// not from a watcher.
		[CH.HISTORY_LIST]: ({ path }) => {
			vaults.resolve(path);
			return listSnapshots(VAULT_ROOT, path);
		},
		[CH.HISTORY_READ]: ({ path, id }) => {
			vaults.resolve(path);
			return readSnapshot(VAULT_ROOT, path, id);
		},
		[CH.HISTORY_RESTORE]: ({ path, id }) => {
			vaults.resolve(path);
			const text = readSnapshot(VAULT_ROOT, path, id);
			vaults.snapshotHistory(path, { force: true });
			vaults.writeNote(path, text);
			fileChanged(path);
		},
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

		// Annotation autosaves from every EmbedPDF surface (note embeds, the
		// file tab, canvas nodes, canvas-embed scenes) land here via the
		// vendored renderer/pdf-save.js bridge. Deliberately as narrow as
		// upstream's vault.writePdf: an existing .pdf inside the vault,
		// overwritten in place — never created, never renamed. That narrowness
		// IS the security argument for exposing a binary write to preview
		// documents, which are vault-authored content: the worst it can do is
		// overwrite a PDF the user already has, which is what annotating does
		// on purpose. Swift's updateBinary re-enforces existence and
		// containment and takes the coordinated-write lock.
		[CH.PDF_WRITE]: async ({ path, bytes }) => {
			const rel = typeof path === 'string' ? path : '';
			if (!/\.pdf$/i.test(rel)) throw new Error(`Not a PDF: ${rel}`);
			// resolve() would quietly pop a '..' back inside the vault; a save
			// request carrying one is malformed either way, so refuse it.
			if (rel.split('/').some((seg) => seg === '..' || seg === '')) {
				throw new Error(`Bad PDF path: ${rel}`);
			}
			const abs = vaults.resolve(rel);
			if (!vfs.has(abs)) throw new Error(`No such PDF: ${rel}`);
			// postMessage delivers a structured-clone Uint8Array; the bridge
			// speaks base64.
			const data = bytes instanceof Uint8Array ? bytes
				: ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
				: bytes instanceof ArrayBuffer ? new Uint8Array(bytes)
				: null;
			if (!data?.length) throw new Error('Empty PDF payload');
			await bridgeCall('updateBinary', { rel, base64: toBase64(data) });
			// Binaries live in the mirror as size-only stubs; move the mtime so
			// anything re-reading the file (a viewer remount, a rescan diff)
			// knows these bytes are new.
			vfs.patch(abs, '', Date.now());
			return true;
		},

		// The Excalidraw shape library, per vault: it is a working set that
		// belongs with the notes it illustrates, so a vault carries its own.
		// (Excalidraw itself keeps libraries in browser storage, which for a
		// note app means "until something clears it".)
		[CH.EXCALIDRAW_LIB_GET]: () => vaults.loadState('excalidraw-library.json') ?? [],
		[CH.EXCALIDRAW_LIB_SET]: ({ items }) => {
			vaults.saveState('excalidraw-library.json', items ?? []);
			return true;
		},

		// CJK fallback fonts: upstream downloads a 139 MB Noto pack on demand.
		// Not built on iOS — the settings section that offers it is patched out
		// of the renderer (scripts/build.js) and the scheme handler answers
		// pdffonts/fallback.json with `null`, EmbedPDF's "no fallback, and no
		// CDN either". These handlers exist so nothing reaches an unknown
		// channel: STATUS answers honestly that nothing is installed, and the
		// two mutating calls say why rather than failing obscurely. A native
		// URLSession downloader is a possible later feature.
		[CH.PDF_FONTS_STATUS]: () => ({
			installed: false, downloading: false, progress: null,
			packs: [], totalBytes: 0, bytesOnDisk: 0,
		}),
		[CH.PDF_FONTS_DOWNLOAD]: () => {
			throw new Error('CJK PDF fonts are not available on iOS');
		},
		[CH.PDF_FONTS_REMOVE]: () => {
			throw new Error('CJK PDF fonts are not available on iOS');
		},
		// Office documents. Upstream edits Word/Excel/PowerPoint in tabs with
		// LibreOffice-in-wasm (~1.6 GB resident) and thumbnails embeds by
		// booting the same offscreen. Neither is ported: the iPad content
		// process is killed well short of that, and whether to spike it at
		// all is the owner's call. What iOS has natively is Quick Look — a
		// read-only viewer for the same formats and a thumbnail generator —
		// so upstream's surfaces stay truthful instead of dead-ending: the
		// engine reports "not installed, no desktop LibreOffice" (the file
		// view's download offer is patched to say so in scripts/build.js);
		// "open externally" IS Quick Look; embeds and canvas nodes get real
		// thumbnails from QLThumbnailGenerator, cached where upstream caches
		// its own (.clew/cache/office-thumbs/<rel>.png, by mtime) so a vault
		// shared with desktop reuses either side's; and the download/remove/
		// convert/save/slot channels say why rather than fail as unknown.
		[CH.OFFICE_ENGINE_STATUS]: () => ({
			installed: false, downloading: false, managed: false, progress: null,
			lastError: null, wireBytes: 0, bytesOnDisk: 0, soffice: false,
		}),
		[CH.OFFICE_ENGINE_DOWNLOAD]: () => {
			throw new Error('The office engine (LibreOffice) is not available on iOS');
		},
		[CH.OFFICE_ENGINE_REMOVE]: () => {
			throw new Error('The office engine (LibreOffice) is not available on iOS');
		},
		[CH.OFFICE_SLOT_ACQUIRE]: () => ({ ok: false, path: null }),
		[CH.OFFICE_SLOT_RELEASE]: () => {},
		[CH.OFFICE_CONVERT_PDF]: () => ({ ok: false, reason: 'PDF conversion needs a desktop LibreOffice' }),
		[CH.OFFICE_WRITE]: () => {
			throw new Error('Office documents are read-only on iOS (no office engine)');
		},
		[CH.OFFICE_OPEN_EXTERNAL]: ({ path }) => {
			const rel = officeRel(path);
			bridgeCall('quickLook', { rel }).catch((err) => console.warn('[clew-ios] Quick Look failed:', err));
		},
		[CH.OFFICE_THUMBNAIL]: async ({ path }) => {
			const rel = officeRel(path);
			if (!vfs.has(vaults.resolve(rel))) return { ok: false, reason: 'missing document' };
			return bridgeCall('officeThumbnail', { rel });
		},
		// Only reachable with a dirty office document, which cannot exist
		// here; the safe answer is the one that never loses anything.
		[CH.CONFIRM_DISCARD]: () => 'cancel',
		[CH.WINDOW_CLOSE_RESOLVED]: () => {},
		[CH.SHELL_OPEN_EXTERNAL]: ({ url }) => {
			if (/^https?:|^mailto:/i.test(url)) bridgeCall('openExternal', { url }).catch(() => {});
		},
		// `[[x.pdf|external]]` (a vault-relative path) and file:// links (an
		// absolute path). Upstream's planOpen decides — vault clamp, missing
		// file, executables refused BY NAME — over the mirror, and iOS's
		// "default app" is Quick Look, as for office documents: the system's
		// read-only viewer with its own share / open-in sheet. A file:// link
		// can only reach the open vault here (nothing outside the sandbox is
		// reachable), and a folder has no viewer.
		[CH.SHELL_OPEN_PATH]: ({ path, url }) => {
			let rel;
			if (url) {
				const abs = pathFromFileUrl(url);
				if (!abs) return { ok: false, reason: 'Not a local file:// link' };
				const root = vaults.realPath?.replace(/\/+$/, '');
				if (!root || !abs.startsWith(root + '/')) {
					return { ok: false, reason: 'On iOS a file:// link can only open a file inside the open vault' };
				}
				rel = abs.slice(root.length + 1);
			} else {
				rel = String(path ?? '');
			}
			const plan = planOpen(vaults, { rel });
			if (!plan.ok) return plan;
			if (vfs.isDir(plan.target)) return { ok: false, reason: `Folders cannot be opened on iOS: ${rel}` };
			bridgeCall('quickLook', { rel }).catch((err) => console.warn('[clew-ios] Quick Look failed:', err));
			return { ok: true };
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
			// `dataviewJs` is ours: upstream leaves it to the next vault open,
			// which reads as an oversight — an immediate reconfigure is
			// strictly better and this handler is iOS-owned. (Upstream
			// candidate, recorded in PORT-PLAN.)
			if (key === 'jmarkdownProject' || key === 'normalSyntax'
				|| key === 'pandocCitations' || key === 'dataviewJs') {
				renderService.reconfigure({ [key]: value === true });
			}
			// Bibliography settings rewrite the engine config the same way.
			if (key === 'bibliography' || key === 'bibliographyStyle') {
				renderService.reconfigure({ [key]: value });
			}
			if (key === 'plugins') renderService.reconfigure({ plugins: value });
			return current;
		},

		// Both roots, exactly as upstream: the vault's own .clew/plugins/ and
		// the global folder (Documents/Plugins here), mirrored under
		// GLOBAL_PLUGINS_ROOT at vault open; a vault plugin shadows a global
		// one of the same id, and enabling stays per vault. globalDir is the
		// device path, which the settings row shows as its tooltip.
		[CH.PLUGINS_LIST]: () => {
			const globalDir = vaults.globalPluginsPath;
			if (!vaults.isOpen) return { plugins: [], enabled: [], globalDir };
			const vaultSettings = vaults.loadState('vault-settings.json') ?? {};
			return {
				plugins: listPlugins(VAULT_ROOT, GLOBAL_PLUGINS_ROOT),
				enabled: Array.isArray(vaultSettings.plugins) ? vaultSettings.plugins : [],
				globalDir,
			};
		},
		// "Open global plugin folder": Documents/Plugins, created on the way
		// and shown in the Files app — the iOS reveal. A plugin installed
		// there is discovered at the next vault open.
		[CH.PLUGINS_REVEAL_GLOBAL]: async () => {
			const result = await bridgeCall('revealGlobalPlugins');
			return result?.path ?? null;
		},

		[CH.EXPORT_NOTE]: async ({ path, format }) => {
			const base = path.split('/').pop().replace(/\.(md|jmd)$/i, '');
			if (format === 'print-pdf') {
				// The note as the app draws it: the bridge loads this session's
				// own clew-preview:// document in a hidden web view, waits for
				// upstream's ready probe (print-pdf.js), paginates it and offers
				// the PDF in the share sheet — iOS's save dialog.
				vaults.resolve(path);
				const encoded = path.split('/').map(encodeURIComponent).join('/');
				const paper = String(settings.get('printPaperSize') ?? 'a4').toLowerCase();
				await bridgeCall('printPdf', {
					url: `clew-preview://vault/${encodeURIComponent(SESSION_ID)}/${encoded}.html`,
					name: `${base}.pdf`,
					paperSize: PAPER_SIZES.includes(paper) ? paper : 'a4',
					arm: ARM_SCRIPT,
					probe: READY_PROBE,
					lightTheme: LIGHT_THEME_SCRIPT,
				});
				return { shared: true };
			}
			if (format !== 'html') {
				throw new Error(`${format} export needs a LaTeX toolchain and is not available on iOS`);
			}
			const html = await renderService.ensureRendered(path);
			const name = `${base}.html`;
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
