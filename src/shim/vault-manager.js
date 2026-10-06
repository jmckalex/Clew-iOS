// iOS VaultManager: the same surface as vendor/clew/main/vault.js with
// Electron/chokidar/node swapped for the vault mirror + native bridge.
//
// The open vault lives in the shared in-memory vfs under /vault — the same
// fs instance the vendored services (indexer, search, kv-store,
// rename-links, plugins) see through the bundle's node:fs alias, so those
// services run verbatim. Text writes go through the vfs write-through hooks
// to the native bridge; binary files exist in the mirror as size-only stubs
// and are served to previews directly by the Swift scheme handler.
//
// External changes (Files app, iCloud sync) arrive as native rescan diffs
// through applyExternalDiff — the chokidar replacement.
//
// Note history (.clew/history/ snapshots) is upstream's history.js run
// VERBATIM over the mirror, like the indexer and kv-store: the on-disk
// format is identical by construction, and its fs calls (copy, utimes, rm,
// rename) reach the device through the same write-through hooks.
import { vfs } from '../worker/shims/vfs.js';
import { snapshotBeforeWrite, renameHistory } from '../../vendor/clew/main/history.js';
import { renamePdfMeta } from '../../vendor/clew/main/pdf-meta.js';
import { bridgeCall, toBase64 } from './native-bridge.js';
import { settings } from './settings.js';
import { isTextPath } from './engine-config.js';
import { compileExcludes } from '../../vendor/clew/main/vault-excludes.js';

/** Desktop's atomic-write temp beside its target: `.<basename>.clew-tmp`. */
const isAtomicTemp = (rel) => /(^|\/)\.[^/]+\.clew-tmp$/.test(rel);

export const VAULT_ROOT = '/vault';

// Globally installed plugins — Documents/Plugins on iOS, the one place a
// user can put files from the Files app (desktop's <userData>/plugins would
// be unreachable here) — are mirrored READ-ONLY under a second root at
// vault open, so upstream's plugins.js discovers them over the same fs
// alias as the vault's own. Nothing under here ever reaches the bridge
// (#relOf maps /vault only), and no rescan diffs it: a plugin dropped in
// mid-session is picked up at the next vault open.
export const GLOBAL_PLUGINS_ROOT = '/global-plugins';

// Which files are text lives with the engine config — the Node harness needs
// both without dragging the bridge in. Re-exported here for existing callers.
export { isTextPath };

/** An access record from native, every key present and well-typed; a
 *  missing one is the restricted answer. */
export function normalizeAccess(raw, trusted = false) {
	const a = raw && typeof raw === 'object' ? raw : {};
	const t = a.trusted === undefined ? trusted === true : a.trusted === true;
	return {
		trusted: t,
		decided: a.decided === true,
		scripts: t && a.scripts === true,
		plugins: Array.isArray(a.plugins) ? a.plugins.filter((id) => typeof id === 'string') : [],
		noteApi: t && a.noteApi === true,
		dataviewJs: t && a.dataviewJs === true,
		network: t && a.network === true,
	};
}

export class VaultManager {
	/** Real on-device path of the open vault (bridge-side), or null. */
	realPath = null;
	name = null;
	/** Real on-device path of the global plugin folder (bridge-side), or null. */
	globalPluginsPath = null;
	sessionId = null;
	/** The session's caller token (Clew-app session.js); never in `info`. */
	callerToken = null;
	/** This device's trust in the open vault (VaultTrust.swift, vaultOpen's
	 *  reply): whether the engine may run its notes' code. False with no
	 *  vault, and for a vault the device has not trusted. */
	trusted = false;
	/** The session's access (desktop's session.access): {trusted, decided,
	 *  scripts, plugins, noteApi, dataviewJs, network}. */
	access = normalizeAccess(null, false);
	/** Vault paths of links leading OUT of the open vault: never followed on
	 *  iPad (VaultPaths.swift), said once by ios-ui.js. */
	refusedLinks = [];
	/** @type {(channel: string, payload: any) => void} */
	send = () => {};
	hooks = {};
	/** The mirror root every service resolves against. */
	root = VAULT_ROOT;
	/** What this vault asks Clew to leave alone — upstream's vault-excludes.js,
	 *  verbatim over the mirror (the `hidden` and `unindexed` lists of
	 *  vault-settings.json, plus the built-in dot/.clew/.git/node_modules/
	 *  .trash rules that used to be a local IGNORED_DIRS). Compiled at open
	 *  and whenever the two lists change; consulted by every walk — the
	 *  tree here, the indexer, the rename rewriter and the .bib scan
	 *  (ipc.js), all of which are upstream code over the same fs alias, so
	 *  the semantics are identical by construction. The Swift snapshot
	 *  still carries hidden files (a perf cost, not a correctness one). */
	excludes = compileExcludes({});

	#flushQueue = Promise.resolve();
	#pendingWrites = 0;

	get isOpen() { return this.realPath !== null; }

	get info() {
		return this.isOpen
			? { path: this.realPath, name: this.name, sessionId: this.sessionId }
			: null;
	}

	/** `info` plus the caller token: what the app page may be told about its
	 *  own vault (upstream vault.js#ownInfo) — the vault-opened event and
	 *  VAULT_CURRENT. The renderer's showVault takes the token off before any
	 *  store sees the vault. */
	get ownInfo() {
		const info = this.info;
		return info && this.callerToken ? { ...info, callerToken: this.callerToken } : info;
	}

	// ---- opening ----------------------------------------------------------

	async open(vaultPath) {
		this.close();
		const { name, path: realPath, files, globalPlugins, sessionId, callerToken, trusted, access, identity, refusedLinks, cloudConflicts, demoSync } = await bridgeCall('vaultOpen', { path: vaultPath });
		// This device's identity for the vault (VaultTrust.swift): what an
		// app's origin key derives from (apps.js), never a path.
		this.identity = typeof identity === 'string' ? identity : null;
		this.realPath = realPath;
		this.name = name;
		// Minted natively per opening: preview URLs carry the sid, and the
		// render POSTs the token (SchemeHandler.swift checks both).
		this.sessionId = sessionId ?? null;
		this.callerToken = callerToken ?? null;
		this.trusted = trusted === true;
		// What this device lets the vault run (VaultTrust.swift): never the
		// vault's own settings, which are only its request.
		this.access = normalizeAccess(access, this.trusted);
		// Links leading out of the vault, which native skipped (VaultPaths.swift).
		this.refusedLinks = Array.isArray(refusedLinks) ? refusedLinks : [];
		// Opened with iCloud conflicts outstanding: said once the vault is up.
		this.openCloudConflicts = Array.isArray(cloudConflicts) ? cloudConflicts : [];
		// The demo vault brought up to date as it opened (DemoSync.swift):
		// { added, updated }, said in a notice once the vault is up.
		this.demoSync = demoSync && typeof demoSync === 'object' ? demoSync : null;
		this.hooks.onSession?.(this.sessionId);
		vfs.mkdir(VAULT_ROOT);
		for (const [rel, entry] of Object.entries(files)) {
			vfs.patch(`${VAULT_ROOT}/${rel}`, entry.text ?? '', entry.mtimeMs);
		}
		vfs.mkdir(`${VAULT_ROOT}/.clew`);
		// realPath is set above, so loadState reads the mirror already.
		this.excludes = compileExcludes(this.loadState('vault-settings.json') ?? {});
		this.globalPluginsPath = globalPlugins?.path ?? null;
		if (globalPlugins?.files) {
			vfs.mkdir(GLOBAL_PLUGINS_ROOT);
			for (const [rel, entry] of Object.entries(globalPlugins.files)) {
				vfs.patch(`${GLOBAL_PLUGINS_ROOT}/${rel}`, entry.text ?? '', entry.mtimeMs);
			}
		}
		// Persist mirror writes to the device vault. Only text files under
		// /vault flow through here; render-worker output never does (separate
		// bundle, separate vfs instance).
		// Vendored modules (indexer, kv-store, rename-links) save through
		// upstream's writeFileAtomic: a `.<name>.clew-tmp` beside the target,
		// then a rename over it. The mirror sees both steps; the device sees
		// ONE write of the target — Swift's AtomicFile already gives every
		// bridge write exactly that shape, and a temp file must never leave
		// the mirror (the walks that skip it are the point of the name).
		vfs.onWrite = (abs, data) => {
			const rel = this.#relOf(abs);
			if (rel === null || isAtomicTemp(rel)) return;
			if (typeof data !== 'string') {
				// Bytes written to a TEXT file (history.js#keepVersion writes a
				// Buffer) are text: the mirror keeps text as strings, and the
				// device gets them. Binaries have their own bridge calls.
				if (!isTextPath(rel)) return;
				data = new TextDecoder().decode(data);
				const entry = vfs.files.get(abs);
				if (entry) entry.data = data;
			}
			this.#writeText(rel, data);
		};
		vfs.onMkdir = (abs) => {
			const rel = this.#relOf(abs);
			if (rel) this.#enqueue(() => bridgeCall('mkdir', { vault: this.realPath, rel }));
		};
		vfs.onRename = (fromAbs, toAbs) => {
			const rel = this.#relOf(fromAbs);
			const newRel = this.#relOf(toAbs);
			if (!rel || !newRel) return;
			if (isAtomicTemp(rel)) {
				// The commit step of writeFileAtomic: the target now holds the
				// bytes. Text files live in the mirror as strings — normalise
				// so readers and the rescan diff see one representation.
				const entry = vfs.files.get(toAbs);
				if (entry && typeof entry.data !== 'string' && isTextPath(newRel)) {
					entry.data = new TextDecoder().decode(entry.data);
				}
				if (typeof entry?.data !== 'string') {
					console.error(`[clew-ios] atomic write of a non-text file is not supported: ${newRel}`);
					return;
				}
				this.#writeText(newRel, entry.data);
				return;
			}
			this.#enqueue(() => bridgeCall('rename', { vault: this.realPath, rel, newRel }));
		};
		vfs.onUtimes = (abs, mtimeMs) => {
			const rel = this.#relOf(abs);
			if (rel) this.#enqueue(() => bridgeCall('setMtime', { vault: this.realPath, rel, mtimeMs }));
		};
		vfs.onRemove = (abs) => {
			// User files are deleted through trash() only. The one thing that
			// deletes through the mirror is history pruning, so that is the
			// one thing allowed to reach the device (Swift refuses the rest).
			const rel = this.#relOf(abs);
			if (rel?.startsWith('.clew/history/')) {
				this.#enqueue(() => bridgeCall('remove', { vault: this.realPath, rel }));
			}
		};
		settings.rememberVault(realPath);
		this.hooks.onOpen?.(VAULT_ROOT);
		this.send('clew:ev-vault-opened', { vault: this.ownInfo, tree: this.tree() });
		return this.info;
	}

	close() {
		if (!this.isOpen) return;
		this.hooks.onClose?.();
		vfs.onWrite = vfs.onMkdir = vfs.onRemove = vfs.onRename = vfs.onUtimes = null;
		vfs.reset();
		this.realPath = null;
		this.name = null;
		this.globalPluginsPath = null;
		this.sessionId = null;
		this.callerToken = null;
		this.trusted = false;
		this.access = normalizeAccess(null, false);
		this.identity = null;
		this.excludes = compileExcludes({});
	}

	/**
	 * The vault's exclusion lists changed. Everything that walked the vault
	 * under the old rules has to walk again: the tree the window shows and
	 * the index behind search and backlinks (the caller re-opens the
	 * indexer with the new excludes, as upstream's ipc.js does). No watcher
	 * to restart here: the Swift rescan diffs the whole folder and the
	 * mirror filters on arrival.
	 */
	reloadExcludes() {
		if (!this.isOpen) return null;
		this.excludes = compileExcludes(this.loadState('vault-settings.json') ?? {});
		const tree = this.tree();
		this.send('clew:ev-tree-changed', { tree });
		this.hooks.onStructureChanged?.();
		return tree;
	}

	#relOf(abs) {
		if (!abs.startsWith(VAULT_ROOT + '/')) return null;
		return abs.slice(VAULT_ROOT.length + 1);
	}

	/** A text file's mirror content to the device (unguarded, as desktop's
	 *  writes are unless an editor asks: writeNoteGuarded). */
	#writeText(rel, text) {
		this.#enqueue(() => bridgeCall('write', { vault: this.realPath, rel, text }));
	}

	/** Queue a native job after every write before it; resolves with ITS
	 *  result (or rejects with its error) while the queue carries on. */
	#enqueue(job) {
		this.#pendingWrites++;
		const run = this.#flushQueue.then(job);
		this.#flushQueue = run
			.catch((err) => console.error('[clew-ios] vault write failed:', err))
			.finally(() => { this.#pendingWrites--; });
		return run;
	}

	/** The disk versions a guarded save was refused over, rel → mtimeMs:
	 *  in the mirror now, and "seen" natively once the renderer reads one
	 *  (markSeenOnRead) — Keep theirs reads it afresh. */
	#refusedOver = new Map();

	/**
	 * An editor's save (NOTE_WRITE {guard}): desktop's write-guard.js, with
	 * the guard natively (VaultStore.write). The device first — refused over
	 * a version this app has not seen, nothing is written and the answer is
	 * {conflict, disk}; the mirror then holds the disk's version (it mirrors
	 * the disk), and the editor holds its own. `force` is "keep mine".
	 */
	async writeNoteGuarded(rel, content, { guard = false, force = false } = {}) {
		const abs = this.resolve(rel);
		this.snapshotHistory(rel);
		const answer = await this.#enqueue(() => bridgeCall('write', { vault: this.realPath, rel, text: content, guard, force }));
		if (answer?.conflict) {
			const disk = String(answer.disk ?? '');
			vfs.patch(abs, disk, answer.mtimeMs ?? Date.now());
			this.#refusedOver.set(rel, answer.mtimeMs);
			return { conflict: true, disk };
		}
		this.#refusedOver.delete(rel);
		vfs.patch(abs, content, Date.now());
		return null;
	}

	/** The renderer read `rel`: if it is a version a guarded save was refused
	 *  over, this app has now seen it (VaultStore.markSeen). */
	markSeenOnRead(rel) {
		if (!this.#refusedOver.has(rel)) return;
		const mtimeMs = this.#refusedOver.get(rel);
		this.#refusedOver.delete(rel);
		if (typeof mtimeMs === 'number') this.#enqueue(() => bridgeCall('markSeen', { vault: this.realPath, rel, mtimeMs }));
	}

	/** Resolves when every queued native write has landed. */
	flush() { return this.#flushQueue; }

	/** The user's "keep mine" after a conflict: written over whatever is on
	 *  disk, through the same queue. */
	writeForce(rel, text) {
		this.resolve(rel);
		this.#enqueue(() => bridgeCall('write', { vault: this.realPath, rel, text, force: true }));
		return this.flush();
	}

	// ---- tree -------------------------------------------------------------

	tree() {
		if (!this.isOpen) return null;
		const walk = (dirAbs, rel) => {
			const entries = [];
			let names;
			try { names = vfs.readdir(dirAbs); } catch { return entries; }
			for (const name of names) {
				const childAbs = `${dirAbs}/${name}`;
				const childRel = rel ? `${rel}/${name}` : name;
				// `hidden` only: an `unindexed` folder is still listed and still
				// opens — that is the whole difference between the two lists.
				if (this.excludes.isHidden(childRel)) continue;
				if (vfs.isDir(childAbs)) {
					entries.push({ type: 'folder', name, path: childRel, children: walk(childAbs, childRel) });
				} else {
					entries.push({ type: 'file', name, path: childRel });
				}
			}
			entries.sort((a, b) =>
				a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.type === 'folder' ? -1 : 1);
			return entries;
		};
		return walk(VAULT_ROOT, '');
	}

	// ---- file operations --------------------------------------------------

	/** Resolve a vault-relative path into the mirror, refusing escapes. */
	resolve(rel) {
		if (!this.isOpen) throw new Error('No vault open');
		const parts = [];
		for (const seg of String(rel).split('/')) {
			if (seg === '' || seg === '.') continue;
			if (seg === '..') {
				if (!parts.length) throw new Error(`Path escapes vault: ${rel}`);
				parts.pop();
			} else parts.push(seg);
		}
		return `${VAULT_ROOT}/${parts.join('/')}`;
	}

	readNote(rel) {
		const data = vfs.read(this.resolve(rel));
		return typeof data === 'string' ? data : new TextDecoder().decode(data);
	}

	writeNote(rel, content) {
		const abs = this.resolve(rel);
		this.snapshotHistory(rel);
		vfs.write(abs, content);
	}

	/**
	 * Preserve the note's current content in .clew/history/ before it is
	 * displaced (rate-limited inside; `force` for restore, where the
	 * displaced text must survive regardless of the interval). Same call,
	 * same options source as upstream's VaultManager.
	 */
	snapshotHistory(rel, { force = false } = {}) {
		const options = this.loadState('vault-settings.json')?.history;
		return snapshotBeforeWrite(VAULT_ROOT, rel, options, { force });
	}

	createNote(rel) {
		const abs = this.resolve(rel);
		const dir = abs.slice(0, abs.lastIndexOf('/'));
		const base = abs.slice(abs.lastIndexOf('/') + 1);
		const dot = base.lastIndexOf('.');
		const ext = dot > 0 ? base.slice(dot) : '.md';
		const stem = dot > 0 ? base.slice(0, dot) : base;
		let candidate = `${dir}/${stem}${ext}`;
		for (let i = 1; vfs.has(candidate); i++) {
			candidate = `${dir}/${stem} ${i}${ext}`;
		}
		vfs.write(candidate, '');
		return candidate.slice(VAULT_ROOT.length + 1);
	}

	createFolder(rel) {
		vfs.mkdir(this.resolve(rel));
	}

	/** Save pasted/picked bytes into the attachment folder. HEIC→JPEG happens
	 *  native-side (Image I/O), so the mirror only learns the final name. */
	async saveAttachment(name, data, folder) {
		const safe = String(name).split('/').pop().replaceAll(':', '-').replaceAll('\\', '-') || 'attachment';
		const dirRel = folder || 'Attachments';
		const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
		const { rel, size } = await bridgeCall('writeBinary', {
			vault: this.realPath,
			rel: `${dirRel}/${safe}`,
			base64: toBase64(bytes),
		});
		void size;
		this.addedNatively(rel);
		return rel;
	}

	/** A binary file native wrote straight into the vault (an attachment,
	 *  a scan): into the mirror as a stub, and into the tree now. */
	addedNatively(rel) {
		vfs.patch(`${VAULT_ROOT}/${rel}`, '', Date.now());
		this.send('clew:ev-tree-changed', { tree: this.tree() });
		this.hooks.onStructureChanged?.();
	}

	rename(rel, newRel) {
		const from = this.resolve(rel);
		const to = this.resolve(newRel);
		if (vfs.has(to)) throw new Error(`Already exists: ${newRel}`);
		// Mirror first (synchronously — the indexer re-walk depends on it);
		// the onRename hook carries it to the device, where binary content
		// moves natively. The note's history moves with it (upstream's
		// renameHistory, whose fs.renameSync lands on the same hook).
		vfs.rename(from, to);
		renameHistory(VAULT_ROOT, rel, newRel);
		// What quote-and-cite remembers about a PDF moves with it (pdf-meta.js).
		try { renamePdfMeta(VAULT_ROOT, rel, newRel); } catch (err) { console.warn('[clew-ios] pdf-citations rename:', err?.message ?? err); }
	}

	async trash(rel) {
		vfs.rm(this.resolve(rel));
		await bridgeCall('trash', { vault: this.realPath, rel });
		this.send('clew:ev-tree-changed', { tree: this.tree() });
		this.hooks.onStructureChanged?.();
	}

	reveal() { /* no Finder on iOS */ }

	// ---- vault-level persistence (.clew/) ---------------------------------

	loadState(name) {
		if (!this.isOpen) return null;
		try {
			const data = vfs.read(`${VAULT_ROOT}/.clew/${name}`);
			return JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
		} catch {
			return null;
		}
	}

	saveState(name, data) {
		if (!this.isOpen) return;
		vfs.write(`${VAULT_ROOT}/.clew/${name}`, JSON.stringify(data, null, 2));
	}

	// ---- external changes (the chokidar replacement) ----------------------

	/** Apply a native rescan diff; fires the same events/hooks the desktop
	 *  watcher would. */
	applyExternalDiff({ changed = {}, removed = [], cloudConflicts = null }) {
		if (!this.isOpen) return;
		// iCloud's own conflict versions, still unresolved (VaultStore.swift).
		if (Array.isArray(cloudConflicts)) this.hooks.onCloudConflicts?.(cloudConflicts);
		let structure = false;
		for (const [rel, entry] of Object.entries(changed)) {
			// A rescan has seen it natively: no refused-over version waits.
			this.#refusedOver.delete(rel);
			const abs = `${VAULT_ROOT}/${rel}`;
			const existed = vfs.has(abs);
			vfs.patch(abs, entry.text ?? '', entry.mtimeMs);
			if (!existed) structure = true;
			else {
				this.send('clew:ev-file-changed', { path: rel });
				this.hooks.onFileChanged?.(rel);
			}
		}
		for (const rel of removed) {
			vfs.remove(`${VAULT_ROOT}/${rel}`);
			structure = true;
		}
		if (structure) {
			this.send('clew:ev-tree-changed', { tree: this.tree() });
			this.hooks.onStructureChanged?.();
		}
	}
}
