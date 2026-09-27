// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The vault index — Clew's equivalent of Obsidian's metadata cache. Scans
// every note with the lightweight extractor (never the engine), resolves
// wikilink targets, and keeps the renderer's mirror updated incrementally.
// Persisted to .clew/cache.json (mtime-validated) for fast reopen.
import fs from 'node:fs';
import path from 'node:path';
import { extractNoteMetadata, extractDrawingMetadata } from '../shared/note-metadata.js';
import { isExcalidrawPath } from '../shared/excalidraw-file.js';
import { CH, NOTE_EXTENSIONS } from '../shared/channels.js';
import { direntKind, shouldRecurse, walkGuard, writeFileAtomic } from './fs-utils.js';
import { compileExcludes } from './vault-excludes.js';

// The ignore rules live in vault-excludes.js now — one list, consulted by
// every walk, and overridable per vault. This file used to keep a second
// copy of it, which is exactly how two walks come to disagree.
const CACHE_VERSION = 3; // 2: labels (cross-references); 3: citations

// Drawings are indexed alongside notes. A .excalidraw.md already qualified by
// extension (and was being scanned as raw markdown, so its base64 blob was
// producing junk); a plain .excalidraw did not qualify at all. Both do now, and
// both are read as scenes — see extractDrawingMetadata.
const isNote = (name) => isExcalidrawPath(name)
	|| NOTE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
const baseName = (relPath) => relPath.split('/').pop().replace(/\.(md|jmd)$/i, '');

export class Indexer {
	root = null;
	/** @type {Map<string, {mtimeMs, aliases, headings, links, tags}>} */
	notes = new Map();
	/** @type {(channel: string, payload: any) => void} */
	send = () => {};
	#nameMap = new Map(); // lowercased basename -> [relPath]
	#saveTimer = null;

	/**
	 * @param {string} root
	 * @param {{ isUnindexed(rel: string): boolean }} [excludes] the vault's own
	 *   lists (vault-excludes.js); everything is indexed without them.
	 */
	openVault(root, excludes = null) {
		this.root = root;
		this.excludes = excludes ?? compileExcludes({});
		this.notes.clear();
		const cache = this.#loadCache();
		this.#scanAll(cache);
		this.#rebuildNameMap();
		this.#resolveAll();
		this.#persistSoon();
		this.send(CH.EV_INDEX_SNAPSHOT, this.snapshot());
	}

	closeVault() {
		clearTimeout(this.#saveTimer);
		this.root = null;
		this.notes.clear();
		this.#nameMap.clear();
	}

	snapshot() {
		return { notes: Object.fromEntries(this.notes) };
	}

	// ---- scanning ---------------------------------------------------------

	#scanAll(cache) {
		const seen = walkGuard(this.root);
		const walk = (dir, rel) => {
			let entries;
			try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
			for (const entry of entries) {
				const childRel = rel ? `${rel}/${entry.name}` : entry.name;
				if (this.excludes.isUnindexed(childRel)) continue;
				const kind = direntKind(dir, entry);
				if (kind === 'dir') {
					const abs = path.join(dir, entry.name);
					if (shouldRecurse(abs, seen)) walk(abs, childRel);
				} else if (kind === 'file' && isNote(entry.name)) {
					this.#scanOne(childRel, cache?.notes?.[childRel]);
				}
			}
		};
		walk(this.root, '');
	}

	#scanOne(relPath, cached) {
		const abs = path.join(this.root, relPath);
		let stat;
		try { stat = fs.statSync(abs); } catch { return null; }
		if (cached && cached.mtimeMs === stat.mtimeMs) {
			this.notes.set(relPath, cached);
			return cached;
		}
		let text;
		try { text = fs.readFileSync(abs, 'utf8'); } catch { return null; }
		const extracted = isExcalidrawPath(relPath)
			? (extractDrawingMetadata(text, relPath) ?? extractNoteMetadata(text))
			: extractNoteMetadata(text);
		const meta = { mtimeMs: stat.mtimeMs, ...extracted };
		this.notes.set(relPath, meta);
		return meta;
	}

	// ---- resolution -------------------------------------------------------

	#rebuildNameMap() {
		this.#nameMap.clear();
		for (const relPath of this.notes.keys()) {
			const key = baseName(relPath).toLowerCase();
			if (!this.#nameMap.has(key)) this.#nameMap.set(key, []);
			this.#nameMap.get(key).push(relPath);
		}
		// Aliases resolve like names (Obsidian behavior), at lower precedence:
		// only when no real basename matches (see resolveName).
		this.#aliasMap = new Map();
		for (const [relPath, meta] of this.notes) {
			for (const alias of meta.aliases ?? []) {
				const key = alias.toLowerCase();
				if (!this.#aliasMap.has(key)) this.#aliasMap.set(key, []);
				this.#aliasMap.get(key).push(relPath);
			}
		}
	}
	#aliasMap = new Map();

	/** Obsidian-style resolution: path form direct; bare name by basename
	 *  (shortest path wins); aliases as fallback. Null when unresolved. */
	resolveName(target) {
		const clean = target.trim();
		if (!clean) return null;
		if (clean.includes('/')) {
			const lower = clean.toLowerCase();
			for (const relPath of this.notes.keys()) {
				const pl = relPath.toLowerCase();
				if (pl === lower || pl === `${lower}.md` || pl === `${lower}.jmd`) return relPath;
			}
			return null;
		}
		const shortest = (paths) =>
			[...paths].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
		const byName = this.#nameMap.get(clean.replace(/\.(md|jmd)$/i, '').toLowerCase());
		if (byName?.length) return shortest(byName);
		const byAlias = this.#aliasMap.get(clean.toLowerCase());
		if (byAlias?.length) return shortest(byAlias);
		return null;
	}

	/**
	 * Every note that embeds `relPath`, directly or down a chain of embeds.
	 * An embed is a TRANSCLUSION: the embedding note's rendered HTML contains
	 * the target's content inline, so changing C restales B (which embeds C)
	 * and A (which embeds B) alike. Ordinary links are not included — a link
	 * renders as an anchor, and an anchor does not go stale.
	 */
	embeddersOf(relPath) {
		const found = new Set();
		const queue = [relPath];
		while (queue.length) {
			const target = queue.shift();
			for (const [notePath, meta] of this.notes) {
				if (notePath === relPath || found.has(notePath)) continue;
				if (!meta.links?.some((link) => link.embed && link.resolved === target)) continue;
				found.add(notePath);
				queue.push(notePath); // whoever embeds THIS one is stale too
			}
		}
		return found;
	}

	#resolveAll() {
		for (const meta of this.notes.values()) {
			for (const link of meta.links) {
				link.resolved = link.target ? this.resolveName(link.target) : null;
			}
		}
	}

	// ---- incremental updates (wired to the vault watcher) -----------------

	onFileChanged(relPath) {
		if (!this.root || !isNote(relPath) || this.excludes.isUnindexed(relPath)) return;
		const meta = this.#scanOne(relPath);
		if (!meta) return;
		for (const link of meta.links) {
			link.resolved = link.target ? this.resolveName(link.target) : null;
		}
		this.#persistSoon();
		this.send(CH.EV_INDEX_PATCH, { path: relPath, entry: meta });
	}

	/** add/unlink/rename: name set changed → rescan the file (or drop it),
	 *  rebuild resolution everywhere (a new note can resolve old broken links). */
	onStructureChanged() {
		if (!this.root) return;
		// Re-walk the tree, reusing prior metadata wherever mtimes still match —
		// so a rename/create/delete costs one directory walk, not a re-extract
		// of the whole vault.
		const oldNotes = Object.fromEntries(this.notes);
		this.notes.clear();
		this.#scanAll({ notes: oldNotes });
		this.#rebuildNameMap();
		this.#resolveAll();
		this.#persistSoon();
		this.send(CH.EV_INDEX_SNAPSHOT, this.snapshot());
	}

	// ---- persistence ------------------------------------------------------

	#cacheFile() {
		return path.join(this.root, '.clew', 'cache.json');
	}

	#loadCache() {
		try {
			const cache = JSON.parse(fs.readFileSync(this.#cacheFile(), 'utf8'));
			return cache.version === CACHE_VERSION ? cache : null;
		} catch {
			return null;
		}
	}

	#persistSoon() {
		clearTimeout(this.#saveTimer);
		this.#saveTimer = setTimeout(() => {
			if (!this.root) return;
			try {
				writeFileAtomic(this.#cacheFile(),
					JSON.stringify({ version: CACHE_VERSION, ...this.snapshot() }));
			} catch (err) {
				console.error('Index cache save failed:', err);
			}
		}, 2000);
	}
}

export const indexer = new Indexer();
