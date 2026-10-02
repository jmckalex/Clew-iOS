// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The note editor's markdown language, in one place: editor.js installs it
// (inside a Compartment, so a vault's `normalSyntax` flip can reconfigure
// open editors), and the grammar tests parse with exactly this — what the
// tests see is what the editor sees. Imports nothing DOM-bound.
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { jmdFootnotes } from './footnote-parser.js';
import { jmdMath } from './math-parser.js';
import { jmdSubSup } from './subsup-parser.js';
import { jmdFtpLinks } from './ftp-autolink.js';
import { fenceLanguage } from '../langs/fence-languages.js';

/**
 * The markdown extension for a note.
 *
 * @param {{ normalSyntax?: boolean }} [options] - The vault's
 *   `normalSyntax` setting: standard markdown emphasis, and no TeX-style
 *   sub/superscripts (the engine registers neither under it).
 * @returns {import('@codemirror/language').LanguageSupport}
 */
export function noteMarkdown({ normalSyntax = false } = {}) {
	return markdown({
		base: markdownLanguage,
		// jmarkdown has no indented code blocks or setext headings; removing
		// them also stops the metadata header masquerading as a heading.
		// jmdFootnotes takes `[^label: …]` / `[fn: …]` away from the link
		// parser, jmdMath takes every `$…$` away from ALL of them —
		// TeX is full of markdown's punctuation (footnote-parser.js,
		// math-parser.js) — and jmdSubSup gives `_x`/`^x` the engine's
		// meaning (subsup-parser.js). Order: math, sub/sup, footnotes.
		// The dialect overlay paints them. jmdFtpLinks adds the one bare
		// URL scheme the engine links and GFM's Autolink does not.
		extensions: [
			{ remove: ['IndentedCode', 'SetextHeading'] },
			jmdMath,
			...(normalSyntax ? [] : [jmdSubSup]),
			jmdFootnotes,
			jmdFtpLinks,
		],
		// ```tikz / ```latex / ```tex / ```metapost bodies are parsed
		// by their own grammars (langs/); every other fence stays text.
		codeLanguages: fenceLanguage,
	});
}
