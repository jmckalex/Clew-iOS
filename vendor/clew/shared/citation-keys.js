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
	// `add` (the default since jmarkdown 909af7a: the note's files ADD to the
	// configured one) or `replace` (the note's alone, as before).
	['bibliography mode', 'Bibliography mode'],
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
 * written. A value may run over several lines, as the engine reads a header
 * (metadata-header.js#parseKeyedData): a non-blank line that is not itself
 * `key: value` continues the key before it — how a YAML list
 * (`Bibliography:` then `  - a.bib`) is written. Continuation lines join the
 * value with a newline.
 *
 * @param {string} noteText
 * @returns {{ key: string, name: string, value: string }[]} key normalised, name canonical
 */
export function citationLines(noteText) {
	const header = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(noteText);
	if (!header) return [];
	const out = [];
	let current = null;   // the record the key line before this one made, or null
	for (const line of header[1].split(/\r?\n/)) {
		// The engine's key line: letters, digits, spaces and hyphens, a colon.
		const kv = /^([-a-zA-Z0-9 _]+):\s*(.*)$/.exec(line);
		if (kv) {
			const key = kv[1].trim().toLowerCase().replace(/[\s_-]+/g, ' ');
			const name = CITATION_KEYS.get(key);
			current = name ? { key, name, value: kv[2].trim() } : null;
			if (current) out.push(current);
		} else if (current && line.trim()) {
			current.value = current.value ? `${current.value}\n${line.trim()}` : line.trim();
		}
	}
	return out;
}
