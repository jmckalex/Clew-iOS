// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What the vault remembers about its PDFs for quote-and-cite
// (renderer/pdf-quote.js): which bibliography entry a PDF is — when no .bib
// `file` field says so and the user chose one — and how its pages are
// printed (an offset found in its text, or set by hand).
//
// `.clew/pdf-citations.json`, IN THE VAULT and never in a .bib: the owner's
// .bib files are links to one shared master, so a write there would change
// every vault's bibliography (the owner's call, 2026-10-03). `.clew/` is
// vault state — never guarded, never published by a site export. Keyed by
// vault-relative path; a rename or move of the PDF, or of a folder holding
// it, moves its entry (vault.js#rename).
//
//   { "version": 1, "pdfs": { "Papers/x.pdf": {
//       "key": "skyrms:1996" | null,       // null: "Quote without a citation"
//       "offset": 266, "offsetSource": "text" | "manual",
//       "updated": "2026-10-03T…" } } }
//
// Electron-free: tests/pdf-meta.test.js holds it.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './fs-utils.js';

export const PDF_META_FILE = 'pdf-citations.json';

const fileOf = (root) => path.join(root, '.clew', PDF_META_FILE);

function load(root) {
	try {
		const data = JSON.parse(fs.readFileSync(fileOf(root), 'utf8'));
		if (data && typeof data.pdfs === 'object' && data.pdfs) return data;
	} catch { /* none yet, or unreadable: start empty */ }
	return { version: 1, pdfs: {} };
}

function save(root, data) {
	fs.mkdirSync(path.join(root, '.clew'), { recursive: true });
	// Sorted keys: the file diffs cleanly when a vault is under git.
	const pdfs = Object.fromEntries(Object.keys(data.pdfs).sort().map((k) => [k, data.pdfs[k]]));
	writeFileAtomic(fileOf(root), JSON.stringify({ version: 1, pdfs }, null, '\t') + '\n');
}

/** What is remembered about `rel`, or null. */
export function getPdfMeta(root, rel) {
	return load(root).pdfs[rel] ?? null;
}

const KEYS = new Set(['key', 'offset', 'offsetSource']);

/**
 * Remember `patch` for `rel` (only `key`, `offset`, `offsetSource`); a
 * field set to `undefined` is forgotten, an entry left empty is removed.
 * @returns the entry now, or null
 */
export function setPdfMeta(root, rel, patch, { now = new Date() } = {}) {
	const data = load(root);
	const entry = { ...(data.pdfs[rel] ?? {}) };
	for (const [k, v] of Object.entries(patch ?? {})) {
		if (!KEYS.has(k)) continue;
		if (v === undefined) delete entry[k];
		else entry[k] = v;
	}
	delete entry.updated;
	if (Object.keys(entry).length === 0) delete data.pdfs[rel];
	else data.pdfs[rel] = { ...entry, updated: now.toISOString() };
	save(root, data);
	return data.pdfs[rel] ?? null;
}

/** A PDF, or a folder holding PDFs, moved from `from` to `to`. */
export function renamePdfMeta(root, from, to) {
	if (!fs.existsSync(fileOf(root))) return false;
	const data = load(root);
	let moved = false;
	for (const rel of Object.keys(data.pdfs)) {
		const next = rel === from ? to : rel.startsWith(`${from}/`) ? to + rel.slice(from.length) : null;
		if (!next) continue;
		data.pdfs[next] = data.pdfs[rel];
		delete data.pdfs[rel];
		moved = true;
	}
	if (moved) save(root, data);
	return moved;
}
