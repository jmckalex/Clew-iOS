// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Does a snippet's rendering depend on OTHER files? A fragment render is
// cached by the hash of its text (render-service.js), which is only right
// when the text is all it renders from. A transclusion (`![[Note]]`, and a
// canvas or a .base through the same syntax), a vault query, a Meta Bind
// widget reading a note's fields, or an `@reveal` of a vault folder all put
// something else's content in the result — so such a fragment must not be
// served from the cache once any file has changed.
//
// Deliberately over-inclusive: a false positive costs one re-render, a
// false negative shows stale content. Pure, so it is unit-tested apart from
// render-service.js (which cannot load outside Electron); shared, because
// live edit's frame layer asks the same question of a block's text.

const DEPENDENT = new RegExp([
	'!\\[\\[',                                                        // any embed
	'^[ \\t]*(?:```|~~~)[ \\t]*(?:query|tasks|kanban|dataview|dataviewjs|base|leaflet)\\b', // vault-reading fences
	'\\b(?:INPUT|VIEW)\\[',                                           // Meta Bind
	'@reveal\\b',                                                     // @reveal[…]
].join('|'), 'm');

/**
 * @param {string} text - the markdown being rendered
 * @returns {boolean} true when the render reads files other than the text
 */
export function isDependentFragment(text) {
	return DEPENDENT.test(String(text ?? ''));
}
