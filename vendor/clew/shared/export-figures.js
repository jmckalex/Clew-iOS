// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// An export's figures folder, as every host names and explains it: the
// engine copies what an output refers to into `<output base>-figures/`,
// marked as its own (jmarkdown d134995's copyFigures), and warns when such a
// folder is the user's. The pure half of main/export-cache.js — the cache
// folders, the prune and the restricted stand-ins stay there — shared so
// Clew-iOS lays out its export and words its warnings alike. No fs, no
// process (tests/export-cache.test.js, tests/shared-export-modules.test.js).

/** The engine's mark on a figures folder it made (jmarkdown figure-cache.js
 *  FIGURES_MARKER — never imported: that module loads the engine's config
 *  manager; a test holds the two equal). */
export const FIGURES_MARKER = '.jmarkdown-figures';

/** The folder the engine copies an output's figures into: `x.tex` → `x-figures`. */
export function figuresFolder(output) {
	return `${output.replace(/\.[^./\\]+$/, '')}-figures`;
}

const FOREIGN = /Copy figures: (.+?)\/ was not made by jmarkdown/;

/**
 * The engine's warning about a figures folder that is not its own, said for
 * the reader: where the output's figures are instead, and what to do. Other
 * warnings pass unchanged.
 */
export function explainFiguresWarnings(warnings, { restricted }) {
	return warnings.map((w) => {
		const text = String(w);
		const m = FOREIGN.exec(text);
		if (!m) return w;
		const where = restricted
			? 'they were in a temporary folder this export removed, so its diagrams will not show'
			: 'it refers to Clew\'s export cache on this computer instead, which is pruned, so the file will not travel';
		return `${m[1]}/ beside the export is not one Clew or jmarkdown made, so its figures were not copied there: ${where}. Rename or move ${m[1]}/ and export again.`;
	});
}
