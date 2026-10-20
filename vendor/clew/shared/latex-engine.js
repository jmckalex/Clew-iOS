// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Which TeX engine compiles a "PDF via LaTeX" export (export.js). Until
// 2026-10-02 it was always pdfLaTeX (`latexmk -pdf`), and a preamble that
// loads fontspec — the owner's global ~/.jmarkdown config sets Optima that
// way — failed EVERY such export: "fontspec requires either XeTeX or
// LuaTeX" (found by Clew-docs). So the engine is read off the generated .tex
// ITSELF: it already holds every preamble that went into it (the global and
// vault configs, the note's header, the engine's own requirePackage lines),
// which no config file alone can say. A Unicode-only package or command →
// LuaLaTeX (XeLaTeX for the XeTeX-only ones); otherwise pdfLaTeX, as before.
// The `latexEngine` setting overrides it for what reading the source cannot
// see. Pure and host-neutral — Clew-iOS imports it too; latexmk's command and
// the restricted vault's refusal stay main/latex-engine.js's
// (tests/latex-engine.test.js).
import { latexEngineSettingPath } from './latex-engine-setting.js';

export const LATEX_ENGINES = ['pdflatex', 'lualatex', 'xelatex'];
const NAMES = { pdflatex: 'pdfLaTeX', lualatex: 'LuaLaTeX', xelatex: 'XeLaTeX' };
export const engineName = (engine) => NAMES[engine] ?? engine;

// What pdfLaTeX cannot run. XeTeX-only first (they decide XeLaTeX); then what
// either Unicode engine runs, which takes LuaLaTeX.
const XETEX_ONLY = [
	[/\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:xeCJK|xltxtra|xunicode|xetexko|xepersian|bidi)\b[^}]*\}/, (m) => m],
	[/\\XeTeXinterchartokenstate|\\XeTeXlinebreaklocale/, (m) => m],
];
const UNICODE = [
	[/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\b(?:fontspec|unicode-math|polyglossia|luacode|luatexja|luaotfload|lua-ul|luacolor|emoji|babel-[a-z]+-lua)\b[^}]*\}/, (m) => m],
	[/\\(?:setmainfont|setsansfont|setmonofont|setmathfont|newfontfamily|newfontface|babelfont|directlua|luaexec|luadirect)\b/, (m) => m],
];

/** The source with every comment removed (a `%` not escaped as `\%`). */
function uncommented(tex) {
	return String(tex).split('\n').map((line) => line.replace(/(^|[^\\])%.*$/, '$1')).join('\n');
}

/** Line number (1-based) of the first match of `re` in `tex`. */
function lineOf(tex, index) {
	return tex.slice(0, index).split('\n').length;
}

/**
 * The engine for this document — and, for a host that has not every engine
 * (`available`: Clew-iOS's TeX has pdfLaTeX and LuaLaTeX), whether it can be
 * run: one that cannot comes back `unavailable`, with the sentence that says
 * so (`refusal`), rather than another engine run into an obscure failure.
 *
 * @param {string} tex - the generated .tex
 * @param {string} [setting] - 'auto' (default) | 'pdflatex' | 'lualatex' | 'xelatex'
 * @param {{ available?: string[], host?: string }} [where] - the engines this
 *   host runs (all, by default) and its name for the refusal
 * @returns {{ engine: 'pdflatex'|'lualatex'|'xelatex', reason: string,
 *   unavailable?: true, refusal?: string }}
 */
export function chooseLatexEngine(tex, setting = 'auto', { available = LATEX_ENGINES, host = 'Clew' } = {}) {
	const chosen = chooseEngine(tex, setting);
	if (available.includes(chosen.engine)) return chosen;
	return { ...chosen, unavailable: true, refusal: `This document needs ${engineName(chosen.engine)} (${chosen.reason}), which ${host} does not have.` };
}

function chooseEngine(tex, setting) {
	if (LATEX_ENGINES.includes(setting)) return { engine: setting, reason: `set in ${latexEngineSettingPath()}: ${engineName(setting)}` };
	const source = uncommented(tex);
	for (const [rules, engine] of [[XETEX_ONLY, 'xelatex'], [UNICODE, 'lualatex']]) {
		for (const [re] of rules) {
			const m = re.exec(source);
			if (m) return { engine, reason: `the document needs a Unicode engine — line ${lineOf(source, m.index)}: ${m[0]}` };
		}
	}
	return { engine: 'pdflatex', reason: 'nothing in the document needs a Unicode engine' };
}

/** The first error in a TeX log (`! …` and the line after), or ''. */
export function firstLatexError(log) {
	const lines = String(log ?? '').split('\n');
	const at = lines.findIndex((l) => l.startsWith('!'));
	if (at === -1) return '';
	return lines.slice(at, at + 3).map((l) => l.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 300);
}

/**
 * What a failed PDF via LaTeX says, on every host: the engine, why it was
 * chosen, and the log's first error — else the run's own error, else that no
 * PDF came out.
 *
 * @param {{ engine: string, reason: string, log?: string, error?: string }} o
 */
export function pdfViaLatexFailure({ engine, reason, log = '', error = '' }) {
	const first = firstLatexError(log) || error || 'no PDF was produced';
	return `PDF via LaTeX failed — ${engineName(engine)} ran (${reason}). First error: ${first}`;
}
