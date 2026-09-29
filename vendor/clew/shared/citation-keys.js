// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later


// The engine's citation keys in a note's header — `Bibliography`,
// `Resolve citations`, `Bibliography style` and the rest (config-manager.js
// in the engine). Shared: main/citation-header.js carries them into the
// blocks rendered on the note's behalf, and live edit's frame layer
// re-renders its frames when they change (a block renders under them).

/** The engine's citation keys, by normalised name. */
export const CITATION_KEYS = new Map([
	['bibliography', 'Bibliography'],
	['bibliography style', 'Bibliography style'],
	['resolve citations', 'Resolve citations'],
	['citation tooltips', 'Citation tooltips'],
	['minimal bibliography', 'Minimal bibliography'],
	['biblify defer', 'Biblify defer'],
	['latex bib style', 'LaTeX bib style'],
	['pandoc citations', 'Pandoc citations'],
]);

/**
 * The citation keys in a note's `---`-fenced header (at the very top), as
 * written.
 *
 * @param {string} noteText
 * @returns {{ key: string, name: string, value: string }[]} key normalised, name canonical
 */
export function citationLines(noteText) {
	const header = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(noteText);
	if (!header) return [];
	const out = [];
	for (const line of header[1].split(/\r?\n/)) {
		const kv = /^([A-Za-z][A-Za-z _-]*?)\s*:\s*(.*)$/.exec(line);
		if (!kv) continue;
		const key = kv[1].trim().toLowerCase().replace(/[\s_-]+/g, ' ');
		const name = CITATION_KEYS.get(key);
		if (name) out.push({ key, name, value: kv[2].trim() });
	}
	return out;
}
