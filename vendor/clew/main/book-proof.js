// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// "Proof this chapter" (docs/dev/book-mode.md, phase 3; jmarkdown cf5ed60):
// a book's PDF is built in LaTeX's include layout — the master `<name>.tex`
// \include's a `<name>-ch-N.tex` per chapter — so that a PROOF of one chapter
// can be typeset alone with \includeonly, LaTeX taking every other chapter's
// numbers and pages from the .aux files of the LAST FULL RUN. Which full run
// that was is recorded beside it (FULL_RUN), so a proof can say plainly when
// there is none yet, or when the chapters have changed since.
//
// Electron-free and pure but for reading files, so the rules are unit-tested
// (tests/book-proof.test.js); export-book.js runs the builds.
import fs from 'node:fs';
import path from 'node:path';

/** The record of a book's last full PDF, hidden in build/ beside it. */
export function fullRunFile(outDir, base) {
	return path.join(outDir, `.${base}-full-run.json`);
}

/**
 * A chapter's file name in the include layout, as the engine names it
 * (jmarkdown book-latex.js chapterName — never imported: it loads the
 * engine's config manager; a test holds the two equal): the output's base,
 * with what \include cannot take made hyphens, and the chapter's number.
 */
export function chapterIncludeName(outFile, n) {
	const base = path.basename(outFile).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '-');
	return `${base}-ch-${n}`;
}

/** The record a full run leaves: the chapters it typeset, in order, and when. */
export function fullRunRecord(names, at = new Date()) {
	return { chapters: names, at: at.toISOString() };
}

function readRecord(file) {
	try {
		const record = JSON.parse(fs.readFileSync(file, 'utf8'));
		return Array.isArray(record?.chapters) ? record : null;
	} catch {
		return null;
	}
}

/**
 * Whether the chapter at 1-based `index` can be proofed now, and if not, why,
 * in words for the writer. `tex` is the full run's master .tex (build/<name>.tex),
 * `names` the chapters as they are now (as handed to the engine).
 * @returns {{ ok: true, record: object } | { ok: false, why: 'none'|'changed'|'aux', message: string }}
 */
export function proofReadiness({ tex, names, title, outDir, base }) {
	const record = readRecord(fullRunFile(outDir, base));
	const aux = (name) => fs.existsSync(path.join(path.dirname(tex), `${name}.aux`));
	const build = `Build ${title} as PDF once (the whole book), then proof the chapter: a proof takes every other chapter's numbers from the last full run.`;
	if (!record) {
		return { ok: false, why: 'none', message: `No full PDF of ${title} yet. ${build}` };
	}
	if (JSON.stringify(record.chapters) !== JSON.stringify(names)) {
		return { ok: false, why: 'changed', message: `The chapters of ${title} have changed since its last full PDF (${record.at.slice(0, 16).replace('T', ' ')}), so its numbers no longer fit them. ${build}` };
	}
	const base0 = path.basename(tex).replace(/\.tex$/, '');
	const missing = [base0, ...names.map((_, i) => chapterIncludeName(tex, i + 1))].filter((name) => !aux(name));
	if (missing.length) {
		return { ok: false, why: 'aux', message: `The last full PDF of ${title} left no ${missing[0]}.aux in build/ (it may have been cleared). ${build}` };
	}
	return { ok: true, record };
}

/** The .aux (and .bbl) files of a full run a proof starts from, copied into `work`. */
export function copyFullRun({ tex, names, work }) {
	const dir = path.dirname(tex);
	const base = path.basename(tex).replace(/\.tex$/, '');
	const files = [`${base}.aux`, `${base}.bbl`, ...names.map((_, i) => `${chapterIncludeName(tex, i + 1)}.aux`)];
	for (const file of files) {
		const from = path.join(dir, file);
		if (fs.existsSync(from)) fs.copyFileSync(from, path.join(work, file));
	}
}
