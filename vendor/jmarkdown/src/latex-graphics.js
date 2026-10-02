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
*/

import fs from 'fs';
import path from 'path';
import { configManager } from './config-manager.js';
import { addWarning } from './warnings.js';
import { requirePackage } from './preamble.js';
import { escapeLatexText, escapeTexText } from './latex-escape.js';

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
		return `\\href{${escapeLatexPath(`run:${src}`)}}{${escapeTexText(alt || src)}}`;
	}
	requirePackage('graphicx');
	return `\\includegraphics${options()}{${escapeLatexPath(graphic)}}`;
}
