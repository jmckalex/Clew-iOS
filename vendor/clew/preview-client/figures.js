// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// TikZ and MetaPost figures in rendered notes: ```tikz / ```metapost fences
// and the :::TiKZ / @begin(metapost) directives, emitted by
// src/engine/figures.js as <tikz-diagram> / <metapost-diagram> elements.
//
// The typesetting is mp-tikz-wasm (MetaPost 2.11, pdfTeX, LuaTeX and dvisvgm
// compiled to WebAssembly — paths.js#mptikzAssets), which needs no TeX
// installation. Its own auto.js owns the rendering: importing it DEFINES the
// two elements as custom elements that typeset themselves on connect, caches
// every result in IndexedDB by content hash, and boots an engine only on a
// cache miss — so a note whose figures have been seen before costs nothing.
//
// That leaves this module two jobs auto.js cannot do:
//
//   1. Load it at all, and only when it is wanted. The loader is a real
//      <script> tag rather than a dynamic import, because auto.js reads its
//      own tag's data-* attributes for the asset base; a note with no figure
//      never fetches it.
//   2. Survive a morph. auto.js renders an element ONCE (it keeps a WeakSet
//      of elements it has seen), and client.js keeps custom elements across a
//      re-render rather than morphing their subtree. Both are right, and
//      together they would freeze an edited figure at its old picture: the
//      element object is the same, so nothing re-renders. The morph guard
//      below compares the engine's data-fig-key, keeps the rendered SVG when
//      the figure is unchanged, and marks it stale when it is not — and a
//      stale element is REPLACED by a fresh clone here, after the morph,
//      whose connectedCallback typesets the new source.

import { parseFigureError } from '../shared/figure-errors.js';
import { parentOrigin, postTo } from '../shared/message-guard.js';
import { namedFontFamilies } from '../engine/figure-fonts.js';

// Assets root: the preview protocol in the app, ./assets on exported sites
// (the exporter sets window.__clewAssetBase before this bundle loads).
const ASSETS = () => window.__clewAssetBase ?? '/__clew_assets__';

const FIGURE_TAGS = new Set(['TIKZ-DIAGRAM', 'METAPOST-DIAGRAM']);
const SELECTOR = 'tikz-diagram, metapost-diagram, script[type="text/tikz"], script[type="text/metapost"]';

// Elements whose figure changed under a morph (see figureMorph), swapped for
// fresh clones once the morph has finished — mutating the tree mid-walk would
// strand morphdom's sibling pointers.
const stale = new Set();

// Figures the engine marked as needing OpenType machinery — `font=note`, or
// a complete document that loads fontspec itself (engine/figures.js).
const OPENTYPE = 'tikz-diagram[data-opentype], metapost-diagram[data-opentype]';

// The loader's state: null until a figure asks for it, 'deciding' while
// the bundle check and the font fetch are in flight, then 'plain' or
// 'opentype' for the life of the page. auto.js reads its bundle list once,
// when it first runs, and it cannot be changed afterwards — which is why
// the decision is taken from the page as it stands at that moment, and a
// figure needing OpenType that arrives LATER reloads the preview
// (initFigures). Nothing may act on the decision while it is still
// 'deciding': the first version of this file reloaded on that window and
// looped.
let loaderState = null;
let reloading = false;
let stagedFeatures = null;
const RELOAD_FLAG = 'clew-figures-reloaded-for-opentype';

/**
 * What the staged build can be asked for, checked against the build itself
 * before anything is asked for — asking for a bundle that is not there fails
 * the whole engine:
 *   opentype     the `opentype` bundle (fontspec, luaotfload, fontspec's
 *                default faces); mp-tikz-wasm 0.2.1 has none.
 *   ghostscript  PostScript through Ghostscript (mp-tikz-wasm 0.4.0): the
 *                `ghostscript` bundle (dvips headers, PSTricks) in the main
 *                archive AND the AGPL module, `ghostscript/gs.mjs` +
 *                `gs.wasm` (12.5 MB), which ships as an archive of its own and
 *                may be missing. Its 774-byte SOURCE.md says it is there;
 *                gs.wasm itself is fetched only by a note whose DVI carries
 *                PostScript (the library loads it lazily).
 */
function stagedBuild() {
	const base = `${ASSETS()}/mptikz/`;
	stagedFeatures ??= fetch(`${base}bundles/index.json`)
		.then((res) => (res.ok ? res.json() : null))
		.then(async (index) => {
			const listed = (name) => !!index?.bundles?.some((b) => b.name === name);
			const module = listed('ghostscript')
				&& await fetch(`${base}ghostscript/SOURCE.md`).then((res) => res.ok).catch(() => false);
			return { opentype: listed('opentype'), ghostscript: module };
		})
		.catch(() => ({ opentype: false, ghostscript: false }));
	return stagedFeatures;
}

/**
 * The note's typeface, as the files main/note-fonts.js laid out (served at
 * /__clew_assets__/notefonts/): `{ 'NoteFont-Regular.ttf': bytes, … }`,
 * the shape mpTikzWasm.addFiles takes. Empty on a platform with no note
 * face, and on an exported site, where nothing is served there.
 */
async function noteFontFiles() {
	try {
		const index = await fetch(`${ASSETS()}/notefonts/index.json`).then((res) => (res.ok ? res.json() : null));
		const files = {};
		for (const name of Object.values(index?.faces ?? {})) {
			const bytes = await fetch(`${ASSETS()}/notefonts/${name}`).then((res) => (res.ok ? res.arrayBuffer() : null));
			if (bytes) files[name] = new Uint8Array(bytes);
		}
		return files;
	} catch { return {}; }
}

// The machine's own font families handed over so far: a figure that names
// one (`\setmainfont{Optima}`) gets its files from main/system-fonts.js.
const handedFamilies = new Set();
const FONTS_RELOAD_FLAG = 'clew-figures-reloaded-for-fonts';

/** The families the page's OpenType figures name, in source or preamble. */
function familiesOnPage() {
	const out = new Set();
	for (const el of document.querySelectorAll(OPENTYPE)) {
		for (const family of namedFontFamilies(`${el.textContent}\n${el.dataset.preamble ?? ''}`)) out.add(family);
	}
	return [...out];
}

/**
 * The files of these families on this machine (protocol.js serves only what
 * the index maps a family to), as addFiles takes them — whole collections:
 * mp-tikz-wasm finds every style of a supplied family by name. A family the
 * machine lacks hands over nothing, and its figure says so in its own place.
 */
async function systemFontFiles(families) {
	const files = {};
	for (const family of families) {
		handedFamilies.add(family);
		try {
			const name = encodeURIComponent(family);
			const list = await fetch(`${ASSETS()}/systemfonts/family/${name}.json`).then((res) => (res.ok ? res.json() : null));
			for (const [i, file] of (list?.files ?? []).entries()) {
				const bytes = await fetch(`${ASSETS()}/systemfonts/file/${name}/${i}`).then((res) => (res.ok ? res.arrayBuffer() : null));
				if (bytes) files[file] = new Uint8Array(bytes);
			}
		} catch { /* the figure reports the font it could not load */ }
	}
	return files;
}

/** An error figure in the element's own place, the way the library draws one. */
function refuse(el, message) {
	const kind = el.tagName === 'METAPOST-DIAGRAM' ? 'metapost' : 'tikz';
	const figure = document.createElement('figure');
	figure.className = `mpw-figure mpw-${kind} mpw-error`;
	const pre = document.createElement('pre');
	pre.className = 'mpw-console';
	pre.textContent = message;
	figure.append(pre);
	el.replaceChildren(figure);
}

/**
 * Figures asking for OpenType on a build without the bundle: refused BY
 * NAME, and taken out of the library's hands — a <div> keeps the classes
 * preview.css styles by but is not an element auto.js typesets, which
 * would otherwise replace this with "fontspec.sty not found".
 */
function refuseOpenType() {
	for (const el of document.querySelectorAll(OPENTYPE)) {
		if (el.querySelector('.mpw-figure')) continue;
		refuse(el, 'This figure asks for OpenType fonts (font=note, or fontspec), which the installed '
			+ 'TeX engines do not carry: mp-tikz-wasm\'s opentype bundle is not staged.');
		const holder = document.createElement('div');
		for (const attr of [...el.attributes]) holder.setAttribute(attr.name, attr.value);
		holder.replaceChildren(...el.childNodes);
		el.replaceWith(holder);
	}
}

async function ensureLoader() {
	if (loaderState) return;
	loaderState = 'deciding';
	// The OpenType decision, taken now because auto.js reads its bundle list
	// once: wanted by a figure on the page, and there to be had.
	const wanted = !!document.querySelector(OPENTYPE);
	const staged = await stagedBuild();
	const opentype = wanted && staged.opentype;
	if (wanted && !opentype) refuseOpenType();
	// The faces are fetched BEFORE the loader goes in: addFiles must be
	// called before the engine finishes starting for the first figure's run
	// to see them, and the library holds files handed over early until an
	// engine exists.
	const files = opentype ? { ...(await noteFontFiles()), ...(await systemFontFiles(familiesOnPage())) } : null;
	loaderState = opentype ? 'opentype' : 'plain';
	try { if (opentype) sessionStorage.removeItem(RELOAD_FLAG); } catch { /* storage may be off */ }
	const base = `${ASSETS()}/mptikz/`;
	const script = document.createElement('script');
	script.type = 'module';
	script.src = `${base}auto.js`;
	// auto.js reads these off its own tag. document.currentScript is null for
	// a module script, so it finds the tag by src — hence the literal
	// "auto.js" in the name above, which its own selector looks for.
	script.dataset.base = base;
	// `+` adds to the library's default bundles rather than replacing them
	// (a bare list would hard-code all ten names here and go stale).
	// Ghostscript whenever the build has it: it costs nothing until a figure's
	// PostScript (PSTricks, an EPS image, \rotatebox, a raw \special) would
	// otherwise be lost.
	const extra = [opentype && '+opentype', staged.ghostscript && '+ghostscript'].filter(Boolean);
	if (extra.length) script.dataset.bundles = extra.join(' ');
	script.onload = () => {
		if (files && Object.keys(files).length) window.mpTikzWasm?.addFiles(files);
	};
	// A build that is simply not there (a clone with no staged engines, and
	// no master to sync from — paths.js#mptikzAssets) must say so in the
	// figure's own place rather than leaving an empty element on the page.
	script.onerror = () => {
		for (const el of document.querySelectorAll('tikz-diagram, metapost-diagram')) {
			if (el.querySelector('.mpw-figure')) continue;
			refuse(el, 'No TikZ/MetaPost engine installed: this figure cannot be typeset here.');
		}
	};
	document.head.append(script);
}

/**
 * Is this element one of ours, and what should the morph do with it?
 * Returns null when the element is not a figure (the caller carries on),
 * true to morph it normally, false to keep it as it stands.
 */
export function figureMorph(fromEl, toEl) {
	if (!FIGURE_TAGS.has(fromEl.tagName) || fromEl.tagName !== toEl.tagName) return null;
	if (fromEl.dataset.figKey !== toEl.dataset?.figKey) {
		// A different figure. Let the source text morph in (the rendered SVG
		// goes with it) and re-render from the clone after the walk.
		stale.add(fromEl);
		return true;
	}
	// The same figure: keep the picture, but hand over the attributes anyway.
	// data-source-line moves whenever a line is added above the figure, and
	// scroll sync reads it.
	for (const attr of [...toEl.attributes]) {
		if (fromEl.getAttribute(attr.name) !== attr.value) fromEl.setAttribute(attr.name, attr.value);
	}
	for (const attr of [...fromEl.attributes]) {
		if (!toEl.hasAttribute(attr.name)) fromEl.removeAttribute(attr.name);
	}
	return false;
}

/** Is there a figure here that nothing has typeset yet? */
function needsEngines() {
	for (const el of document.querySelectorAll(SELECTOR)) {
		// An exported page carries its figures already rendered (main/
		// figure-bake.js), and must not fetch 74 MB of engines to admire
		// them. A <script type="text/tikz"> is never pre-rendered: the
		// library replaces the element itself.
		if (el.tagName === 'SCRIPT' || !el.querySelector('.mpw-figure')) return true;
	}
	return false;
}

// ---- errors: the first one, and the log behind a disclosure ----
// mp-tikz-wasm prints a failed figure's diagnostics and then its WHOLE log
// in one red box — dozens of lines of pdfTeX's banner over the note (the
// owner's report, 2026-10-03, where the live preview pane put it over the
// very lines to fix). What helps is the first error and where it is: that
// heads the box, TeX's own context line under it (the text up to the
// error), the log behind "Show log". And the host hears of it — the live
// preview pane marks the fence's line (shared/figure-errors.js) — as it
// hears when a figure comes out right again.

const tellHost = (msg) => {
	if (window.parent !== window) postTo(window.parent, { source: 'clew-preview', ...msg }, parentOrigin());
};

/** A failed figure's console: compacted, once, and reported. */
function compactError(figure) {
	const pre = figure.querySelector(':scope > pre.mpw-console');
	if (!pre || figure.querySelector(':scope > .mpw-error-head')) return;
	const kind = figure.classList.contains('mpw-metapost') ? 'metapost' : 'tikz';
	const err = parseFigureError(pre.textContent);
	if (!err) return;
	const head = document.createElement('div');
	head.className = 'mpw-error-head';
	const message = document.createElement('div');
	message.className = 'mpw-error-message';
	message.textContent = err.message;
	head.append(message);
	if (err.before !== null) {
		// The line as TeX read it, the error at the seam.
		const where = document.createElement('code');
		where.className = 'mpw-error-where';
		const upTo = document.createElement('span');
		upTo.textContent = err.before.replace(/^\.\.\./, '…');
		const rest = document.createElement('span');
		rest.className = 'mpw-error-rest';
		rest.textContent = err.after ?? '';
		where.append(upTo, rest);
		head.append(where);
	}
	const log = document.createElement('details');
	log.className = 'mpw-log';
	const summary = document.createElement('summary');
	summary.textContent = 'Show log';
	pre.replaceWith(log);
	log.append(summary, pre);
	figure.append(head, log);
	tellHost({ type: 'figure-error', kind, message: err.message, docLine: err.docLine, before: err.before, after: err.after, log: pre.textContent });
}

/** Every failed figure on the page not yet compacted (the library's own
 *  failures arrive as events; a refusal or a thrown error does not). */
function compactErrors() {
	for (const figure of document.querySelectorAll('.mpw-figure.mpw-error')) compactError(figure);
}

document.addEventListener('mp-tikz-wasm:rendered', (e) => {
	const figure = e.target?.closest?.('.mpw-figure') ?? e.target;
	if (e.detail?.ok) tellHost({ type: 'figure-ok', kind: e.detail.kind });
	else if (figure?.classList?.contains('mpw-error')) compactError(figure);
});

/** After load and after every morph: re-render what changed, load the engines if needed. */
export function initFigures() {
	compactErrors();
	for (const el of stale) {
		// A fresh node is the whole point: auto.js typesets an element once.
		if (el.isConnected) el.replaceWith(el.cloneNode(true));
	}
	stale.clear();
	if (needsEngines()) ensureLoader();
	// A figure naming a font family the running loader was not given (the
	// author just wrote \setmainfont{Optima}): addFiles reaches a running
	// engine, but not before the figure's first run, so — as for OpenType —
	// the preview reloads once, and the loader starts with the files.
	if (loaderState === 'opentype' && !reloading) {
		const missing = familiesOnPage().filter((family) => !handedFamilies.has(family));
		if (missing.length) {
			const key = `${location.href}#${missing.sort().join('|')}`;
			let already = false;
			try { already = sessionStorage.getItem(FONTS_RELOAD_FLAG) === key; } catch { /* storage may be off */ }
			if (!already) {
				reloading = true;
				try { sessionStorage.setItem(FONTS_RELOAD_FLAG, key); } catch { /* storage may be off */ }
				location.reload();
				return;
			}
		}
	}
	// A figure that needs OpenType, arriving after the loader went in
	// without it (the author just wrote `font=note` into a note that had
	// no such figure): the bundle list cannot be changed on a running
	// loader, so the preview reloads itself once — the host re-subscribes
	// on the client's `ready`, and every unchanged figure comes back from
	// the result cache. Refused instead when the build has no bundle, and
	// never twice for one document (the sessionStorage flag): a second
	// reload could only mean the decision came out the same way again.
	if (loaderState === 'plain' && !reloading && document.querySelector(OPENTYPE)) {
		stagedBuild().then(({ opentype: ok }) => {
			let already = false;
			try { already = sessionStorage.getItem(RELOAD_FLAG) === location.href; } catch { /* storage may be off */ }
			if (!ok || already) return refuseOpenType();
			reloading = true;
			try { sessionStorage.setItem(RELOAD_FLAG, location.href); } catch { /* storage may be off */ }
			location.reload();
		});
	}
}

/**
 * Figures still on their way, for anything that must wait for the page to
 * settle (print-pdf.js polls this the way it polls MathJax and mermaid).
 * A figure element with nothing rendered inside it yet counts too: the
 * engines may not even have loaded.
 */
export function figuresPending() {
	let pending = document.querySelectorAll('.mpw-figure.mpw-pending').length;
	for (const el of document.querySelectorAll('tikz-diagram, metapost-diagram')) {
		if (!el.querySelector('.mpw-figure')) pending += 1;
	}
	return pending;
}
