// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Which blocks only the engine can draw. Live edit renders these as Tier C
// frames (an engine render in a small preview document); everything else it
// draws itself or leaves as source. One list, shared by the live model and
// the toolbar's insert popovers, so they cannot disagree about what a fence
// becomes.
//
// Every name here is one the engine (or a Clew engine extension in
// src/engine/) claims: obsidian-fences.js (mermaid, leaflet), figures.js
// (tikz, latex, tex, metapost), query-fences.js (query, tasks, kanban),
// dataview.js / dataview-js.js / bases.js, admonitions (`ad-*`), meta-bind.
// A plugin's engine surface can claim more (the Charts plugin's ```chart);
// plugins do not declare their fence names, so the caller passes them in.

/** Fence languages the engine renders into something other than code. */
export const RICH_FENCES = new Set([
	'mermaid', 'tikz', 'latex', 'tex', 'metapost', 'leaflet',
	'query', 'tasks', 'kanban', 'dataview', 'dataviewjs', 'base',
	'meta-bind', 'meta-bind-button', 'meta-bind-embed', 'meta-bind-js', 'meta-bind-js-view',
]);

/** `:::name` block directives the engine renders richly. */
export const RICH_DIRECTIVES = new Set([
	'TiKZ', 'tikz', 'mermaid', 'game', 'Mathematica', 'markdown-demo',
]);

/** `@begin(name)` environments the engine renders richly. */
export const RICH_ENVIRONMENTS = new Set([
	'TiKZ', 'tikz', 'tikzpicture', 'metapost', 'mermaid', 'reveal',
]);

/**
 * Is a fence with this info string rendered by the engine?
 *
 * @param {string} lang - The fence's language (first word of the info).
 * @param {Iterable<string>} [extra] - More names (plugin-claimed fences).
 * @returns {boolean}
 */
export function isRichFence(lang, extra = []) {
	if (!lang) return false;
	if (RICH_FENCES.has(lang) || lang.startsWith('ad-')) return true;
	for (const name of extra) if (name === lang) return true;
	return false;
}

/** An HTML block the preview must run: custom elements and embedded media. */
export const RICH_HTML = /<(?:[a-z][a-z0-9]*-[a-z0-9-]*|iframe|video|audio|svg)[\s/>]/i;
