// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Renderer-side mirror of the vault: identity + file tree (the full index
// mirror — backlinks, tags, graph — arrives with the M3 indexer).
import { Emitter } from '../lib/emitter.js';
import { isExcalidrawPath } from '../../shared/excalidraw-file.js';
import { NOTE_EXTENSIONS } from '../../shared/channels.js';
import { booksOf, mastersOf } from '../../shared/book.js';

class VaultStore extends Emitter {
	/** @type {{path: string, name: string} | null} */
	vault = null;
	/** @type {Array | null} nested {type,name,path,children} entries */
	tree = null;
	/** Mirror of main's index: { [relPath]: {mtimeMs, aliases, headings, links, tags} } */
	index = {};

	setVault(vault) {
		this.vault = vault;
		this.emit('vault-changed', vault);
	}

	setTree(tree) {
		this.tree = tree;
		this.emit('tree-changed', tree);
	}

	setIndex(snapshot) {
		this.index = snapshot?.notes ?? {};
		this.emit('index-changed');
	}

	patchIndex(path, entry) {
		if (entry) this.index[path] = entry;
		else delete this.index[path];
		this.emit('index-changed', path);
	}

	// ---- index-derived queries -------------------------------------------

	/** Backlinks to `path`: [{source, links:[{line, target, heading, alias, embed}]}] */
	backlinksFor(path) {
		const out = [];
		for (const [source, meta] of Object.entries(this.index)) {
			if (source === path) continue;
			const links = (meta.links ?? []).filter((l) => l.resolved === path);
			if (links.length) out.push({ source, links });
		}
		return out.sort((a, b) => a.source.localeCompare(b.source));
	}

	outgoingFor(path) {
		return this.index[path]?.links ?? [];
	}

	headingsFor(path) {
		return this.index[path]?.headings ?? [];
	}

	/** `^block-id` markers in a note: [{id, line}] — see note-metadata.js. */
	blocksFor(path) {
		return this.index[path]?.blocks ?? [];
	}

	/** Cross-reference labels in a note: [{key, kind, line, col, title, host}]
	 *  — see note-metadata.js. */
	labelsFor(path) {
		return this.index[path]?.labels ?? [];
	}

	/** The citations in a note: [{key, line, command, pandoc}] (§5.14). */
	citationsOf(path) {
		return this.index[path]?.citations ?? [];
	}

	/**
	 * Every note citing `key`, first line of each: [{path, line}], sorted by
	 * path. Pandoc forms count only under the vault's `pandocCitations`.
	 *
	 * @param {string} key
	 * @param {{ pandoc?: boolean }} [options]
	 */
	citedBy(key, { pandoc = false } = {}) {
		const out = [];
		for (const [path, meta] of Object.entries(this.index)) {
			const hit = (meta.citations ?? []).find((c) => c.key === key && (pandoc || !c.pandoc));
			if (hit) out.push({ path, line: hit.line });
		}
		return out.sort((a, b) => a.path.localeCompare(b.path));
	}

	/** Map of tag -> {count, notes:[path]} over the whole vault (nested tags kept whole). */
	tagIndex() {
		const map = new Map();
		for (const [path, meta] of Object.entries(this.index)) {
			for (const { tag } of meta.tags ?? []) {
				if (!map.has(tag)) map.set(tag, { count: 0, notes: [] });
				const entry = map.get(tag);
				entry.count++;
				entry.notes.push(path);
			}
		}
		return map;
	}

	/** Candidates for the quick switcher / [[ completion:
	 *  [{label, path, isAlias}] — basenames first, then aliases. */
	linkCandidates() {
		const out = [];
		for (const path of Object.keys(this.index)) {
			out.push({ label: path.split('/').pop().replace(/\.(md|jmd)$/i, ''), path, isAlias: false });
		}
		for (const [path, meta] of Object.entries(this.index)) {
			for (const alias of meta.aliases ?? []) {
				out.push({ label: alias, path, isAlias: true });
			}
		}
		return out;
	}

	/** Flat list of note paths (files with a note extension). */
	notePaths() {
		const out = [];
		const walk = (entries) => {
			for (const e of entries ?? []) {
				if (e.type === 'folder') walk(e.children);
				else if (isNotePath(e.path)) out.push(e.path);
			}
		};
		walk(this.tree);
		return out;
	}

	/**
	 * Resolve a wikilink name to a note path, Obsidian-style: explicit paths
	 * (containing '/') match directly (extension optional); bare names match by
	 * basename (then alias), case-insensitively, shortest path first.
	 */
	resolveNoteName(name) {
		const clean = name.trim();
		if (!clean) return null;
		const paths = Object.keys(this.index).length ? Object.keys(this.index) : this.notePaths();
		const lower = clean.toLowerCase();
		if (clean.includes('/')) {
			return paths.find((p) => {
				const pl = p.toLowerCase();
				return pl === lower || pl === `${lower}.md` || pl === `${lower}.jmd`;
			}) ?? null;
		}
		const shortest = (list) => list.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
		const byName = paths.filter((p) => {
			const base = p.split('/').pop().replace(/\.(md|jmd)$/i, '');
			return base.toLowerCase() === lower;
		});
		if (byName.length) return shortest(byName);
		const byAlias = Object.entries(this.index)
			.filter(([, meta]) => (meta.aliases ?? []).some((a) => a.toLowerCase() === lower))
			.map(([p]) => p);
		if (byAlias.length) return shortest(byAlias);
		return null;
	}

	/** All file paths (notes and attachments alike). */
	allPaths() {
		const out = [];
		const walk = (entries) => {
			for (const e of entries ?? []) {
				if (e.type === 'folder') walk(e.children);
				else out.push(e.path);
			}
		};
		walk(this.tree);
		return out;
	}

	/** Resolve a non-note file reference (attachment) by basename or path. */
	resolveFileName(name) {
		const clean = name.trim().toLowerCase();
		if (!clean) return null;
		const paths = this.allPaths().filter((p) => !isNotePath(p));
		if (clean.includes('/')) {
			return paths.find((p) => p.toLowerCase() === clean) ?? null;
		}
		const matches = paths.filter((p) => p.split('/').pop().toLowerCase() === clean);
		if (matches.length === 0) return null;
		return matches.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
	}

	/** Book mode (shared/book.js): every book this note is a chapter of. */
	booksOf(path) {
		return booksOf(this.index, path);
	}

	/** Every book master in the vault, by path. */
	masters() {
		return mastersOf(this.index);
	}

	pathExists(path) {
		let found = false;
		const walk = (entries) => {
			for (const e of entries ?? []) {
				if (e.path === path) { found = true; return; }
				if (e.type === 'folder' && path.startsWith(e.path + '/')) walk(e.children);
			}
		};
		walk(this.tree);
		return found;
	}
}

export function isNotePath(path) {
	// An Excalidraw drawing is stored as `.excalidraw.md` — a markdown file by
	// extension, but a drawing to every user who has one. It routes to the
	// drawing editor, not the note editor.
	if (isExcalidrawPath(path)) return false;
	return NOTE_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext));
}

export const vaultStore = new VaultStore();
