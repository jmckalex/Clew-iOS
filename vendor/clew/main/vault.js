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
import { direntKind, shouldRecurse, walkGuard, writeFileAtomic, WATCH_BUDGET, WATCH_CEILING, watchFilter, watchPlan, scanShare, knownPaths } from './fs-utils.js';
import { compileExcludes } from './vault-excludes.js';
import { snapshotBeforeWrite, renameHistory } from './history.js';

// The walk/watch rules (which directories are never shown, and the
// descriptor budget the watcher lives inside) are in fs-utils.js, with the
// other symlink-aware walk helpers — and so that they can be unit-tested
// without electron.
//
// The count is HERE, module-level, because the descriptor ceiling is a
// process one and every window has its own VaultManager: one budget, drawn
// on by all of them, handed back in close().
let watchedTotal = 0;

export class VaultManager {
	/** Absolute path of the open vault, or null. */
	root = null;
	/** Set by the owning VaultSession; rides in info/events so the renderer
	 *  can build session-scoped clew-preview:// URLs. */
	sessionId = null;
	/** The session's caller token (session.js); never in `info`. */
	callerToken = null;
	#watcher = null;
	#watchState = null;
	#watchCap = null;
	/** What this vault asks Clew to leave alone — vault-excludes.js. Compiled
	 *  when the vault opens and whenever the two lists change, and consulted
	 *  by every walk: the tree, the watcher, the indexer, the rename
	 *  rewriter, the .bib scan and the site export. */
	excludes = compileExcludes({});
	#treeDebounce = null;
	/** @type {(channel: string, payload: any) => void} */
	send = () => {};
	/** Optional lifecycle hooks set by the session (render service wiring). */
	hooks = {};

	get isOpen() { return this.root !== null; }

	/**
	 * What THIS window may be told about its own vault: `info` plus the
	 * caller token. Only the two paths that reach the session's own window
	 * use it — the vault-opened event and VAULT_CURRENT — because the open
	 * handlers also return `info` to a DIFFERENT window when the vault is
	 * already open elsewhere (main.js#openVaultAnywhere).
	 */
	get ownInfo() {
		const info = this.info;
		return info && this.callerToken ? { ...info, callerToken: this.callerToken } : info;
	}

	get info() {
		return this.root
			? {
				path: this.root, name: path.basename(this.root), sessionId: this.sessionId,
				// What the watcher could not take on. Broadcast when it happens
				// (EV_WATCH_CAPPED) and carried here as well for the window that
				// was not there to hear it: a reload re-runs the renderer's boot
				// handshake long after the scan settled, and a vault half-watched
				// is exactly the thing a fresh window should still be told about.
				watchCap: this.#watchCap,
			}
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
		this.excludes = compileExcludes(this.loadState('vault-settings.json') ?? {});
		// One walk, two uses: the tree the window opens with, and the set of
		// symlinked directories it skipped as duplicates — which is exactly
		// what the watcher must not follow a second time.
		const duplicates = new Set();
		const files = [];
		const tree = this.tree(duplicates, files);
		this.#startWatcher(duplicates, files);
		this.hooks.onOpen?.(abs);
		this.send('clew:ev-vault-opened', { vault: this.ownInfo, tree });
		return this.info;
	}

	/**
	 * Push a fresh tree to the window now. Clew's own file operations know
	 * exactly when they changed the vault, and waiting for the watcher to
	 * tell us is both slower (a 300ms debounce) and, in a vault whose watch
	 * budget is spent, a message that never comes.
	 */
	refreshTree() {
		if (!this.root) return null;
		const tree = this.tree();
		this.send('clew:ev-tree-changed', { tree });
		this.hooks.onStructureChanged?.();
		return tree;
	}

	/**
	 * The vault's exclusion lists changed. Everything that walked the vault
	 * under the old rules has to walk again: the tree the window shows, the
	 * watcher (a folder just excluded must stop costing descriptors, and one
	 * just admitted must start being watched), and the index behind search
	 * and backlinks.
	 */
	reloadExcludes() {
		if (!this.root) return;
		this.excludes = compileExcludes(this.loadState('vault-settings.json') ?? {});
		this.#watcher?.close();
		watchedTotal = Math.max(0, watchedTotal - (this.#watchState?.accepted.size ?? 0));
		this.#watchState = null;
		const duplicates = new Set();
		const files = [];
		const tree = this.tree(duplicates, files);
		this.#startWatcher(duplicates, files);
		this.send('clew:ev-tree-changed', { tree });
		this.hooks.onStructureChanged?.();
		return tree;
	}

	close() {
		this.hooks.onClose?.();
		this.#watcher?.close();
		this.#watcher = null;
		// Hand this window's share of the descriptor budget back.
		watchedTotal = Math.max(0, watchedTotal - (this.#watchState?.accepted.size ?? 0));
		this.#watchState = null;
		this.root = null;
	}

	// ---- tree -------------------------------------------------------------

	/**
	 * @param {Set<string>} [duplicates] collects directories skipped because
	 *   another path already reached the same real directory — the watcher
	 *   needs them (it follows every symlink separately and would otherwise
	 *   watch one tree once per link).
	 * @param {string[]} [files] collects every listed file, so the watcher can
	 *   decide what to spend its budget on BEFORE chokidar walks (fs-utils.js
	 *   #watchPlan). The walk is happening anyway; the order is the only
	 *   thing the watcher could not work out for itself.
	 */
	tree(duplicates = null, files = null) {
		if (!this.root) return null;
		const seen = walkGuard(this.root);
		const walk = (dir, rel) => {
			const entries = [];
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const childRel = rel ? `${rel}/${entry.name}` : entry.name;
				// `hidden` only: an `unindexed` folder is still listed and still
				// opens — that is the whole difference between the two lists,
				// and it is affordable because the explorer is windowed.
				if (this.excludes.isHidden(childRel)) continue;
				const kind = direntKind(dir, entry);
				if (kind === 'dir') {
					const abs = path.join(dir, entry.name);
					if (!shouldRecurse(abs, seen)) { duplicates?.add(childRel); continue; }
					entries.push({ type: 'folder', name: entry.name, path: childRel, children: walk(abs, childRel) });
				} else if (kind === 'file') {
					entries.push({ type: 'file', name: entry.name, path: childRel });
					files?.push(childRel);
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
		const created = !fs.existsSync(abs);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		this.snapshotHistory(rel);
		writeFileAtomic(abs, content);
		// A NEW file (an annotations note, a template's output, a save to a
		// path that did not exist) is a structure change; an autosave of an
		// existing note is not, and must not pay for a tree walk.
		if (created) this.refreshTree();
	}

	/**
	 * Clew just wrote `abs` — an export, a website, a canvas PNG — to a place
	 * the user chose, which may or may not be inside this vault. Inside it,
	 * the explorer is refreshed now, as Clew's own file operations do: the
	 * watcher is not to be waited for (a 300 ms debounce at best, and in a
	 * vault whose watch budget is spent, a message that never comes — the
	 * owner's PDF export into ph341, 2026-09-30). Outside, nothing.
	 */
	refreshIfInside(abs) {
		if (!this.root || !abs) return;
		const inside = (root, target) => {
			const rel = path.relative(root, target);
			return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
		};
		const target = path.resolve(abs);
		let real = target;
		try {
			real = path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
		} catch { /* the plain path is all there is */ }
		let realRoot = this.root;
		try { realRoot = fs.realpathSync(this.root); } catch { /* ditto */ }
		if (inside(this.root, target) || inside(realRoot, real)) this.refreshTree();
	}

	/**
	 * Preserve the note's current disk content in .clew/history/ before it
	 * is displaced (rate-limited inside; `force` for restore, where the
	 * displaced text must survive regardless of the interval).
	 */
	snapshotHistory(rel, { force = false } = {}) {
		const options = this.loadState('vault-settings.json')?.history;
		return snapshotBeforeWrite(this.root, rel, options, { force });
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
		writeFileAtomic(abs, Buffer.from(data));
	}

	// The ZetaOffice viewer's save path, guarded like writePdf: only an
	// office document that already exists inside the vault may be
	// overwritten — the viewer edits documents, it does not create them.
	writeOffice(rel, data) {
		if (!/\.(odt|ods|odp|docx|xlsx|pptx)$/i.test(rel)) throw new Error(`Not an office document: ${rel}`);
		const abs = this.resolve(rel);
		if (!fs.existsSync(abs)) throw new Error(`No such document: ${rel}`);
		writeFileAtomic(abs, Buffer.from(data));
	}

	/** Create a new note; appends " 1", " 2", … if the name is taken. Returns the rel path. */
	createNote(rel) {
		// "Tasks.md" typed into a create box arrives as "Tasks.md.md" once
		// the caller appends the extension — collapse it; nobody means that.
		rel = rel.replace(/(\.md)+$/i, '.md');
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
		this.refreshTree();
		return path.relative(this.root, candidate);
	}

	createFolder(rel) {
		fs.mkdirSync(this.resolve(rel), { recursive: true });
		this.refreshTree();
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
				this.refreshTree();
				return path.relative(this.root, candidate);
			} catch {
				// Conversion failed — fall through and keep the original bytes.
				candidate = candidate.replace(/\.jpg$/, path.extname(safe));
			} finally {
				fs.rmSync(tmp, { force: true });
			}
		}
		writeFileAtomic(candidate, Buffer.from(data));
		// Always a new file (the name was deduplicated): the explorer shows it
		// now rather than whenever the watcher gets round to it.
		this.refreshTree();
		return path.relative(this.root, candidate);
	}

	rename(rel, newRel) {
		const from = this.resolve(rel);
		const to = this.resolve(newRel);
		if (fs.existsSync(to)) throw new Error(`Already exists: ${newRel}`);
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.renameSync(from, to);
		renameHistory(this.root, rel, newRel);
		this.refreshTree();
	}

	async trash(rel) {
		await shell.trashItem(this.resolve(rel));
		this.refreshTree();
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
		writeFileAtomic(path.join(this.root, '.clew', name), JSON.stringify(data, null, 2));
	}

	// ---- watching ---------------------------------------------------------

	#startWatcher(duplicates = new Set(), files = null) {
		// The budget exists to bound the INITIAL SCAN — that is what turned
		// into 100,169 descriptors. Once chokidar has finished walking, the
		// paths that arrive are the ones the user is working on: a note just
		// created, a file dropped in. Refusing those is how a capped vault
		// stopped showing new notes in its explorer at all (the owner's
		// ph226-426, 2026-09-25 — the note was on disk and nowhere on screen).
		// So after 'ready' the gate opens again, up to a ceiling that still
		// keeps the process clear of the ~10,240 where fork() dies.
		let settled = false;
		// This window's SHARE of the scan budget (fs-utils.js#scanShare): what
		// is left, less what later windows' scans are owed — first-come used
		// to take everything, and a second window's vault went unwatched.
		const share = scanShare(WATCH_BUDGET - watchedTotal);
		let scanned = 0;
		const take = () => {
			if (!settled && scanned >= share) return false;
			if (watchedTotal >= (settled ? WATCH_CEILING : WATCH_BUDGET)) return false;
			watchedTotal += 1;
			if (!settled) scanned += 1;
			return true;
		};
		// WHAT the budget buys, decided before chokidar walks: notes first,
		// then the documents Clew edits, then everything else breadth-first
		// (fs-utils.js#watchOrder). Without this the order is chokidar's, and
		// a vendored library that sorts early takes the lot — measured on
		// ph226-426, where six of eighty-one notes were watched and the rest
		// of the budget went to a font icon set. The tree walk above has
		// already enumerated the files; only the order was missing.
		const plan = files
			? watchPlan(files.filter((rel) => !this.excludes.isUnindexed(rel)), take)
			: null;
		const { ignored, state } = watchFilter({
			root: this.root,
			// Both lists: what is not indexed is not watched either, which is
			// the point of `unindexed` — the descriptors are the cost.
			isExcluded: (rel) => this.excludes.isUnindexed(rel),
			duplicates,
			take,
			admit: plan?.admit ?? null,
			settled: () => settled,
			// What the scan saw: after it, only NEW paths spend the headroom
			// (chokidar re-asks about every entry of a folder on each event).
			known: files ? knownPaths(files) : null,
		});
		if (plan) {
			state.skipped = plan.skipped;
			state.firstSkipped = plan.firstSkipped;
		}
		this.#watchState = state;
		this.#watchCap = null;
		this.#watcher = chokidar.watch('.', { cwd: this.root, ignored, ignoreInitial: true });
		// One line per vault when the budget bit, and a notice in the window:
		// a partly watched vault is a vault whose explorer and previews can go
		// stale, and silence about that is worse than the staleness.
		this.#watcher.once('ready', () => {
			settled = true;
			if (state.skipped === 0) return;
			console.warn(`clew: watching capped at ${state.accepted.size} paths in ${this.root}`
				+ ` (${state.skipped}+ skipped, first ${state.firstSkipped})`);
			this.#watchCap = {
				watched: state.accepted.size, skipped: state.skipped, first: state.firstSkipped,
			};
			this.send('clew:ev-watch-capped', this.#watchCap);
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
