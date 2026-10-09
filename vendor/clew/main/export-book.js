// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Building a book (docs/dev/book-mode.md §5, phase 1): a master and its
// chapters made ONE document by the engine — processFile's `chapters`
// (jmarkdown book.js), never assembled here — as LaTeX, PDF via LaTeX, or
// HTML pages (one per chapter, cut from that one document after it is
// numbered), into a `build/` folder beside the master (D12), named by the
// master so two books in one folder never collide. LaTeX's intermediates stay in
// build/ too, so a rebuild is latexmk's quick rerun and nothing lands beside
// a chapter.
//
// Everything else is a note export's (export.js, whose helpers these are):
// the same worker, the working folder the vault's trust decides, the vault's
// bibliography and callouts, the LaTeX engine read off the .tex. The chapter
// list comes from the index (the master's resolved links); a chapter that is
// no note stops the build BY NAME. The engine names a chapter's warnings by
// the path it was handed — the chapter relative to the master — and
// placeWarnings (shared/book.js) turns them back into vault paths and lines.
import fs from 'node:fs';
import path from 'node:path';
import { readMaster, laterNotice, placeWarnings } from '../shared/book.js';
import { runWorker, compilePdf, configuredBibliographies, restrictedExportDir } from './export.js';
import { bibliographyDirs } from './citation-header.js';
import { calloutsEnv } from './callout-types.js';
import { iconTable } from './callout-files.js';
import { settings } from './settings.js';
import { paths } from './paths.js';
import { printNoteToPdf } from './print-pdf.js';

const FORMATS = { html: 'html', latex: 'tex', pdf: 'pdf', print: 'pdf' };

/**
 * Build the book whose master is `masterRel`. format: 'html' | 'latex' | 'pdf'
 * | 'print' — the reading view's PDF (phase 3): the book as ONE preview
 * document (render-service.js#renderBook, the session's own render service,
 * so the vault's trust applies as in reading view) printed by print-pdf.js,
 * each chapter from a new page, no TeX. It needs `renderService`,
 * `sessionId` and `callerToken`; the others do not.
 * @returns {Promise<{ output: string, outputRel: string|null, warnings: Array<{path, line, text}>, engine?, reason? }>}
 */
export async function exportBook({ vaults, indexer, masterRel, format, trusted = false, renderService = null, sessionId = null, callerToken = null }) {
	if (!FORMATS[format]) throw new Error(`A book is built as HTML, LaTeX or PDF, not "${format}"`);
	const masterAbs = vaults.resolve(masterRel);
	const masterText = fs.readFileSync(masterAbs, 'utf8');
	const master = readMaster(masterText);
	if (!master) throw new Error(`${masterRel} is not a book: its front matter needs \`book: true\` and \`chapters:\``);
	const chapters = indexer.notes.get(masterRel)?.book?.chapters ?? [];
	const missing = chapters.filter((c) => !c.resolved).map((c) => `[[${c.target}]]`);
	if (missing.length) {
		throw new Error(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} no note in this vault — the book was not built`);
	}
	if (!chapters.length) throw new Error('The book has no chapters yet — list them under `chapters:` in its master');

	const masterDir = path.dirname(masterAbs);
	const chapterAbs = chapters.map((c) => vaults.resolve(c.resolved));
	// Handed to the engine relative to the master, as its warnings will name them.
	const names = chapterAbs.map((abs) => path.relative(masterDir, abs).split(path.sep).join('/'));
	const base = path.basename(masterAbs).replace(/\.(md|jmd)$/i, '');
	const outDir = path.join(masterDir, 'build');
	fs.mkdirSync(outDir, { recursive: true });

	const cwd = trusted ? masterDir : restrictedExportDir();
	const vaultSettings = vaults.loadState('vault-settings.json') ?? {};
	const normalSyntax = vaultSettings.normalSyntax === true;
	const callouts = calloutsEnv(settings.get('callouts'), vaultSettings.callouts, () => iconTable(paths.faIcons));
	const vaultBibName = String(vaultSettings.bibliography ?? '').trim();
	const bibliography = vaultBibName ? [path.resolve(vaults.root, vaultBibName)] : [];
	// `numbering` is passed, never left to the master's header: the engine's
	// header key is case-sensitive (`Numbering:`; measured with 8b5a1db, a
	// lowercase `numbering: continuous` built per chapter), while Clew reads
	// it in any case — and a user's own config may set it. One policy for the
	// panel, the live numbers to come, and the built book.
	const options = { chapters: names, numbering: master.numbering, normalSyntax, bibliography };
	// The engine's Obsidian links on (export.js#runWorker): a [[link]] to a
	// chapter becomes a chapter link, others print as text, ![[image]]s resolve
	// across the vault.
	const vault = { root: vaults.root, restricted: !trusted };

	const place = (raw) => {
		const placed = placeWarnings(raw, new Map(names.map((name, i) => [name, chapters[i].resolved])), masterRel);
		const later = laterNotice(master.later);
		return later ? [{ path: masterRel, line: null, text: later }, ...placed] : placed;
	};
	const rel = (abs) => {
		const r = path.relative(vaults.root, abs);
		return r.startsWith('..') || path.isAbsolute(r) ? null : r.split(path.sep).join('/');
	};

	if (format === 'print') {
		// Named apart from the LaTeX PDF, which is `<master>.pdf` in the same folder.
		const output = path.join(outDir, `${base} (reading view).pdf`);
		const { warnings } = await renderService.renderBook(masterRel, { chapters: names, numbering: master.numbering });
		await printNoteToPdf({ sessionId, callerToken, relPath: masterRel, outFile: output, paperSize: settings.get('printPaperSize'), book: true });
		return { output, outputRel: rel(output), warnings: place(warnings) };
	}

	if (format === 'html') {
		// One page per chapter (D4, engine piece 2ac7048): asked for
		// `build/<master>.html`, the engine writes the folder `build/<master>/`
		// — index.html (the master's text and the contents), a page per
		// chapter, references.html — and says so with a warning when it has to
		// fall back to the one page instead.
		const output = path.join(outDir, `${base}.html`);
		// Clew owns build/<master>/: the previous pages go to the Trash —
		// never deleted — so a chapter removed from the book leaves no page
		// behind (vault.js#trash; a scenario's go to its own userData).
		const pagesRel = rel(path.join(outDir, base));
		if (pagesRel && fs.existsSync(path.join(outDir, base)) && fs.statSync(path.join(outDir, base)).isDirectory()) {
			await vaults.trash(pagesRel);
		}
		const started = Date.now();
		const { warnings } = await runWorker({ file: masterAbs, options: { ...options, to: 'html', output, htmlLayout: 'split' }, cwd, callouts, vault });
		const index = path.join(outDir, base, 'index.html');
		const split = fs.existsSync(index) && fs.statSync(index).mtimeMs >= started - 1000;
		const built = split ? index : output;
		return { output: built, outputRel: rel(built), pages: split, warnings: place(warnings) };
	}
	const tex = path.join(outDir, `${base}.tex`);
	const { warnings } = await runWorker({ file: masterAbs, options: { ...options, to: 'latex', output: tex }, cwd, callouts, vault });
	if (format === 'latex') return { output: tex, outputRel: rel(tex), warnings: place(warnings) };
	// BibTeX looks in every folder a bibliography names: the master's, each
	// chapter's own (it ADDS for that chapter, D3), the configured ones.
	const configured = [...configuredBibliographies(cwd), ...bibliography];
	const bibDirs = [...new Set([
		...bibliographyDirs(masterText, masterDir, configured),
		...chapterAbs.flatMap((abs) => bibliographyDirs(fs.readFileSync(abs, 'utf8'), path.dirname(abs))),
	])];
	const { pdf, engine, reason } = await compilePdf(tex, masterDir, bibDirs);
	return { output: pdf, outputRel: rel(pdf), engine, reason, warnings: place(warnings) };
}
