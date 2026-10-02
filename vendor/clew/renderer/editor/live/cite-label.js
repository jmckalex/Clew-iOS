// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// A citation's LOCAL text: what a live-edit pill reads until the engine's
// own text is in (cite-text.js), and where the engine has none — no
// bibliography configured, an unknown key. Shaped by the command the way an
// author-year style reads it: `\citep` (and `\parencite`, `\autocite`) in
// parentheses, `\citeauthor` the names, `\citeyear` the year, anything else
// "Akerlof and Kranton 2000"; several keys joined by "; "; an unknown key
// as itself. Pure — tests/cite-label.test.js.

const PAREN = new Set(['citep', 'parencite', 'autocite']);

/**
 * @param {string} command - `cite`, `citep`, `citeauthor`, …
 * @param {string[]} keys
 * @param {Array<{label: string, authors?: string, year?: string}|null>} labels -
 *   per key, complete/citations.js#citationLabel (null: unknown)
 * @returns {string}
 */
export function localCiteText(command, keys, labels) {
	const parts = keys.map((key, i) => {
		const l = labels[i];
		if (!l) return key;
		if (command === 'citeauthor') return String(l.authors ?? '').replace(/ & /g, ' and ') || l.label;
		if (command === 'citeyear') return l.year || l.label;
		return l.label;
	}).filter(Boolean);
	const body = parts.join('; ') || '?';
	return PAREN.has(command) ? `(${body})` : body;
}
