/*
	Getting an author's image into LaTeX — shared by every route one takes: a
	markdown image `![alt](src)` (latex-renderer.js), `@image`, and `@video`'s
	poster frame (media.js).

	\includegraphics can read neither a URL nor an SVG, and either one handed
	to it gives a document that does not compile ("Unknown graphics
	extension"). So:
	  - a REMOTE image becomes a link to it, \href{url}{alt};
	  - an SVG uses a .pdf or .png beside it, silently, if there is one —
	    authors keeping vector art in SVG usually have a PDF too — and
	    otherwise becomes a link to the file itself, \href{run:path}{alt},
	    which opens it in the reader's own viewer (as @video's link mode
	    does);
	each with a build warning. Graphics the engine makes itself (TikZ,
	MetaPost, Mermaid) are PDFs and never come here.

	Where a relative path is printed from (texPath): LaTeX looks for it where
	LaTeX runs, beside the .tex. A single file writes its paths as given, as it
	always has. A BOOK's paths are the master's (book.js rebases each
	chapter's onto it), and its .tex may be written elsewhere — a host builds
	into build/ — so they are rebased onto the .tex's own folder, as a split
	book's pages are onto theirs (book-pages.js). kpathsea never searches
	TEXINPUTS for a `./` or `../` name, so nothing else would find them.

	A file the ENGINE made — a cached diagram PDF (mermaid.js, metapost.js),
	known by its absolute path — is printed relative to the .tex's folder too,
	in a single file as in a book (texCachePath): as an absolute path it put the
	user's folders into the .tex, and under pdfLaTeX into the PDF as well
	(/PTEX.FileName).
*/

import fs from 'fs';
import path from 'path';
import { configManager } from './config-manager.js';
import { addWarning } from './warnings.js';
import { requirePackage } from './preamble.js';
import { escapeLatexText, escapeTexText } from './latex-escape.js';
import { getBook } from './book.js';

// \href and \includegraphics take their argument almost verbatim, but a `%` or
// `#` in a path still has to be escaped for TeX.
export function escapeLatexPath(s) {
	return String(s).replace(/([%#])/g, '\\$1');
}

/** The directory relative image paths resolve against. */
export function markdownDir() {
	return configManager.get('Markdown file directory') || process.cwd();
}

export function isRemote(src) {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(src) || src.startsWith('//');
}

// A path as found from the folder of the .tex at `out`. Both ends are REAL
// paths: TeX climbs `..` physically, from where the .tex really is, so a
// relative path worked out lexically missed whenever a symlink stood on
// either side — an output under os.tmpdir() (/var/folders/… is really
// /private/var/…), or a vault reached through a link — and LaTeX could not
// find the file. A path that does not exist (yet) keeps its missing tail on
// the real path of the part that does.
function realPath(p) {
	try { return fs.realpathSync(p); } catch { /* not there yet */ }
	const parent = path.dirname(p);
	return parent === p ? p : path.join(realPath(parent), path.basename(p));
}

function fromTexFolder(out, target) {
	const rel = path.relative(realPath(path.dirname(out)), realPath(target));
	return rel.split(path.sep).join('/') || '.';
}

/**
 * A local path as the .tex prints it (see above): in a book with an output
 * file, a relative path (relative to the master, markdownDir()) made relative
 * to the output's folder; anything else as given. A book on stdout has no
 * folder to rebase onto, so it keeps the master's, and says so.
 */
export function texPath(src) {
	if (!getBook() || !src || path.isAbsolute(src) || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return src;
	const out = configManager.get('Output file');
	if (!out) {
		addWarning('book: the LaTeX goes to stdout, so its image and media paths are relative to the master\'s folder — compile it there, or give an output file');
		return src;
	}
	return fromTexFolder(out, path.resolve(markdownDir(), src));
}

/**
 * A file the engine made, by its absolute path, as the .tex prints it (see
 * above): relative to the output's folder. On stdout there is no folder, so
 * the absolute path stays, with a warning.
 */
export function texCachePath(abs) {
	const out = configManager.get('Output file');
	if (!out) {
		addWarning('the LaTeX goes to stdout, so its cached diagrams are included by absolute path (which names your folders) — give an output file to make them relative');
		return abs;
	}
	return fromTexFolder(out, abs);
}

/**
 * What \includegraphics should be given for `src`: `src` itself, or for an
 * SVG a .pdf/.png beside it — or null for an SVG with neither, which LaTeX
 * cannot include at all.
 */
export function resolveGraphic(src) {
	if (!/\.svg$/i.test(src)) return src;
	const dir = markdownDir();
	for (const ext of ['.pdf', '.png']) {
		const sibling = src.replace(/\.svg$/i, ext);
		if (fs.existsSync(path.resolve(dir, sibling))) return sibling;
	}
	return null;
}

/**
 * An image as LaTeX: `\includegraphics<options>{src}`, or a link for what
 * LaTeX cannot include (see above). `options` is a FUNCTION returning the
 * option string (e.g. `[width=0.5\linewidth]`), called only when the image is
 * included — building it may warn about the image's dimensions, which are
 * moot for a link. `what` names the construct in warnings ('@image', 'image').
 */
export function latexGraphic({ src, alt, options = () => '', what }) {
	if (isRemote(src)) {
		// A remote image can't be pulled into a PDF at build time; give the
		// print reader the link instead of dropping it silently.
		requirePackage('hyperref');
		addWarning(`${what}: ${src} is remote — LaTeX output links to it rather than including it`);
		return `\\href{${escapeLatexPath(src)}}{${escapeLatexText(alt || src)}}`;
	}
	const graphic = resolveGraphic(src);
	if (graphic === null) {
		// The link text is plain text, so it is escaped in full (a path's `_`
		// would otherwise break it).
		requirePackage('hyperref');
		addWarning(`${what}: ${src} is an SVG, which \\includegraphics cannot read — LaTeX output links to it instead; put a .pdf or .png beside it to include it`);
		return `\\href{${escapeLatexPath(`run:${texPath(src)}`)}}{${escapeTexText(alt || src)}}`;
	}
	requirePackage('graphicx');
	return `\\includegraphics${options()}{${escapeLatexPath(texPath(graphic))}}`;
}
