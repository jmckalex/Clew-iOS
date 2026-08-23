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
import { vfs } from '../worker/shims/vfs.js';
import { bridgeCall, toBase64 } from './native-bridge.js';
import { settings } from './settings.js';

const IGNORED_DIRS = new Set(['.obsidian', '.clew', '.git', 'node_modules', '.trash']);

export const VAULT_ROOT = '/vault';

const TEXT_EXT = /\.(md|jmd|bib|canvas|json|css|js|mjs|txt|csl|xml|yaml|yml|svg|html|gpx|geojson|tex|bibtex|org|csv)$/i;
export const isTextPath = (rel) => TEXT_EXT.test(rel);

export class VaultManager {
	/** Real on-device path of the open vault (bridge-side), or null. */
	realPath = null;
	name = null;
	sessionId = null;
	/** @type {(channel: string, payload: any) => void} */
	send = () => {};
	hooks = {};
	/** The mirror root every service resolves against. */
	root = VAULT_ROOT;

	#flushQueue = Promise.resolve();
	#pendingWrites = 0;

	get isOpen() { return this.realPath !== null; }

	get info() {
		return this.isOpen
			? { path: this.realPath, name: this.name, sessionId: this.sessionId }
			: null;
	}

	// ---- opening ----------------------------------------------------------

	async open(vaultPath) {
		this.close();
		const { name, path: realPath, files } = await bridgeCall('vaultOpen', { path: vaultPath });
		this.realPath = realPath;
		this.name = name;
		vfs.mkdir(VAULT_ROOT);
		for (const [rel, entry] of Object.entries(files)) {
			vfs.patch(`${VAULT_ROOT}/${rel}`, entry.text ?? '', entry.mtimeMs);
		}
		vfs.mkdir(`${VAULT_ROOT}/.clew`);
		// Persist mirror writes to the device vault. Only text files under
		// /vault flow through here; render-worker output never does (separate
		// bundle, separate vfs instance).
		vfs.onWrite = (abs, data) => {
			const rel = this.#relOf(abs);
			if (rel === null || typeof data !== 'string') return;
			this.#enqueue(() => bridgeCall('write', { vault: this.realPath, rel, text: data }));
		};
		vfs.onMkdir = (abs) => {
			const rel = this.#relOf(abs);
			if (rel) this.#enqueue(() => bridgeCall('mkdir', { vault: this.realPath, rel }));
		};
		vfs.onRemove = (abs) => {
			// Deletions go through trash() explicitly; the hook covers only
			// incidental removals (e.g. rename via write+rm in fs shims).
		};
		settings.rememberVault(realPath);
		this.hooks.onOpen?.(VAULT_ROOT);
		this.send('clew:ev-vault-opened', { vault: this.info, tree: this.tree() });
		return this.info;
	}

	close() {
		if (!this.isOpen) return;
		this.hooks.onClose?.();
		vfs.onWrite = vfs.onMkdir = vfs.onRemove = null;
		vfs.reset();
		this.realPath = null;
		this.name = null;
	}

	#relOf(abs) {
		if (!abs.startsWith(VAULT_ROOT + '/')) return null;
		return abs.slice(VAULT_ROOT.length + 1);
	}

	#enqueue(job) {
		this.#pendingWrites++;
		this.#flushQueue = this.#flushQueue
			.then(job)
			.catch((err) => console.error('[clew-ios] vault write failed:', err))
			.finally(() => { this.#pendingWrites--; });
	}

	/** Resolves when every queued native write has landed. */
	flush() { return this.#flushQueue; }

	// ---- tree -------------------------------------------------------------

	tree() {
		if (!this.isOpen) return null;
		const walk = (dirAbs, rel) => {
			const entries = [];
			let names;
			try { names = vfs.readdir(dirAbs); } catch { return entries; }
			for (const name of names) {
				if (name.startsWith('.') || IGNORED_DIRS.has(name)) continue;
				const childAbs = `${dirAbs}/${name}`;
				const childRel = rel ? `${rel}/${name}` : name;
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
		vfs.write(this.resolve(rel), content);
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
		vfs.patch(`${VAULT_ROOT}/${rel}`, '', Date.now());
		void size;
		this.send('clew:ev-tree-changed', { tree: this.tree() });
		this.hooks.onStructureChanged?.();
		return rel;
	}

	rename(rel, newRel) {
		const from = this.resolve(rel);
		const to = this.resolve(newRel);
		if (vfs.has(to)) throw new Error(`Already exists: ${newRel}`);
		// Mirror first (synchronously — the indexer re-walk depends on it),
		// then the device, preserving binary content natively.
		if (vfs.isDir(from)) {
			const prefix = from + '/';
			for (const [abs, entry] of [...vfs.files]) {
				if (abs.startsWith(prefix)) {
					vfs.patch(to + abs.slice(from.length), entry.data, entry.mtimeMs);
					vfs.remove(abs);
				}
			}
			vfs.remove(from);
			vfs.dirs.add(to);
		} else {
			const entry = vfs.files.get(from);
			vfs.patch(to, entry?.data ?? '', entry?.mtimeMs);
			vfs.remove(from);
		}
		this.#enqueue(() => bridgeCall('rename', { vault: this.realPath, rel, newRel }));
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
	applyExternalDiff({ changed = {}, removed = [] }) {
		if (!this.isOpen) return;
		let structure = false;
		for (const [rel, entry] of Object.entries(changed)) {
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
