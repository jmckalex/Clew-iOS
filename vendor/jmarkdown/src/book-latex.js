/*
	A book's LaTeX a file per chapter (`LaTeX layout: include`, processFile's
	`latexLayout: 'include'`, the CLI's --latex-layout include): the master
	`<output>.tex` — preamble, the master's own text, back matter — with
	`\include{<name>-ch-N}` where each chapter stood, and the chapter's own
	LaTeX in `<name>-ch-N.tex` beside it. LaTeX resolves numbers, references
	and citations across \include'd files through their .aux files, so a full
	run gives the book a single `.tex` gives.

	`includeOnly` (processFile; the CLI's repeatable --include-only) adds
	`\includeonly{…}` for a quick proof of some chapters: LaTeX typesets only
	those, and keeps the others' numbers and pages from their .aux files of the
	last full run. A chapter is named by its path as handed in (`chapters`,
	@chapter+), its file name, or its number.

	The default layout, `single`, is one .tex as always: the brackets this cuts
	at (book.js includeStart / includeEnd) are written only in this layout.
*/

import fs from 'fs';
import path from 'path';
import { addWarning } from './warnings.js';
import { getBook } from './book.js';

const BRACKETED = /%% jmd:include-start (\d+)\n([\s\S]*?)%% jmd:include-end \1\n/g;

/** The LaTeX with the chapter brackets taken out, for a build that writes one file after all. */
export function unbracket(latex) {
	return latex.replace(/%% jmd:include-(?:start|end) \d+\n/g, '');
}

// A chapter file's name: the output's, with what \include cannot take (spaces
// and the like) made hyphens, and the chapter's number.
function chapterName(outFile, n) {
	const base = path.basename(outFile).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '-');
	return `${base}-ch-${n}`;
}

// The chapters `includeOnly` names, as their numbers. Unknown names are warned.
function chosenChapters(includeOnly) {
	const book = getBook();
	const wanted = [includeOnly ?? []].flat().map((x) => String(x).trim()).filter(Boolean);
	const chosen = [];
	for (const w of wanted) {
		const bare = (p) => p.replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase();
		const c = book.chapters.find((ch) => String(ch.index) === w || ch.name === w
			|| bare(ch.name) === bare(w) || bare(path.basename(ch.name)) === bare(w));
		if (c) chosen.push(c.index);
		else addWarning(`book: --include-only names "${w}", which is no chapter of this book — left out of \\includeonly`);
	}
	return chosen;
}

/**
 * Write the master and its chapter files; returns the chapter files' paths.
 * `latex` is the whole document, its chapters bracketed (book.js).
 */
export function writeLatexInclude(latex, outFile, includeOnly) {
	const dir = path.dirname(outFile);
	const written = [];
	let master = latex.replace(BRACKETED, (whole, n, body) => {
		const name = chapterName(outFile, n);
		const file = path.join(dir, `${name}.tex`);
		fs.writeFileSync(file, `% Chapter ${n} of ${path.basename(outFile)}, \\include'd by it (written by jmarkdown).\n${body}`);
		written.push(file);
		return `\\include{${name}}\n`;
	});
	if (includeOnly && [includeOnly].flat().length) {
		const names = chosenChapters(includeOnly).map((n) => chapterName(outFile, n));
		if (names.length) {
			master = master.replace('\\begin{document}', `\\includeonly{${names.join(',')}}\n\\begin{document}`);
		}
	}
	fs.writeFileSync(outFile, master);
	return written;
}
