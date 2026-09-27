// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Lazy MathJax for the APP window (canvas cards render engine HTML with raw
// $…$ / \(…\) math; note previews have their own MathJax via the template).
// Loaded once, on the first card that needs it, from the bundled assets the
// preview protocol already serves. tex-svg output: no webfonts to load.
//
// Live edit typesets single formulas through `typesetTex`: synchronous once
// MathJax is in, cached (an LRU of rendered elements, cloned into each
// widget — CodeMirror recreates widget DOM freely), and with a LOCAL font
// cache so every SVG is self-contained (a page-global glyph cache would
// leave a recycled widget pointing at glyph defs that went with another).
// MathJax keeps `\newcommand` state per page, so a macro one note defines
// is visible to formulas typeset later in another — reading mode is the
// truth for macros (the manual says so).

let loading = null;

function load() {
	loading ??= new Promise((resolve, reject) => {
		// Config must exist before the script evaluates. Mirrors the engine's
		// default MathJax configuration (config-manager.js).
		window.MathJax = {
			tex: {
				inlineMath: [['$', '$'], ['\\(', '\\)']],
				displayMath: [['$$', '$$'], ['\\[', '\\]']],
				tags: 'ams',
			},
			svg: { fontCache: 'local' },
			startup: { typeset: false },
		};
		const script = document.createElement('script');
		script.src = 'clew-preview://vault/__clew_assets__/mathjax/tex-svg.js';
		script.onload = () => resolve();
		script.onerror = () => reject(new Error('MathJax failed to load'));
		document.head.append(script);
	});
	return loading;
}

/** Typeset math inside `el` (no-op if the element holds no math). */
export async function typesetMath(el) {
	if (!/\$|\\\(|\\\[/.test(el.textContent ?? '')) return;
	await load();
	await window.MathJax.startup.promise;
	await window.MathJax.typesetPromise([el]);
}

/** Resolves once MathJax is loaded and started. */
export async function mathReady() {
	await load();
	await window.MathJax.startup.promise;
}

/** True once `mathReady()` has resolved (typesetTex may be called). */
export function mathLoaded() {
	return Boolean(window.MathJax?.tex2svg && window.MathJax.startup?.document);
}

const MATH_CACHE_LIMIT = 2000;
const mathCache = new Map(); // `${display}\u0000${tex}` → rendered element

/**
 * A rendered formula, cached (null before MathJax is loaded). The caller
 * gets its own clone. A TeX error comes back as MathJax's error container,
 * carrying `data-mjx-error` with the message.
 *
 * @param {string} tex - the formula, delimiters stripped
 * @param {{ display?: boolean }} [options]
 * @returns {HTMLElement|null}
 */
let stylesheetInstalled = false;

export function typesetTex(tex, { display = false } = {}) {
	if (!mathLoaded()) return null;
	// tex2svg does not install MathJax's own CSS (typesetPromise does, on
	// first use): without it the visually-hidden assistive MathML beside
	// each SVG shows, and every formula reads twice (measured).
	if (!stylesheetInstalled) {
		stylesheetInstalled = true;
		try { document.head.append(window.MathJax.svgStylesheet()); } catch { /* older API */ }
	}
	const key = `${display}\u0000${tex}`;
	let el = mathCache.get(key);
	if (el) {
		mathCache.delete(key); // LRU: re-insert as newest
	} else {
		try {
			el = window.MathJax.tex2svg(tex, { display });
		} catch (err) {
			el = document.createElement('span');
			el.setAttribute('data-mjx-error', String(err?.message ?? err));
			el.textContent = tex;
		}
		const error = el.querySelector?.('[data-mjx-error]');
		if (error && !el.hasAttribute('data-mjx-error')) el.setAttribute('data-mjx-error', error.getAttribute('data-mjx-error'));
		if (mathCache.size >= MATH_CACHE_LIMIT) mathCache.delete(mathCache.keys().next().value);
	}
	mathCache.set(key, el);
	return el.cloneNode(true);
}

/** Forget every macro and equation number (before a note's display math). */
export function resetTex() {
	try { window.MathJax?.texReset?.(); } catch { /* not loaded */ }
}
