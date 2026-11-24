// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// "Export notes as PDF (reading view)" — many notes, a PDF each (the owner's
// ask, 2026-11-24: a folder of marked essays, each to go back to its writer).
// The plan and the loop, apart from Electron so they are tested under plain
// node (tests/print-batch.test.js); export.js#exportNotesPrint gives them the
// folder dialog, the printer (print-pdf.js, the single note's own) and the
// Trash.

import { isExcalidrawPath } from '../shared/file-types.js';

const NOTE = /\.(md|jmd)$/i;

/** A note the batch prints: `.md` or `.jmd`, never a drawing (`.excalidraw.md`). */
export function isPrintableNote(rel) {
	return typeof rel === 'string' && NOTE.test(rel) && !isExcalidrawPath(rel);
}

/** The vault-relative folder every one of `paths` is in ('' for the root). */
export function commonFolder(paths) {
	if (!paths.length) return '';
	let parts = paths[0].split('/').slice(0, -1);
	for (const rel of paths.slice(1)) {
		const dirs = rel.split('/').slice(0, -1);
		let i = 0;
		while (i < parts.length && i < dirs.length && parts[i] === dirs[i]) i += 1;
		parts = parts.slice(0, i);
	}
	return parts.join('/');
}

/**
 * Each note's PDF, relative to the folder the PDFs go into: its path from the
 * notes' common folder, `.md`/`.jmd` made `.pdf` — so one folder's notes land
 * side by side, and its subfolders' in subfolders of the same names (two
 * notes called "Ann" in two weeks' folders stay two PDFs). A name already
 * taken is numbered, "Ann 2.pdf", "Ann 3.pdf" …: by another note of the batch
 * (`a.md` and `a.jmd`; `Ann.md` and `ann.md`, which a Mac's disk takes for
 * one name), or, given `taken`, by a file already there — the dialog's Keep
 * Both. Without it a file there is replaced (the runner's business).
 *
 * @param {string[]} paths - vault-relative notes, in the order to print them
 * @param {{ taken?: (name: string) => boolean }} [opts]
 * @returns {{ path: string, name: string }[]}
 */
export function batchPdfNames(paths, { taken = () => false } = {}) {
	const base = commonFolder(paths);
	const used = new Set();
	return paths.map((rel) => {
		const stem = (base ? rel.slice(base.length + 1) : rel).replace(NOTE, '');
		let name = `${stem}.pdf`;
		for (let n = 2; used.has(name.toLowerCase()) || taken(name); n += 1) name = `${stem} ${n}.pdf`;
		used.add(name.toLowerCase());
		return { path: rel, name };
	});
}

/**
 * Print the plan one note at a time — never two at once: each is a hidden
 * window running MathJax, mermaid and the wasm TeX. A note that fails is that
 * note's alone: said, and passed over. `stopped()` is asked before each; what
 * was not begun comes back as `stopped`. `progress` hears `{ done, total,
 * path }` before each note, and `{ done: total, total, path: null }` at the
 * end.
 *
 * @param {{ plan: { path: string, name: string }[],
 *   print: (item: { path: string, name: string }, index: number) => Promise<void>,
 *   progress?: (p: { done: number, total: number, path: string|null }) => void,
 *   stopped?: () => boolean }} job
 * @returns {Promise<{ written: string[], failed: { path: string, error: string }[], stopped: string[] }>}
 */
export async function runPrintBatch({ plan, print, progress = () => {}, stopped = () => false }) {
	const written = [];
	const failed = [];
	for (const [i, item] of plan.entries()) {
		if (stopped()) return { written, failed, stopped: plan.slice(i).map((p) => p.path) };
		progress({ done: i, total: plan.length, path: item.path });
		try {
			await print(item, i);
			written.push(item.name);
		} catch (err) {
			failed.push({ path: item.path, error: String(err?.message ?? err) });
		}
	}
	progress({ done: plan.length, total: plan.length, path: null });
	return { written, failed, stopped: [] };
}
