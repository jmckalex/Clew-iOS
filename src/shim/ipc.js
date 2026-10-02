// The iOS replacement for Electron's main process: every clew:* channel the
// renderer uses (per the port audit — 35 invokes, 9 events), implemented
// in-page against the vault mirror, the vendored services, and the native
// bridge. Installs window.clew with exact preload semantics: invoke returns
// a promise; on returns an unsubscribe function; handlers get payload only.
import { CH } from '../../vendor/clew/shared/channels.js';
import { parseBib, bibFilePath } from '../../vendor/clew/shared/bib.js';
import { Indexer } from '../../vendor/clew/main/indexer.js';
import { SearchService } from '../../vendor/clew/main/search.js';
import { KvStore, KV_FILE } from '../../vendor/clew/main/kv-store.js';
import { propagateRename } from '../../vendor/clew/main/rename-links.js';
import { listPlugins } from '../../vendor/clew/main/plugins.js';
import { planOpen, pathFromFileUrl } from '../../vendor/clew/main/open-file.js';
import { direntKind, shouldRecurse, walkGuard } from '../../vendor/clew/main/fs-utils.js';
import { listSnapshots, readSnapshot } from '../../vendor/clew/main/history.js';
import { rewritePdfFrames } from '../../vendor/clew/main/pdf-frames-rewrite.js';
// The ENGINE's callout modules (jmarkdown a7de8c6), the pure ones only:
// callouts.js would pull config-manager (fs) into the app page, and
// desktop's main/callout-types.js reads its icon table from disk.
import { resolveCallouts, iconKey } from '../../vendor/jmarkdown/src/callout-definitions.js';
import { BUILTIN_CALLOUT_TYPES } from '../../vendor/jmarkdown/src/callout-table.js';
import fs from 'node:fs';
import nodePath from 'node:path';
import { vfs } from '../worker/shims/vfs.js';
import { VaultManager, VAULT_ROOT, GLOBAL_PLUGINS_ROOT } from './vault-manager.js';
import { RenderService } from './render-service.js';
import { settings } from './settings.js';
import { bridgeCall, toBase64 } from './native-bridge.js';
import { ARM_SCRIPT, READY_PROBE, LIGHT_THEME_SCRIPT, PAPER_SIZES } from './print-pdf.js';

/**
 * Where an entry's BibTeX `file` field points (upstream ipc.js, verbatim
 * over the mirror): relative to its .bib's folder first, then the vault
 * root; `inVault` paths are vault-relative (a Clew PDF tab), others
 * absolute. On iOS an absolute path names something outside the sandbox,
 * which SHELL_OPEN_PATH refuses with a reason — so it is reported exactly
 * as upstream would, `inVault: false, exists: false`, and the Library
 * shows the same "not found" state a desktop shows for a moved file.
 *
 * @returns {{ path: string, inVault: boolean, exists: boolean } | null}
 */
function resolveBibFile(value, bibDir, root) {
	const raw = bibFilePath(value);
	if (!raw) return null;
	const candidates = nodePath.isAbsolute(raw) ? [raw] : [nodePath.join(bibDir, raw), nodePath.join(root, raw)];
	const found = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
	const abs = found ?? candidates[0];
	const rel = nodePath.relative(root, abs);
	const inVault = !rel.startsWith('..') && !nodePath.isAbsolute(rel);
	return { path: inVault ? rel.split(nodePath.sep).join('/') : abs, inVault, exists: Boolean(found) };
}

export function createClewShim({ workerFactory, assetLoader, iconTableLoader } = {}) {
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
	const indexer = new Indexer();
	const renderService = new RenderService({ workerFactory, assetLoader });
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

	// ---- custom callout types (Clew-app 096f129 → 67311b6) ----------------
	// The global list is this device's settings `callouts`; a vault's is its
	// .clew/vault-settings.json `callouts`. Both are resolved over the
	// built-ins with the Font Awesome table in hand (the engine's
	// callout-definitions.js has the rules), so the worker (CLEW_CALLOUTS)
	// and the app page (CALLOUTS_RESOLVED) get only finished entries. The
	// table (~1.9 MB, built into the WebRoot as fa-icons.json, as desktop's
	// build writes it) is fetched the first time a definition exists or the
	// Settings picker asks, and never otherwise: never on a render path.
	const loadIcons = iconTableLoader ?? (async () => (await fetch('/fa-icons.json')).json());
	let iconTablePromise = null;
	const iconTable = () => {
		iconTablePromise ??= loadIcons().catch((err) => {
			console.warn('[clew-ios] no icon table:', err);
			iconTablePromise = null; // a later ask may succeed
			return { version: null, icons: {} };
		});
		return iconTablePromise;
	};
	const isEmpty = (list) => list == null || (Array.isArray(list) && list.length === 0);
	let callouts = { key: null, custom: {}, problems: [] };
	/** Re-resolve both lists (memoised on them); the vault's is read now,
	 *  so a hand edit of vault-settings.json is what this answers with. */
	const refreshCallouts = async () => {
		const globalList = settings.get('callouts');
		const vaultList = vaults.isOpen ? vaults.loadState('vault-settings.json')?.callouts : undefined;
		const key = JSON.stringify([globalList ?? null, vaultList ?? null]);
		if (key === callouts.key) return callouts;
		if (isEmpty(globalList) && isEmpty(vaultList)) {
			callouts = { key, custom: {}, problems: [] };
			return callouts;
		}
		const table = await iconTable();
		const { custom, problems } = resolveCallouts({
			builtins: BUILTIN_CALLOUT_TYPES,
			global: globalList ?? [],
			vault: vaultList ?? [],
			iconTable: table.icons ?? {},
		});
		callouts = { key, custom, problems };
		return callouts;
	};
	renderService.calloutsReady = () => refreshCallouts();
	renderService.calloutsEnv = () => (Object.keys(callouts.custom).length ? JSON.stringify(callouts.custom) : '');
	/** A list changed: resolve again, then a fresh standby and every open
	 *  preview, and the app page's editors (live edit draws callouts too). */
	const calloutsChanged = async (options) => {
		await refreshCallouts();
		renderService.reconfigure(options);
		send(CH.EV_CALLOUTS_CHANGED);
	};

	vaults.hooks = {
		// A random sid per vault opening (minted natively, VaultStore.swift):
		// every preview URL the render service writes carries it.
		onSession: (sid) => { renderService.sessionId = sid; },
		onOpen: (root) => {
			// The device's trust first: the first standby's engine config
			// carries `Run note code` (desktop session.js does the same
			// before the render service opens the vault).
			renderService.setNoteCode(vaults.trusted);
			renderService.openVault(root);
			// The vault's exclusion lists (vault-excludes.js): what is
			// `unindexed` is walked past, exactly as upstream's session.js.
			indexer.openVault(root, vaults.excludes);
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
	// clewdata.json sits in the vault root, in the explorer: its first write
	// shows it at once (Clew-app 5077207's rule — a new file Clew writes is
	// in the tree now, not when a rescan notices).
	kvStore.onCreated = () => structureChanged();

	// A note's own PDF frames — <iframe|embed|object> naming a PDF — go to
	// Clew's viewer as the document is SERVED (vendor main/pdf-frames-
	// rewrite.js, as desktop's protocol.js#wrapPreviewDocument runs it; a
	// site export never comes through here). Web PDFs are registered with
	// NATIVE before the HTML leaves (docs/dev/pdf-unification.md §8): a
	// first pass lists them, the bridge answers {url: hash}, and a second
	// pass writes the viewer URLs from those hashes — the viewer is handed a
	// hash, never a URL, and the route serves only what native registered.
	// The bridge answers the app page alone, so no preview can register.
	const servePdfFrames = async (html, noteRel = null) => {
		const sid = vaults.sessionId;
		if (typeof html !== 'string' || !sid) return html;
		const noteDir = noteRel && noteRel.includes('/') ? noteRel.slice(0, noteRel.lastIndexOf('/')) : '';
		const first = rewritePdfFrames(html, { sid, noteDir });
		if (first.remote.length === 0) return first.html;
		let registered = {};
		try {
			({ registered = {} } = (await bridgeCall('registerRemotePdfs', { urls: [...new Set(first.remote)] })) ?? {});
		} catch (err) {
			console.error('[clew-ios] web PDF registration failed:', err);
		}
		return rewritePdfFrames(html, { sid, noteDir, registerRemote: (url) => registered[url] ?? null }).html;
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

	// ---- switching vaults --------------------------------------------------
	// Desktop opens another vault in ANOTHER WINDOW (main/main.js
	// #openVaultAnywhere reuses a window only while it has no vault), so the
	// shared renderer never switches in place: its vault UI (recents, Create,
	// the demo) is the Welcome screen, which a window with a vault never
	// shows. The iPad has one scene. Switching in place would leave the old
	// vault's renderer state behind — its editors (tab ids are per-vault
	// counters, so A's `t3` would survive as B's), its callout table, index,
	// timers and frames — and the renderer flushes unsaved edits on
	// EV_VAULT_OPENED, i.e. into the NEW vault. So a switch is a fresh page,
	// as desktop's is a fresh window: settle this vault (the renderer's own
	// close handshake — PDF annotations written, Save / Discard / Cancel for
	// anything dirty — then every editor's save and the workspace into THIS
	// vault), name the next one natively, reload. The boot opens it like any
	// launch, with a new session id and caller token.
	const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	let closeAnswer = null;
	/** The renderer's close question (office-dock.js#onCloseRequested): true
	 *  to go on, false when the user cancelled. No listener, no question. */
	const closeHandshake = () => {
		if (!listeners.get(CH.EV_CLOSE_REQUESTED)?.size) return Promise.resolve(true);
		return new Promise((resolve) => {
			const timer = setTimeout(() => { closeAnswer = null; resolve(false); }, 60_000);
			closeAnswer = (proceed) => { clearTimeout(timer); closeAnswer = null; resolve(proceed); };
			send(CH.EV_CLOSE_REQUESTED, {});
		});
	};
	/** Leave the open vault with nothing unsaved; false when cancelled. */
	const prepareLeave = async () => {
		if (!(await closeHandshake())) return false;
		globalThis.__clew?.editorPool?.flushAll();
		// The editors' saves dispatch, and the workspace's debounced save
		// (500 ms) lands, before the native queue is drained.
		await pause(650);
		await vaults.flush();
		return true;
	};
	const samePath = (a, b) => String(a ?? '').replace(/\/+$/, '') === String(b ?? '').replace(/\/+$/, '');
	/** Open `path`: in place when no vault is open, else as a switch. */
	const switchTo = async (path) => {
		if (!vaults.isOpen) return openVault(path);
		if (samePath(path, vaults.realPath)) return vaults.info;
		if (!(await prepareLeave())) return null;
		const next = await bridgeCall('setNextVault', { path });
		if (!next?.ok) throw new Error(next?.reason ?? `That vault cannot be opened: ${path}`);
		// Headless (the Node harness) there is no page to reload: the vault,
		// settled all the same, opens in place.
		if (typeof vaultSwitch.reload !== 'function') return openVault(next.path);
		vaultSwitch.reload();
		return new Promise(() => {}); // the page is going
	};
	const vaultSwitch = {
		switchTo,
		/** Remembered vaults with their standing ({path, ok, resolved?, name,
		 *  kind, reason?}), most recent first, the open one marked. */
		recent: async () => {
			const paths = settings.get('recentVaults') ?? [];
			const statuses = paths.length ? await bridgeCall('vaultStatus', { paths }) : [];
			// A Documents vault is remembered by full path, and the app's
			// container moves (a reinstall moves it; iOS promises no stable
			// path), so two remembered paths can be ONE vault. One row each,
			// the most recent, at its CURRENT path, and the list rewritten so.
			const seen = new Set();
			const list = [];
			for (const st of statuses) {
				const key = st.resolved ?? st.path;
				if (seen.has(key)) continue;
				seen.add(key);
				const here = st.kind === 'documents' && st.resolved ? st.resolved : st.path;
				list.push({ ...st, path: here, current: samePath(key, vaults.realPath) });
			}
			const rewritten = list.map((st) => st.path);
			if (rewritten.join('\n') !== paths.join('\n')) settings.setRecentVaults(rewritten);
			return list;
		},
		/** Remove a remembered vault (never the open one). */
		forget: async (path) => {
			if (samePath(path, vaults.realPath)) return false;
			settings.forgetVault(path);
			await bridgeCall('forgetVault', { path }).catch(() => {});
			return true;
		},
		openFolder: async () => {
			const picked = await bridgeCall('pickFolder');
			return picked?.path ? switchTo(picked.path) : null;
		},
		createVault: async () => {
			const created = await bridgeCall('createVault');
			return created?.path ? switchTo(created.path) : null;
		},
		openDemo: async () => {
			const demo = await bridgeCall('demoVaultPath');
			return demo?.path ? switchTo(demo.path) : null;
		},
		reload: globalThis.location?.reload ? () => globalThis.location.reload() : null,
	};
	// The app page's own UI (vault-switcher.js) answers Save / Discard /
	// Cancel; without one, nothing dirty is ever dropped.
	const ui = { confirmDiscard: null };

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
		// Every way into a vault goes through switchTo: in place when none is
		// open, a settled switch when one is (above).
		[CH.VAULT_OPEN_DIALOG]: () => vaultSwitch.openFolder(),
		[CH.VAULT_OPEN_PATH]: ({ path }) => switchTo(path),
		// The welcome screen's other two ways in (upstream dd703e7). Create
		// asks the name in a native sheet and makes the folder in Documents;
		// the demo vault is the one Swift seeds on first launch anyway.
		[CH.VAULT_CREATE_DIALOG]: () => vaultSwitch.createVault(),
		[CH.VAULT_OPEN_DEMO]: () => vaultSwitch.openDemo(),
		// The app page's own vault, token included (upstream ipc.js answers
		// with vaults.ownInfo); the open handlers' answers never carry it.
		[CH.VAULT_CURRENT]: async () => {
			if (vaults.isOpen) return vaults.ownInfo;
			const boot = await bridgeCall('vaultBootstrap');
			if (!boot?.path) return null;
			await openVault(boot.path, { silent: true });
			return vaults.ownInfo;
		},
		[CH.VAULT_RECENT]: () => settings.get('recentVaults'),
		[CH.VAULT_TREE]: () => vaults.tree(),

		[CH.NOTE_READ]: ({ path }) => vaults.readNote(path),
		[CH.NOTE_WRITE]: ({ path, content }) => {
			// A write that CREATES the note (a template, a daily note, a
			// plugin's note) is in the explorer at once (Clew-app 5077207).
			const created = !vfs.has(vaults.resolve(path));
			vaults.writeNote(path, content);
			fileChanged(path);
			if (created) structureChanged();
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

		// Citations as objects (upstream b52b9e1): every entry carries the
		// .bib it came from (`bib`) and where its `file` field points
		// (`pdf`), in upstream's shape — the old `file: rel` key is gone.
		// A .bib inside an `unindexed` folder is that library's, not this
		// vault's: completion never offers it.
		[CH.BIB_ENTRIES]: () => {
			if (!vaults.isOpen) return [];
			const out = [];
			const seen = walkGuard(VAULT_ROOT);
			const walk = (dir, rel) => {
				let entries;
				try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
				for (const entry of entries) {
					const childRel = rel ? `${rel}/${entry.name}` : entry.name;
					if (vaults.excludes.isUnindexed(childRel)) continue;
					const abs = nodePath.join(dir, entry.name);
					const kind = direntKind(dir, entry);
					if (kind === 'dir') {
						if (shouldRecurse(abs, seen)) walk(abs, childRel);
					} else if (kind === 'file' && entry.name.toLowerCase().endsWith('.bib')) {
						try {
							out.push(...parseBib(String(vfs.read(abs))).map((e) => ({
								...e, bib: childRel, pdf: resolveBibFile(e.file, dir, VAULT_ROOT),
							})));
						} catch { /* unreadable bib */ }
					}
				}
			};
			walk(VAULT_ROOT, '');
			return out;
		},

		[CH.MENU_STATE]: (state) => { globalThis.__clewMenuState = state; },

		[CH.KV_GET]: ({ key }) => (vaults.isOpen ? kvStore.get(key) ?? null : null),
		[CH.KV_SET]: ({ key, value }) => (vaults.isOpen ? kvStore.set(key, value) : null),
		[CH.KV_DELETE]: ({ key }) => (vaults.isOpen ? kvStore.delete(key) : null),
		[CH.KV_LIST]: ({ prefix } = {}) => (vaults.isOpen ? kvStore.list(prefix ?? '') : {}),

		[CH.RENDER_SUBSCRIBE]: ({ path }) => renderService.subscribe(path),
		[CH.RENDER_UNSUBSCRIBE]: ({ path }) => renderService.unsubscribe(path),
		// A note's rendered HTML — the References panel's "This note" feed
		// (upstream b1b5790, renderedHtml). Missing here until 2026-09-30, so
		// the panel said "Could not render this note" whenever a vault turned
		// bibliographyPanel on. resolve() refuses a path outside the vault.
		[CH.RENDER_HTML]: ({ path }) => {
			vaults.resolve(path);
			return renderService.ensureRendered(path);
		},

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
		// A PDF's first page for canvas portals (pdf-unification §2, §8):
		// Quick Look, natively, at the mirrored .clew/cache/pdf-thumbs/<rel>.png
		// — never an offscreen EmbedPDF. Upstream pdf-thumbs.js's refusals.
		[CH.PDF_THUMBNAIL]: async ({ path }) => {
			const rel = typeof path === 'string' ? path : '';
			if (!/\.pdf$/i.test(rel)) return { ok: false, reason: `not a PDF: ${rel}` };
			let abs;
			try { abs = vaults.resolve(rel); } catch (err) { return { ok: false, reason: String(err.message) }; }
			if (!vfs.has(abs)) return { ok: false, reason: 'missing PDF' };
			return bridgeCall('pdfThumbnail', { rel });
		},
		// A web PDF's viewer (pdf-page.js, read-only) through the app page's
		// pdf-save.js: the viewer names the registered HASH, and native finds
		// the URL in this session's own registrations (Clew-app ipc.js).
		// Save a copy writes the cached bytes into the attachment folder,
		// never overwriting — a native binary write, so the mirror learns of
		// the new file here and the explorer shows it at once.
		[CH.REMOTE_PDF_SAVE_COPY]: async ({ key }) => {
			if (!vaults.isOpen) throw new Error('No vault open');
			const { rel } = await bridgeCall('saveRemotePdfCopy', {
				hash: String(key ?? ''),
				folder: settings.get('attachmentFolder') || 'Attachments',
			});
			vfs.patch(`${VAULT_ROOT}/${rel}`, '', Date.now());
			structureChanged();
			return { path: rel };
		},
		[CH.REMOTE_PDF_OPEN]: ({ key }) => bridgeCall('openRemotePdf', { hash: String(key ?? '') }),

		// This device's trust in the open vault (VaultTrust.swift; Clew-app
		// ipc.js, the interim guard): never a vault setting, and set only
		// from the app's own chrome — the banner and Settings → This vault.
		// SET rewrites the engine config and re-renders every open preview.
		[CH.VAULT_TRUST_GET]: () => ({
			trusted: vaults.isOpen && vaults.trusted === true,
			refused: vaults.trusted ? [] : renderService.refusedNames(),
		}),
		[CH.VAULT_TRUST_SET]: async ({ trusted }) => {
			if (!vaults.isOpen) return { trusted: false };
			const answer = await bridgeCall('vaultTrustSet', { trusted: trusted === true });
			vaults.trusted = answer?.trusted === true;
			renderService.setNoteCode(vaults.trusted);
			send(CH.EV_VAULT_TRUST_CHANGED, { trusted: vaults.trusted });
			return { trusted: vaults.trusted };
		},

		[CH.OFFICE_THUMBNAIL]: async ({ path }) => {
			const rel = officeRel(path);
			if (!vfs.has(vaults.resolve(rel))) return { ok: false, reason: 'missing document' };
			return bridgeCall('officeThumbnail', { rel });
		},
		// Only reachable with a dirty office document, which cannot exist
		// here; the safe answer is the one that never loses anything.
		// Save / Discard / Cancel before a dirty document goes (a vault
		// switch's close handshake): the app page's dialog, or Cancel.
		[CH.CONFIRM_DISCARD]: async (args) => (ui.confirmDiscard ? ui.confirmDiscard(args ?? {}) : 'cancel'),
		[CH.WINDOW_CLOSE_RESOLVED]: ({ proceed } = {}) => {
			if (proceed === 'pending') return; // still asking or saving
			closeAnswer?.(proceed === true);
		},
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

		// A workspace saved on the desktop may have the shell panel open; the
		// panel is a dead surface here (no PTY — see SHELL_OPEN), so it is
		// forced closed on the way in rather than restored as a blank strip.
		[CH.WORKSPACE_LOAD]: () => {
			const state = vaults.loadState('workspace.json');
			if (state && typeof state === 'object' && state.shell && typeof state.shell === 'object') {
				state.shell = { ...state.shell, open: false };
			}
			return state;
		},
		[CH.WORKSPACE_SAVE]: (state) => vaults.saveState('workspace.json', state),
		[CH.SETTINGS_GET]: () => settings.get(),
		[CH.SETTINGS_SET]: async ({ key, value }) => {
			settings.set(key, value);
			// The global TeX fragments are read at worker spawn: a change here
			// retires the standby and re-renders the open previews (upstream
			// ipc.js does this for every window; there is one here).
			if (key === 'texFragments') renderService.reconfigure({});
			// The global callout types: the worker and the editor.
			if (key === 'callouts') await calloutsChanged({});
		},
		[CH.VSTATE_LOAD]: ({ name }) => vaults.loadState(sanitizeStateName(name)),
		[CH.VSTATE_SAVE]: ({ name, data }) => vaults.saveState(sanitizeStateName(name), data),

		[CH.VAULT_SETTINGS_GET]: () => vaults.loadState('vault-settings.json') ?? {},
		[CH.VAULT_SETTINGS_SET]: async ({ key, value }) => {
			const current = vaults.loadState('vault-settings.json') ?? {};
			current[key] = value;
			vaults.saveState('vault-settings.json', current);
			// The same list as upstream's ipc.js (dataviewJs joined it in
			// 055d46b): these reach the worker only at spawn, so they need a
			// fresh standby.
			if (key === 'jmarkdownProject' || key === 'normalSyntax'
				|| key === 'pandocCitations' || key === 'dataviewJs') {
				renderService.reconfigure({ [key]: value === true });
			}
			// Bibliography settings rewrite the engine config the same way.
			if (key === 'bibliography' || key === 'bibliographyStyle') {
				renderService.reconfigure({ [key]: value });
			}
			// The exclusion lists (vault-excludes.js): every walk in the app
			// was made under the old rules, so the tree and the index go again.
			if (key === 'hidden' || key === 'unindexed') {
				vaults.reloadExcludes();
				indexer.openVault(VAULT_ROOT, vaults.excludes);
			}
			// This vault's TeX fragments: the worker reads them at spawn, so
			// the standby has to go and the open previews re-render.
			if (key === 'texFragments') renderService.reconfigure({ texFragments: value });
			if (key === 'plugins') renderService.reconfigure({ plugins: value });
			// This vault's callout types: the worker's table (CLEW_CALLOUTS is
			// read at spawn) and the editor.
			if (key === 'callouts') await calloutsChanged({ callouts: value });
			return current;
		},
		// Custom callout types for this vault, resolved: { custom, problems }.
		[CH.CALLOUTS_RESOLVED]: async () => {
			const { custom, problems } = await refreshCallouts();
			return { custom, problems };
		},
		// The icon table, for Settings only (never a render): whole for the
		// picker, or just the names a list of rows uses, for their previews.
		[CH.CALLOUT_ICONS]: async (args) => {
			const table = await iconTable();
			if (!Array.isArray(args?.names)) return table;
			const icons = {};
			for (const name of args.names.slice(0, 500)) {
				const found = iconKey(name, table.icons ?? {});
				if (found) icons[String(name)] = { key: found, icon: table.icons[found] };
			}
			return { version: table.version, icons };
		},

		// ---- the shell panel ----------------------------------------------
		// Upstream spawns a real shell in a pty per window (main/shell-core.js).
		// Nothing of the kind can exist on iOS, so the four channels answer
		// with upstream's own failure shapes — `{ ok: false, error }` is what
		// the panel prints in red if it is ever opened — and the two events
		// never fire. The panel cannot be opened from here anyway: its command
		// is dropped from the registry (scripts/build.js) and WORKSPACE_LOAD
		// forces it closed.
		[CH.SHELL_OPEN]: () => ({ ok: false, error: 'A shell is not available on iOS' }),
		[CH.SHELL_WRITE]: () => ({ ok: false }),
		[CH.SHELL_RESIZE]: () => ({ ok: false }),
		[CH.SHELL_CLOSE]: () => ({ ok: false }),

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
					url: `clew-preview://vault/${encodeURIComponent(vaults.sessionId)}/${encoded}.html`,
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
		renderNote: async (rel) => servePdfFrames(await renderService.ensureRendered(rel), rel),
		renderFragment: async (text) => servePdfFrames(await renderService.renderFragment(text)),
		// Live edit's block frames (SchemeHandler.swift `__clew_block__`):
		// POST {text, sourcePath} → the document's key; GET by key → the
		// HTML, or null once evicted (a 404, and the frame layer POSTs
		// again). A sourcePath that escapes the vault is refused here —
		// resolve() throws — which the handler answers as 403.
		renderBlock: async (text, sourcePath) => {
			if (sourcePath != null) vaults.resolve(sourcePath);
			return renderService.renderBlock(text, { sourcePath: sourcePath ?? null });
		},
		blockDocument: async (key) => {
			const html = renderService.blockDocument(key);
			return html === undefined ? null : servePdfFrames(html, renderService.blockSourcePath(key));
		},
		externalDiff: (diff) => vaults.applyExternalDiff(diff),
		flush: () => vaults.flush(),
		get sessionId() { return vaults.sessionId; },
	};

	return { clew, native, send, vaultSwitch, ui, services: { vaults, indexer, renderService, kvStore, searchService, settings } };
}

export { CH, VAULT_ROOT, toBase64 };
