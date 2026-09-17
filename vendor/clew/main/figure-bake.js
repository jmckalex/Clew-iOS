// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Baking TikZ/MetaPost figures into exported pages.
//
// In the app a figure is typeset in the preview document, by the wasm engines
// (src/preview-client/figures.js). A static site has no such document: the
// two custom elements would sit there as unknown tags, showing their own
// TikZ source as text. So an export typesets every figure here, in Node, and
// writes the SVG into the page — which also means a published site carries no
// wasm at all, and a visitor loads a few KB of vector graphics instead of
// 74 MB of TeX.
//
// This is the one place Clew runs a rendering engine IN its own process, and
// the exception is deliberate: unlike jmarkdown (which mutates the marked
// singleton, `global` and String.prototype, and whose error paths call
// process.exit), mp-tikz-wasm is a library whose Node mode is what its own
// CLI uses. Its Emscripten glue THROWS on a fatal rather than exiting —
// measured — though it does set process.exitCode on the way, which is why
// that is saved and put back below. The alternative, a hidden preview window
// like office-thumbs.js, buys isolation Clew does not need for an engine it
// only runs during an explicit export.
//
// Like main/plugins.js and main/open-file.js, this module must stay
// importable WITHOUT electron — its scan is unit-tested under plain node —
// so the staged engine directory is passed in by the caller rather than read
// from paths.js here.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { noteFontFiles } from './note-fonts.js';

// Clew's own emission is always one of these two elements (engine/figures.js).
// A hand-written <script type="text/tikz"> in a note's raw HTML is the
// library's other accepted form; it renders in the app but is not baked.
//
// A fresh regex per scan, never one shared constant: a /g/ regex carries
// lastIndex, and String.matchAll COPIES it from the regex it is given — so a
// `test()` here would silently make the next scan start after the first
// figure and skip it. (Measured: the first figure on every page came out
// unbaked, showing its own source.)
const FIGURE_SRC = String.raw`<(tikz-diagram|metapost-diagram)\b([^>]*)>([\s\S]*?)</\1\s*>`;
const figureRe = () => new RegExp(FIGURE_SRC, 'gi');

export function hasFigures(html) {
	return new RegExp(FIGURE_SRC, 'i').test(html);
}

/**
 * Every figure element on a page, as raw regex matches — exported so the
 * lastIndex regression above stays caught by a unit test rather than by
 * somebody noticing an unbaked first figure on a published site.
 */
export function figureMatches(html) {
	return [...html.matchAll(figureRe())];
}

/** Is a staged mp-tikz-wasm build there to bake with? (paths.js#mptikzAssets) */
export function figureEngineAvailable(assetsDir) {
	return fs.existsSync(path.join(assetsDir, 'figures.js'))
		&& fs.existsSync(path.join(assetsDir, 'index.js'));
}

/** Does the staged build carry the `opentype` bundle (fontspec, luaotfload)? The pinned 0.2.1 does not. */
export function openTypeAvailable(assetsDir) {
	return fs.existsSync(path.join(assetsDir, 'bundles', 'opentype', 'manifest.json'));
}

const load = (assetsDir, name) => import(pathToFileURL(path.join(assetsDir, name)).href);

/**
 * Typeset every figure in these HTML files and write the SVG into them.
 *
 * Identical figures across pages are rendered once (the library's content
 * hash is the key), and one engine serves the whole export.
 *
 * A figure marked data-opentype (`font=note`, or a document loading
 * fontspec — engine/figures.js) needs the `opentype` bundle and the note's
 * faces (main/note-fonts.js, `noteFontsDir`), exactly as the preview gives
 * them; without the bundle such figures are refused by name rather than
 * failing on a missing fontspec.sty. And they are baked as OUTLINES,
 * whatever the note asked for: `woff2` would embed a subset of Apple's or
 * Microsoft's face in a published page, while outlines are what a PDF
 * carries — and they render the same on a visitor's machine without the
 * face installed.
 *
 * @param {string[]} files absolute paths of already-written pages
 * @param {string} assetsDir the staged mp-tikz-wasm build (paths.js#mptikzAssets)
 * @param {(p: {done: number, total: number}) => void} onProgress
 * @param {{noteFontsDir?: string|null}} [options]
 * @returns {Promise<{figures: number, rendered: number, failed: number}>}
 */
export async function bakeFigures(files, assetsDir, onProgress = () => {}, { noteFontsDir = null } = {}) {
	const { MetaPost, DEFAULT_BUNDLES } = await load(assetsDir, 'index.js');
	const { figureHash, renderFigure, parseAttributes, decodeEntities } = await load(assetsDir, 'figures.js');

	// Pass one: what is on the pages, and which of them need work.
	const pages = [];
	const requests = new Map(); // hash → request
	for (const file of files) {
		const html = fs.readFileSync(file, 'utf8');
		if (!hasFigures(html)) continue;
		pages.push(file);
		for (const match of figureMatches(html)) {
			const request = requestFrom(match, parseAttributes, decodeEntities);
			requests.set(figureHash(request), request);
		}
	}
	if (!requests.size) return { figures: 0, rendered: 0, failed: 0 };

	// The engines set process.exitCode as they wind down a run, which would
	// otherwise become the app's own exit code (and a smoke run's).
	const exitCode = process.exitCode;
	const results = new Map(); // hash → { svg, ok, diagnostics }
	let failed = 0;
	const wantsOpenType = [...requests.values()].some((r) => r.opentype);
	const opentype = wantsOpenType && openTypeAvailable(assetsDir);
	const mp = await MetaPost.create({
		logLevel: 'warn',
		...(opentype ? { bundles: [...DEFAULT_BUNDLES, 'opentype'] } : {}),
	});
	try {
		if (opentype && noteFontsDir) {
			const fonts = noteFontFiles(noteFontsDir);
			if (Object.keys(fonts).length) await mp.addFiles(fonts);
		}
		let done = 0;
		for (const [hash, request] of requests) {
			if (request.opentype && !opentype) {
				results.set(hash, { svg: '', ok: false, diagnostics: [{ severity: 'error',
					message: 'This figure asks for OpenType fonts (font=note, or fontspec), which the '
						+ 'installed TeX engines do not carry: mp-tikz-wasm\'s opentype bundle is not staged.' }] });
				failed += 1;
				onProgress({ done: ++done, total: requests.size });
				continue;
			}
			try {
				const result = await renderFigure(mp, request, hash);
				results.set(hash, result);
				if (!result.ok) failed += 1;
			} catch (err) {
				results.set(hash, { svg: '', ok: false, diagnostics: [{ severity: 'error', message: String(err.message ?? err) }] });
				failed += 1;
			}
			onProgress({ done: ++done, total: requests.size });
		}
	} finally {
		try { mp.dispose(); } catch { /* already gone */ }
		process.exitCode = exitCode;
	}

	// Pass two: the same scan again, substituting each element's CONTENT and
	// keeping its opening tag — the class and the width/scale style the
	// engine put there are what preview.css styles a figure by.
	for (const file of pages) {
		const html = fs.readFileSync(file, 'utf8');
		const baked = html.replace(figureRe(), (whole, tag, attrText, body) => {
			const request = requestFrom([whole, tag, attrText, body], parseAttributes, decodeEntities);
			const result = results.get(figureHash(request));
			if (!result) return whole;
			const open = whole.slice(0, whole.indexOf('>') + 1);
			return `${open}${figureHtml(request.kind, result)}</${tag}>`;
		});
		fs.writeFileSync(file, baked);
	}
	return { figures: requests.size, rendered: requests.size - failed, failed };
}

function requestFrom([, tag, attrText, body], parseAttributes, decodeEntities) {
	const attrs = parseAttributes(attrText);
	// Outlines for a published page (see bakeFigures).
	if (attrs.fonts === 'woff2') attrs.fonts = 'paths';
	return {
		kind: tag.toLowerCase() === 'metapost-diagram' ? 'metapost' : 'tikz',
		// As the browser reads it: an HTML parser decodes the entities, and the
		// tags trim the leading newline and trailing space (auto.js#sourceOf).
		source: decodeEntities(body).replace(/^\s*\n/, '').replace(/\s+$/, ''),
		attrs,
		opentype: /\bdata-opentype=/.test(attrText),
	};
}

/** The same shape the library builds in the browser, so one stylesheet serves both. */
function figureHtml(kind, result) {
	const classes = `mpw-figure mpw-${kind} ${result.ok ? 'mpw-ok' : 'mpw-error'}`;
	if (result.ok) return `<figure class="${classes}" role="img">${result.svg}</figure>`;
	const text = (result.diagnostics ?? [])
		.map((d) => `${d.severity}: ${d.message}${d.line ? ` (line ${d.line})` : ''}`)
		.join('\n')
		.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
	return `<figure class="${classes}" role="img"><pre class="mpw-console">${text}</pre></figure>`;
}
