// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Vault management: opening a vault (any folder of .md/.jmd files), walking
// its tree, file operations, chokidar watching, and .clew/ state persistence.
// All renderer-supplied paths are vault-relative and validated to stay inside
// the vault root.
import { shell } from 'electron';
import chokidar from 'chokidar';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { settings } from './settings.js';
import { direntKind, shouldRecurse, walkGuard } from './fs-utils.js';

// Never shown in the explorer, never indexed.
const IGNORED_DIRS = new Set(['.obsidian', '.clew', '.git', 'node_modules', '.trash']);

export class VaultManager {
	/** Absolute path of the open vault, or null. */
	root = null;
	/** Set by the owning VaultSession; rides in info/events so the renderer
	 *  can build session-scoped clew-preview:// URLs. */
	sessionId = null;
	#watcher = null;
	#treeDebounce = null;
	/** @type {(channel: string, payload: any) => void} */
	send = () => {};
	/** Optional lifecycle hooks set by the session (render service wiring). */
	hooks = {};

	get isOpen() { return this.root !== null; }

	get info() {
		return this.root
			? { path: this.root, name: path.basename(this.root), sessionId: this.sessionId }
			: null;
	}

	// ---- opening ----------------------------------------------------------

	open(vaultPath) {
		const abs = path.resolve(vaultPath);
		if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
			throw new Error(`Not a directory: ${abs}`);
		}
		this.close();
		this.root = abs;
		fs.mkdirSync(path.join(abs, '.clew'), { recursive: true });
		settings.rememberVault(abs);
		this.#startWatcher();
		this.hooks.onOpen?.(abs);
		const info = this.info;
		this.send('clew:ev-vault-opened', { vault: info, tree: this.tree() });
		return info;
	}

	close() {
		this.hooks.onClose?.();
		this.#watcher?.close();
		this.#watcher = null;
		this.root = null;
	}

	// ---- tree -------------------------------------------------------------

	tree() {
		if (!this.root) return null;
		const seen = walkGuard(this.root);
		const walk = (dir, rel) => {
			const entries = [];
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
				const childRel = rel ? `${rel}/${entry.name}` : entry.name;
				const kind = direntKind(dir, entry);
				if (kind === 'dir') {
					const abs = path.join(dir, entry.name);
					if (!shouldRecurse(abs, seen)) continue;
					entries.push({ type: 'folder', name: entry.name, path: childRel, children: walk(abs, childRel) });
				} else if (kind === 'file') {
					entries.push({ type: 'file', name: entry.name, path: childRel });
				}
			}
			// Folders first, then files, each alphabetically (Obsidian's default).
			entries.sort((a, b) =>
				a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.type === 'folder' ? -1 : 1);
			return entries;
		};
		return walk(this.root, '');
	}

	// ---- file operations --------------------------------------------------

	/** Resolve a vault-relative path, refusing anything that escapes the root. */
	resolve(rel) {
		if (!this.root) throw new Error('No vault open');
		const abs = path.resolve(this.root, rel);
		if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
			throw new Error(`Path escapes vault: ${rel}`);
		}
		return abs;
	}

	readNote(rel) {
		return fs.readFileSync(this.resolve(rel), 'utf8');
	}

	writeNote(rel, content) {
		const abs = this.resolve(rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content);
	}

	/**
	 * Overwrite an existing PDF in place (annotation autosave).
	 *
	 * Deliberately narrow. The caller is a viewer running inside a preview
	 * document, which is vault-authored content, so this must not become a
	 * general "write arbitrary bytes anywhere" capability: the path has to
	 * resolve inside the vault, end in .pdf, and already exist. Annotating
	 * edits a file you are looking at; it never creates one.
	 */
	writePdf(rel, data) {
		if (!/\.pdf$/i.test(rel)) throw new Error(`Not a PDF: ${rel}`);
		const abs = this.resolve(rel);
		if (!fs.existsSync(abs)) throw new Error(`No such PDF: ${rel}`);
		fs.writeFileSync(abs, Buffer.from(data));
	}

	/** Create a new note; appends " 1", " 2", … if the name is taken. Returns the rel path. */
	createNote(rel) {
		let abs = this.resolve(rel);
		const dir = path.dirname(abs);
		const ext = path.extname(abs) || '.md';
		const base = path.basename(abs, path.extname(abs));
		let candidate = path.join(dir, base + ext);
		for (let i = 1; fs.existsSync(candidate); i++) {
			candidate = path.join(dir, `${base} ${i}${ext}`);
		}
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(candidate, '');
		return path.relative(this.root, candidate);
	}

	createFolder(rel) {
		fs.mkdirSync(this.resolve(rel), { recursive: true });
	}

	/**
	 * Save pasted/dropped bytes into the attachment folder, deduplicating the
	 * name ("x.png" → "x 1.png" …). Returns the vault-relative path. HEIC
	 * photos are transparently converted to JPEG on macOS (Chromium cannot
	 * display HEIC, and EXIF GPS survives the conversion) — the vault only
	 * ever receives the .jpg.
	 */
	saveAttachment(name, data, folder) {
		const safe = path.basename(name).replace(/[/\\:]/g, '-');
		const dir = this.resolve(folder || 'Attachments');
		fs.mkdirSync(dir, { recursive: true });
		let ext = path.extname(safe);
		let stem = safe.slice(0, safe.length - ext.length) || 'attachment';
		const heic = /^\.(heic|heif)$/i.test(ext) && process.platform === 'darwin';
		if (heic) ext = '.jpg';
		let candidate = path.join(dir, `${stem}${ext}`);
		for (let i = 1; fs.existsSync(candidate); i++) {
			candidate = path.join(dir, `${stem} ${i}${ext}`);
		}
		if (heic) {
			const tmp = path.join(os.tmpdir(), `clew-heic-${Date.now()}${path.extname(safe)}`);
			try {
				fs.writeFileSync(tmp, Buffer.from(data));
				execFileSync('sips', ['-s', 'format', 'jpeg', tmp, '--out', candidate], { stdio: 'ignore' });
				return path.relative(this.root, candidate);
			} catch {
				// Conversion failed — fall through and keep the original bytes.
				candidate = candidate.replace(/\.jpg$/, path.extname(safe));
			} finally {
				fs.rmSync(tmp, { force: true });
			}
		}
		fs.writeFileSync(candidate, Buffer.from(data));
		return path.relative(this.root, candidate);
	}

	rename(rel, newRel) {
		const from = this.resolve(rel);
		const to = this.resolve(newRel);
		if (fs.existsSync(to)) throw new Error(`Already exists: ${newRel}`);
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.renameSync(from, to);
	}

	async trash(rel) {
		await shell.trashItem(this.resolve(rel));
	}

	reveal(rel) {
		shell.showItemInFolder(this.resolve(rel));
	}

	// ---- vault-level persistence (.clew/) ---------------------------------

	loadState(name) {
		if (!this.root) return null;
		try {
			return JSON.parse(fs.readFileSync(path.join(this.root, '.clew', name), 'utf8'));
		} catch {
			return null;
		}
	}

	saveState(name, data) {
		if (!this.root) return;
		fs.writeFileSync(path.join(this.root, '.clew', name), JSON.stringify(data, null, 2));
	}

	// ---- watching ---------------------------------------------------------

	#startWatcher() {
		this.#watcher = chokidar.watch('.', {
			cwd: this.root,
			ignored: (p) => p.split('/').some((seg) => seg.startsWith('.') || IGNORED_DIRS.has(seg)),
			ignoreInitial: true,
		});
		this.#watcher.on('all', (event, rel) => {
			// Individual file content changes matter to open editors and previews…
			if (event === 'change') {
				this.send('clew:ev-file-changed', { path: rel });
				this.hooks.onFileChanged?.(rel);
			}
			// …and structure changes refresh the explorer and re-key the index.
			if (event !== 'change') {
				clearTimeout(this.#treeDebounce);
				this.#treeDebounce = setTimeout(() => {
					if (!this.root) return;
					this.send('clew:ev-tree-changed', { tree: this.tree() });
					this.hooks.onStructureChanged?.();
				}, 300);
			}
		});
	}
}

export const vaults = new VaultManager();
