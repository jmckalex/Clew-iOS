// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The languages a code fence can be highlighted in, for lang-markdown's
// `codeLanguages` hook (editor.js). The hook is given the fence's first
// info word (`tikz` from "```tikz libraries=calc show=code"), and the
// nested parser highlights the body with the fence's own grammar — the
// jmarkdown overlay masks fences out before it scans, so the two never
// paint the same text.
//
// TeX and MetaPost are hand-rolled stream modes (tex-mode.js,
// metapost-mode.js) rather than a dependency: the fences that matter here
// are the four the engine typesets (src/engine/figures.js), and a stream
// tokenizer is a page each. A language not listed is plain text, as
// before.
import { StreamLanguage } from '@codemirror/language';
import { texMode } from './tex-mode.js';
import { metapostMode } from './metapost-mode.js';
import { tabbingMode } from './tabbing-mode.js';

const tex = StreamLanguage.define(texMode);
const metapost = StreamLanguage.define(metapostMode);
const tabbing = StreamLanguage.define(tabbingMode);

const LANGUAGES = { tikz: tex, latex: tex, tex, metapost, tabbing };

/**
 * @param {string} info the fence's language word, as lang-markdown passes it
 * @returns {import('@codemirror/language').Language|null}
 */
export function fenceLanguage(info) {
	return LANGUAGES[String(info).toLowerCase()] ?? null;
}
