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
// Clew-iOS lays out its export and words its warnings alike: that one, and
// the engine's for a Mermaid diagram a LaTeX export could not draw. No fs, no
// process — the host names its platform (tests/export-cache.test.js,
// tests/shared-export-modules.test.js).

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
 * The engine's warnings about an export's figures, said for the reader: a
 * figures folder that is not its own (where the output's figures are
 * instead, and what to do), and a Mermaid diagram left out of the LaTeX for
 * want of mermaid-cli (explainMermaidWarning). Other warnings pass unchanged.
 *
 * @param {Array<string>} warnings - the build's, as the engine gives them (a
 *   book's located `<chapter>:<line>: …`)
 * @param {{ restricted: boolean, platform?: string }} o - the vault's trust;
 *   the host's platform as `process.platform` names it, `ios` for Clew-iOS
 */
export function explainFiguresWarnings(warnings, { restricted, platform = '' }) {
	return warnings.map((w) => {
		const text = String(w);
		const m = FOREIGN.exec(text);
		if (!m) return explainMermaidWarning(w, platform);
		const where = restricted
			? 'they were in a temporary folder this export removed, so its diagrams will not show'
			: 'it refers to Clew\'s export cache on this computer instead, which is pruned, so the file will not travel';
		return `${m[1]}/ beside the export is not one Clew or jmarkdown made, so its figures were not copied there: ${where}. Rename or move ${m[1]}/ and export again.`;
	});
}

// The engine's words after `mermaid: "<diagram>" left out of the LaTeX`
// (jmarkdown mermaid.js; tests/export-cache.test.js holds them to the
// vendored engine): written for its own command line, where the reader is a
// developer with npm.
const NO_MMDC = / — mermaid-cli \(mmdc\) was not found; install @mermaid-js\/mermaid-cli to render mermaid for print$/;

/**
 * The engine's warning that a Mermaid diagram was left out of a LaTeX export
 * because mermaid-cli was not found, said for the reader of this host: on the
 * iPad there is no such program to install, so that the diagram is left out
 * there; on a desktop, what the program is, how to install it and where Clew
 * looks for it — the folders render-service.js#toolchainPath puts on an
 * export's PATH (a global npm install with Homebrew's Node, or nodejs.org's,
 * lands in one), or the PATH Clew was started with (Windows: that alone). The
 * diagram's name and a book's `<chapter>:<line>: ` are kept. Any other warning
 * — `mmdc failed: …` too — is returned as it came.
 *
 * @param {string} warning
 * @param {string} platform - `process.platform`'s word, or `ios`
 * @returns {string}
 */
export function explainMermaidWarning(warning, platform) {
	const text = String(warning);
	if (!NO_MMDC.test(text)) return warning;
	const tail = platform === 'ios'
		? ' — Mermaid diagrams are left out of LaTeX exports on the iPad, which cannot run the program that draws them for print; reading view still shows them.'
		: ` — drawing a Mermaid diagram for print needs mermaid-cli, a separate program whose command is mmdc, and Clew did not find it. To install it, run \`npm install -g @mermaid-js/mermaid-cli\` in a terminal (npm comes with Node.js); Clew looks for mmdc ${platform === 'win32' ? 'on its PATH' : 'in /opt/homebrew/bin and /usr/local/bin, where that puts it, and on its PATH'}, so the next export draws the diagram.`;
	return text.replace(NO_MMDC, tail);
}
