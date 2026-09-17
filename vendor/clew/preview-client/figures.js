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

// Assets root: the preview protocol in the app, ./assets on exported sites
// (the exporter sets window.__clewAssetBase before this bundle loads).
const ASSETS = () => window.__clewAssetBase ?? '/__clew_assets__';

const FIGURE_TAGS = new Set(['TIKZ-DIAGRAM', 'METAPOST-DIAGRAM']);
const SELECTOR = 'tikz-diagram, metapost-diagram, script[type="text/tikz"], script[type="text/metapost"]';

// Elements whose figure changed under a morph (see figureMorph), swapped for
// fresh clones once the morph has finished — mutating the tree mid-walk would
// strand morphdom's sibling pointers.
const stale = new Set();

let loaderAdded = false;

function ensureLoader() {
	if (loaderAdded) return;
	loaderAdded = true;
	const base = `${ASSETS()}/mptikz/`;
	const script = document.createElement('script');
	script.type = 'module';
	script.src = `${base}auto.js`;
	// auto.js reads these off its own tag. document.currentScript is null for
	// a module script, so it finds the tag by src — hence the literal
	// "auto.js" in the name above, which its own selector looks for.
	script.dataset.base = base;
	// A build that is simply not there (a clone with no staged engines, and
	// no master to sync from — paths.js#mptikzAssets) must say so in the
	// figure's own place rather than leaving an empty element on the page.
	script.onerror = () => {
		for (const el of document.querySelectorAll('tikz-diagram, metapost-diagram')) {
			if (el.querySelector('.mpw-figure')) continue;
			const kind = el.tagName === 'METAPOST-DIAGRAM' ? 'metapost' : 'tikz';
			const figure = document.createElement('figure');
			figure.className = `mpw-figure mpw-${kind} mpw-error`;
			const pre = document.createElement('pre');
			pre.className = 'mpw-console';
			pre.textContent = 'No TikZ/MetaPost engine installed: this figure cannot be typeset here.';
			figure.append(pre);
			el.replaceChildren(figure);
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

/** After load and after every morph: re-render what changed, load the engines if needed. */
export function initFigures() {
	for (const el of stale) {
		// A fresh node is the whole point: auto.js typesets an element once.
		if (el.isConnected) el.replaceWith(el.cloneNode(true));
	}
	stale.clear();
	if (needsEngines()) ensureLoader();
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
