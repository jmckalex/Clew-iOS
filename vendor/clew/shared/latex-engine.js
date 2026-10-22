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

/**
 * What a host's BUILT-IN TeX asks of mp-tikz-wasm (0.5.0 and later) for a
 * whole document — Clew-iOS's PDF via LaTeX: the bundles beyond the library's
 * DEFAULT_BUNDLES, for `MetaPost.create`, and the `date` for each `latex()`.
 * `opentype` is fontspec and luaotfload (the style is LuaLaTeX's); `latex-doc`
 * what a document for a desktop TeX Live loads — the style's microtype,
 * enumitem, titlesec, titling, babel, EB Garamond and Garamond-Math; and
 * `otf-fonts` latinmodern-math.otf (0.7 MB), which unicode-math — the style
 * loads it — sets wherever no maths font was set: a note whose header names
 * its own `LaTeX preamble` keeps the style's packages but not its
 * \setmathfont, and without the file its every PDF failed ("The font
 * "latinmodern-math" cannot be found"; Clew-boss, 2026-10-20). `now` is the
 * clock, as a desktop run has it (\today, the PDF's CreationDate) — the
 * library's default is 1 January 2025. tests/built-in-tex.test.js compiles
 * through the pinned build.
 */
export const BUILT_IN_TEX = Object.freeze({ bundles: Object.freeze(['opentype', 'otf-fonts', 'latex-doc']), date: 'now' });

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

// TeX's transcript breaks its lines at max_print_line, 79 — counted in BYTES
// of UTF-8, not characters (measured, TeX Live 2025, `Größe Bilder/…`):
// pdfTeX after exactly 79, cutting a letter's bytes in two across the break;
// LuaTeX moves a letter of k ≥ 2 bytes that would END on or past byte 79 to
// the next line (a line of 79−k to 78 bytes; mp-tikz-wasm measured it with
// \message and texio.write_nl), and breaks its C-level messages (luaotfload's)
// after 80. So the lines are joined as BYTES, then decoded: a log read as text
// first has turned pdfTeX's halves into U+FFFD. A line is a broken one when it
// is 79 or 80 bytes long, or shorter with the next line opening on a letter of
// k ≥ 2 bytes that would have reached byte 79 — never a shorter one before an
// ASCII character, which would have fitted — and never into an empty line,
// TeX's `l.N` or a `<…>` context line (mp-tikz-wasm's rule, the same).
const LOG_WIDTH = 79;
const leadBytes = (b) => (b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1);
function unwrapLog(log) {
	const bytes = log instanceof Uint8Array ? log : new TextEncoder().encode(String(log ?? ''));
	const segments = [];
	for (let start = 0; start <= bytes.length;) {
		let end = bytes.indexOf(0x0a, start);
		if (end === -1) end = bytes.length;
		segments.push(bytes.subarray(start, end > start && bytes[end - 1] === 0x0d ? end - 1 : end));
		start = end + 1;
	}
	const decoder = new TextDecoder('utf-8');
	const lines = [];
	let joined = [];
	segments.forEach((segment, i) => {
		joined.push(segment);
		const next = segments[i + 1];
		const continues = next && next.length && next[0] !== 0x3c /* < */ && !/^l\.\d+ /.test(decoder.decode(next.subarray(0, 12)))
			&& (segment.length === LOG_WIDTH || segment.length === LOG_WIDTH + 1
				|| (segment.length < LOG_WIDTH && leadBytes(next[0]) >= 2 && segment.length + leadBytes(next[0]) >= LOG_WIDTH));
		if (continues) return;
		const line = new Uint8Array(joined.reduce((n, s) => n + s.length, 0));
		joined.reduce((at, s) => { line.set(s, at); return at + s.length; }, 0);
		lines.push(decoder.decode(line));
		joined = [];
	});
	return lines;
}
// Every way a TeX run that went on says a file was not there (measured, TeX
// Live 2025 and mp-tikz-wasm 0.5.0, pdfLaTeX and LuaLaTeX): graphicx's
// `LaTeX Warning: File `x' not found on input line N.`, the driver's
// `! Package luatex.def Error: File `x' not found: using draft setting.`, and
// `! LaTeX Error: File `x' not found.` for a name it tried every extension on.
const NOT_FOUND = /File `([^']+)' not found/;

/**
 * The files TeX could not find in a run that still made its PDF — an image
 * named by a path that is not there: nonstopmode goes on, the PDF is made
 * without it, and until 2026-10-22 nothing said so (the owner's A1). Each
 * file once, in the order TeX met it, with the .tex line where it can be
 * read (`on input line N`, or the error's `l.N`).
 *
 * @param {Uint8Array | string | { message: string, line?: number }[]} source -
 *   the run's .log AS BYTES where it can be read so (latexmk's on a desktop:
 *   pdfTeX cuts a letter's bytes at a line break), else as text
 *   (mp-tikz-wasm's `result.log` on the iPad: whole under LuaLaTeX; under its
 *   pdfTeX a letter cut at a break is already lost in 0.5.0's string), or
 *   else mp-tikz-wasm's `diagnostics`, whose messages 0.5.0 cuts at TeX's line
 *   break (a long path then reads short)
 * @returns {{ file: string, line: number | null }[]}
 */
export function texMissingFiles(source) {
	const found = [];
	for (const { file, line } of texNotFoundLines(source)) {
		const seen = found.find((f) => f.file === file);
		if (!seen) found.push({ file, line });
		else if (seen.line == null) seen.line = line;
	}
	return found;
}

/** Every not-found line of `source` (texMissingFiles's), each as TeX wrote it
 *  — a file the warning and the driver's error both name comes twice. */
export function texNotFoundLines(source) {
	const out = [];
	if (Array.isArray(source)) {
		for (const d of source) {
			const m = NOT_FOUND.exec(String(d?.message ?? ''));
			if (m) out.push({ file: m[1], line: Number.isInteger(d.line) ? d.line : null, text: String(d.message) });
		}
		return out;
	}
	const lines = unwrapLog(source);
	lines.forEach((text, at) => {
		const m = NOT_FOUND.exec(text);
		if (!m) return;
		const onLine = /on input line (\d+)/.exec(text);
		const context = onLine ? null : lines.slice(at + 1, at + 12).map((l) => /^l\.(\d+) /.exec(l)).find(Boolean);
		out.push({ file: m[1], line: onLine ? Number(onLine[1]) : context ? Number(context[1]) : null, text });
	});
	return out;
}

/** What a host says, as a build warning, for each file texMissingFiles found. */
export function missingFileWarnings(missing) {
	return missing.map(({ file }) => `PDF via LaTeX: TeX could not find the file "${file}", so the PDF was made without it.`);
}
const MISSING_WARNING = /^PDF via LaTeX: TeX could not find the file "(.+)", so the PDF was made without it\.$/;
/** The file a missingFileWarnings sentence names, or null (build-warnings.js
 *  says them by name, not as "other"). */
export const missingFileOf = (warning) => MISSING_WARNING.exec(String(warning))?.[1] ?? null;

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
