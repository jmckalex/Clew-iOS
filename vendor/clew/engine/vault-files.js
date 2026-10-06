// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The vault's files by name, for the render worker and an export's: what a
// [[link]] or ![[embed]] names, resolved Obsidian-style — a path when it
// holds a '/', else the basename with the shortest path winning — and, in a
// vault this device has not trusted, nothing whose realpath leaves the vault
// (vault-bounds.js). Moved out of wikilinks.js unchanged so the export worker
// (export-worker.mjs) resolves an embed exactly as the preview does WITHOUT
// loading wikilinks.js's chain, whose query-fences.js sets the `vault` global
// for script blocks. No side effects on import.
import fs from 'node:fs';
import path from 'node:path';
import { withinVault } from './vault-bounds.js';

export const NOTE_EXT = /\.(md|jmd)$/i;
const IGNORED = new Set(['.obsidian', '.clew', '.git', 'node_modules', '.trash']);

let noteIndex = null; // Map<lowercased basename-no-ext, string[] of vault-relative paths>
let fileIndex = null; // Map<lowercased basename WITH ext, string[]> for non-note files

export function vaultRoot() {
	return process.env.CLEW_VAULT_ROOT || null;
}


function buildIndexes(root) {
	noteIndex = new Map();
	fileIndex = new Map();
	const add = (index, key, rel) => {
		if (!index.has(key)) index.set(key, []);
		index.get(key).push(rel);
	};
	const walk = (dir, rel) => {
		let entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (entry.name.startsWith('.') || IGNORED.has(entry.name)) continue;
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
			else if (NOTE_EXT.test(entry.name)) {
				add(noteIndex, entry.name.replace(NOTE_EXT, '').toLowerCase(), childRel);
			} else {
				add(fileIndex, entry.name.toLowerCase(), childRel);
			}
		}
	};
	walk(root, '');
}

const shortestOf = (matches) =>
	matches?.length ? [...matches].sort((a, b) => a.length - b.length || a.localeCompare(b))[0] : null;

/**
 * Resolve a wikilink target to a vault-relative path, Obsidian-style:
 * an explicit path (contains '/') resolves directly; a bare name matches by
 * basename with the shortest path winning. Returns null when unresolved.
 */
export function resolveTarget(target) {
	const rel = rawResolveTarget(target);
	return rel !== null && !outside(rel) ? rel : null;
}

/** In a vault this device has not trusted, a target whose realpath leaves
 *  the vault resolves to nothing (vault-bounds.js); an embed of one says so. */
export function outside(rel) {
	return !withinVault(path.join(vaultRoot(), rel));
}

export function rawResolveTarget(target) {
	const root = vaultRoot();
	if (!root) return null;
	if (noteIndex === null) buildIndexes(root);

	const clean = target.trim();
	if (!clean) return null;
	if (clean.includes('/')) {
		for (const candidate of [clean, `${clean}.md`, `${clean}.jmd`]) {
			if (fs.existsSync(path.join(root, candidate)) && NOTE_EXT.test(candidate)) return candidate;
		}
		return null;
	}
	return shortestOf(noteIndex.get(clean.replace(NOTE_EXT, '').toLowerCase()));
}

/** Resolve a non-note file target (attachment) to a vault-relative path. */
export function resolveFileTarget(target) {
	const rel = rawResolveFileTarget(target);
	return rel !== null && !outside(rel) ? rel : null;
}

export function rawResolveFileTarget(target) {
	const root = vaultRoot();
	if (!root) return null;
	if (fileIndex === null) buildIndexes(root);

	const clean = target.trim();
	if (!clean) return null;
	if (clean.includes('/')) {
		return fs.existsSync(path.join(root, clean)) && !NOTE_EXT.test(clean) ? clean : null;
	}
	return shortestOf(fileIndex.get(clean.toLowerCase()));
}
