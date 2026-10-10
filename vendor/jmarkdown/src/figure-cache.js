/*
	The files the engine makes for a document — mermaid's PDFs, MetaPost's and
	TiKZ's SVGs and PDFs, Mathematica's output — are kept in a cache folder per
	kind, `MetaPost/`, `TiKZ/`, … beside the note (a book's: beside the master),
	and an output refers to them by a relative path. This module says what that
	path is, from wherever the output is read.

	  - LaTeX (texCachePath): relative to the .tex's folder, counted from REAL
	    paths at both ends. TeX climbs `..` physically, from where the .tex
	    really is, so a lexical count missed whenever a symlink stood on either
	    side (an output under os.tmpdir(): /var/folders/… is /private/var/…). On
	    stdout there is no folder: the absolute path, with a warning.
	  - HTML (htmlCachePath): relative to the output's folder, counted from
	    real paths too. The two ends can arrive by different routes to the
	    same place — the output's folder from the working directory, which
	    Node reports by its real path (/private/var/…), a configured cache as
	    written (/var/…) — and a lexical count between them climbed to the
	    root and named every folder on the way. A split book's are the
	    master's, since book-pages.js rebases every relative URL onto each
	    page's folder from the master's; on stdout, the note's, as they always
	    were.

	With the output beside the note both give `<kind>/<file>`, as before. Written
	elsewhere, an HTML page used to point at `<kind>/<file>` beside ITSELF, where
	nothing was: its images were broken.

	Where the cache is (cacheDir): `<Cache directory>/<kind>/`, the `Cache
	directory` being the note's folder (a book's: the master's) unless the
	config or a host names another — so a host can keep what the engine makes
	out of the user's folders. A header cannot set it (config-manager.js).

	`Copy figures` (config or host only): with an output file, each cached file
	the output refers to is copied into `<output without extension>-figures/
	<kind>/` beside it — when missing or different, never deleting anything
	there — and the output refers to the copy. A kept .tex or .html then stands
	on its own, wherever the cache is and whether or not it survives. The
	folder carries a marker file, FIGURES_MARKER, so a host can tell it from a
	folder of the user's; one of that name without the marker is left alone
	(warned; the output then refers to the cache).
*/

import fs from 'fs';
import path from 'path';
import { configManager } from './config-manager.js';
import { addWarning, getWarnings } from './warnings.js';
import { getBook, bookLayout } from './book.js';

// The note's folder (a book's: the master's).
function noteDir() {
	return configManager.get('Markdown file directory') || process.cwd();
}

// A path's real location. One that does not exist (yet) keeps its missing tail
// on the real path of the part that does.
function realPath(p) {
	try { return fs.realpathSync(p); } catch { /* not there yet */ }
	const parent = path.dirname(p);
	return parent === p ? p : path.join(realPath(parent), path.basename(p));
}

const slashes = (p) => p.split(path.sep).join('/');

/**
 * The cache folder for one kind of file ('MetaPost', 'TiKZ', 'mermaid',
 * 'Video', 'Mathematica'), created if need be: under the `Cache directory`
 * when one is set (a relative one against the working directory), else
 * beside the note.
 */
export function cacheDir(kind) {
	const configured = configManager.get('Cache directory');
	const root = configured ? path.resolve(process.cwd(), String(configured)) : noteDir();
	const dir = path.join(root, kind);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export const FIGURES_MARKER = '.jmarkdown-figures';
const MARKER_TEXT = 'This folder was made by jmarkdown (`Copy figures`): copies of the figures '
	+ 'the file beside it refers to. jmarkdown adds and updates files here and never deletes any.\n';

function warnOnce(message) {
	if (!getWarnings().some((w) => w.endsWith(message))) addWarning(message);
}

// The output's figures folder, when `Copy figures` is on and there is an
// output file; created and marked if need be. null otherwise, or when a folder
// of that name is not jmarkdown's.
function figuresDir() {
	const on = configManager.get('Copy figures');
	if (!(on === true || String(on).toLowerCase() === 'true')) return null;
	const out = configManager.get('Output file');
	if (!out) return null;
	const dir = `${out.replace(/\.[^./\\]+$/, '')}-figures`;
	const marker = path.join(dir, FIGURES_MARKER);
	if (fs.existsSync(marker)) return dir;
	if (fs.existsSync(dir)) {
		warnOnce(`Copy figures: ${path.basename(dir)}/ was not made by jmarkdown (it has no ${FIGURES_MARKER}), so nothing is copied into it — the output refers to the cache instead`);
		return null;
	}
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(marker, MARKER_TEXT);
	return dir;
}

// A cached file as the output should refer to it: its copy in the figures
// folder (made or updated now) when `Copy figures` is on, else itself.
function referenced(abs) {
	const dir = figuresDir();
	if (!dir || !fs.existsSync(abs)) return abs;
	const dest = path.join(dir, path.basename(path.dirname(abs)), path.basename(abs));
	let same = false;
	try { same = fs.readFileSync(dest).equals(fs.readFileSync(abs)); } catch { /* not copied yet */ }
	if (!same) {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.copyFileSync(abs, dest);
	}
	return dest;
}

/** `target` as found from the folder of the .tex at `out`, counted from real paths. */
export function texRelative(out, target) {
	return slashes(path.relative(realPath(path.dirname(out)), realPath(target))) || '.';
}

/**
 * A cached file, by its absolute path, as the .tex prints it: relative to the
 * output's folder. On stdout the absolute path stays, with a warning.
 */
export function texCachePath(abs) {
	const out = configManager.get('Output file');
	if (!out) {
		addWarning('the LaTeX goes to stdout, so its cached diagrams are included by absolute path (which names your folders) — give an output file to make them relative');
		return abs;
	}
	return texRelative(out, referenced(abs));
}

// A relative path as a URL in an attribute: encoded as a URL (a space, a
// non-ASCII letter), with `#`, `?`, `'` and `&` escaped too, which would end
// the path or the attribute.
function urlPath(p) {
	return encodeURI(p).replace(/[#?'&]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A cached file, by its absolute path, as an HTML page refers to it (see above). */
export function htmlCachePath(abs) {
	const out = configManager.get('Output file');
	const split = getBook() && bookLayout() === 'split';
	const from = out && !split ? path.dirname(out) : noteDir();
	return urlPath(slashes(path.relative(realPath(from), realPath(out ? referenced(abs) : abs))));
}

/**
 * Compile a figure in a folder of its own. `work(run)` runs with `run`, a
 * fresh folder inside the cache folder `dir`, as its working folder, and
 * returns the names of the files it made there that the cache keeps (or
 * nothing). Those that exist are renamed into `dir` — one atomic step, on the one
 * filesystem — and then the run folder goes, with everything else in it:
 * whatever the document's own code wrote (MetaPost's `write`, TeX's
 * `\openout`), the tools' working files, and anything a failed run left
 * half-written. So a document can plant nothing in the cache, two builds
 * rendering the same figure at once never read a partial file, and a failed
 * run caches nothing.
 */
export function compileInRunDir(dir, work) {
	fs.mkdirSync(dir, { recursive: true });
	const run = fs.mkdtempSync(path.join(dir, '.run-'));
	try {
		const keep = (work(run) || []).filter((name) => fs.existsSync(path.join(run, name)));
		for (const name of keep) fs.renameSync(path.join(run, name), path.join(dir, name));
		return keep;
	} finally {
		fs.rmSync(run, { recursive: true, force: true });
	}
}
