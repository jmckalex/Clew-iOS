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

// A package's or class's error goes on over lines marked with its name —
// `(fontspec)` and the message's next words — LaTeX3's and \PackageError's.
const CONTINUED = /^! (?:Fatal )?(?:(?:Package|Class|Module) (\S+)|(LaTeX)) Error:/;

/** The first error in a TeX log (`! …` and up to two lines after it, to a
 *  blank line — a primitive error's `l.N` context), or '': its message whole
 *  over its `(name)` lines, joined without the marker. TeX writes its terminal
 *  instructions after that blank line ("Type X to quit or <RETURN> to
 *  proceed," under a missing package), so none is in it. The log's lines are
 *  TeX's lines (unwrapLog): a message past 79 bytes — a missing file's path
 *  on the iPad, a simulator container's — is read whole, never with a space
 *  where TeX broke it (Clew-iOS's catch, 2026-11-12).
 *
 *  @param {Uint8Array | string} log - the .log as bytes where it can be read
 *    so (latexmk's; mp-tikz-wasm's `texLogBytes`), else as text */
export function firstLatexError(log) {
	const lines = unwrapLog(log);
	const at = lines.findIndex((l) => l.startsWith('!'));
	if (at === -1) return '';
	const name = CONTINUED.exec(lines[at]);
	const marker = name ? `(${name[1] ?? name[2]})` : null;
	let end = at + 1;
	while (marker && end < lines.length && lines[end].startsWith(marker)) end++;
	const message = [lines[at], ...lines.slice(at + 1, end).map((l) => l.slice(marker.length))];
	const after = lines.slice(end, end + 2);
	const blank = after.findIndex((l) => !l.trim());
	return [...message, ...(blank === -1 ? after : after.slice(0, blank))].map((l) => l.trim()).filter(Boolean)
		.join(' ').replace(/\s+/g, ' ').slice(0, 300);
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
// TeX's `l.N` or a `<…>` context line (mp-tikz-wasm's rule, the same). Two
// more, for an error's lines (firstLatexError, firstLatexHelp; measured, TeX
// Live 2025, both engines): never into an error's `! ` line, and never on
// from a context's SECOND line. TeX begins each with print_nl, which starts
// no line when the one before ended at the width — a line of 79 bytes, then
// `! Undefined control sequence.` at once; and show_context holds a context's
// second line to error_line, 79, so in a long source line (a paragraph) it is
// 79 bytes ending "...", and a primitive error's help follows it at once.
//
// And a line its engine ended ITSELF, at its width, leaves an empty line when
// TeX then ends it again (2026-11-12, Clew-boss's go; measured, TeX Live 2025
// and the pinned mp-tikz-wasm, every case in both engines and XeTeX): a
// print_ln or a \MessageBreak always writes a newline, and the engine has
// already written one. So after a context's second line cut at the width,
// \errhelp's print_ln (a LaTeX error's help: LaTeX2e's "Your command was
// ignored." read as none under pdfLaTeX); after a message line of exactly 79
// bytes, its \MessageBreak (a package error's message stopped at its first
// line, a warning's "on input line N" a paragraph away); after a help line
// of 79 bytes, the next (the help stopped there). That empty line is not one
// TeX meant, and is dropped — one, never two. The width: pdfTeX's 79 bytes;
// LuaTeX's 79 for its TeX-level text, 80 for a context's lines (printed as
// its C-level lines are: an ASCII one is held to 79 and never ends itself,
// one of wider letters can reach 80); XeTeX's 79 characters. The log's first
// line names the engine; a log naming none is read as pdfTeX's.
const LOG_WIDTH = 79;
const leadBytes = (b) => (b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1);
// A context's first line: `l.N …`, or `<argument> …`, `<to be read again> …`,
// `<*> …`, `<read *> …` and the like — never an image's `<use ./x.png>`.
const CONTEXT_FIRST = /^(?:l\.\d+ |<(?:[a-z][a-z ]*|\*|read (?:\*|\d+))>(?: |$))/;
/** A TeX log's lines as TeX meant them: a line it broke at the width joined
 *  again, the empty line a line ended at the width left dropped. Bytes or
 *  text. */
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
	const head = (s) => decoder.decode(s.subarray(0, 24));
	const banner = segments.length ? head(segments[0]) : '';
	const luatex = /^This is Lua(?:HB|JIT)?TeX\b/.test(banner);
	const xetex = /^This is XeTeX\b/.test(banner);
	const contextSecond = (i) => i > 0 && CONTEXT_FIRST.test(head(segments[i - 1]));
	const endedAtWidth = (i) => {
		if (xetex) return [...decoder.decode(segments[i])].length === LOG_WIDTH;
		return segments[i].length === (luatex && contextSecond(i) ? LOG_WIDTH + 1 : LOG_WIDTH);
	};
	const lines = [];
	let joined = [];
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		joined.push(segment);
		const next = segments[i + 1];
		const continues = next && next.length && next[0] !== 0x3c /* < */ && !/^l\.\d+ /.test(head(next))
			&& !(next[0] === 0x21 && next[1] === 0x20) /* "! " */ && !contextSecond(i)
			&& (segment.length === LOG_WIDTH || segment.length === LOG_WIDTH + 1
				|| (segment.length < LOG_WIDTH && leadBytes(next[0]) >= 2 && segment.length + leadBytes(next[0]) >= LOG_WIDTH));
		if (continues) continue;
		const line = new Uint8Array(joined.reduce((n, s) => n + s.length, 0));
		joined.reduce((at, s) => { line.set(s, at); return at + s.length; }, 0);
		lines.push(decoder.decode(line));
		joined = [];
		if (next && !next.length && i + 2 < segments.length && endedAtWidth(i)) i++;
	}
	return lines;
}
// Every way a TeX run that went on says a file was not there (measured, TeX
// Live 2025 and mp-tikz-wasm 0.5.0 and 0.5.1, pdfLaTeX and LuaLaTeX): graphicx's
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
 *   the run's .log AS BYTES where it can be read so (latexmk's on a desktop,
 *   mp-tikz-wasm's `result.texLogBytes` from 0.5.1: pdfTeX cuts a letter's
 *   bytes at a line break), else as text (mp-tikz-wasm's `result.log`: whole
 *   under LuaLaTeX; under its pdfTeX a letter cut at a break is already lost
 *   in the string), or else mp-tikz-wasm's `diagnostics` (whole from 0.5.1;
 *   0.5.0 cut their messages at TeX's line break, and a long path read short)
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

// What TeX says to a person at a terminal, not to a reader of a failure — how
// to answer it there, which in nonstop mode no one does: dropped from the help,
// line by line, each a whole sentence (LaTeX writes "You're in trouble here.
// Try typing  <return>  to proceed." on one line, and the first sentence
// stays). TeX's explanatory sentences stay as written ("type `I' and the
// correct spelling" among them). Only what a real log or the pinned
// mp-tikz-wasm's diagnostics put where the help is read (2026-11-06): the
// rest of TeX's terminal lines — "Type  H <return>  for immediate help.",
// "Type X to quit or <RETURN> to proceed," and the like — stand before an
// error's context or between two errors, where no help is read.
const TERMINAL_INSTRUCTIONS = new RegExp([
	String.raw`Try typing\s+<return>\s+to proceed\.?`,
	String.raw`If that doesn't work, type\s+X\s+<return>\s+to quit\.?`,
	String.raw`Type\s+I\s+<command>\s+<return>\s+to replace it with another command,?`,
	String.raw`or\s+<return>\s+to continue without it\.?`,
	String.raw`\(Press Enter to retry, or Control-D to exit\)`,
	String.raw`Please type another input file name:?`,
].join('|'), 'g');
/** A log line less TeX's terminal instructions, trimmed ('' when that was all). */
const withoutInstructions = (line) => String(line).replace(TERMINAL_INSTRUCTIONS, '').trim();
// How a LaTeX3 error (\msg_error: fontspec's, siunitx's, l3keys') says, under
// its message, where its help is — LaTeX2e writes "Type  H <return>  for
// immediate help." there, a primitive error nothing. A fatal one (\msg_fatal,
// "Type <return> to continue.") has only LaTeX3's "LaTeX does not know
// anything more about this error, sorry." after its context, and the pinned
// mp-tikz-wasm's log and diagnostics not even that: it gives none.
const LATEX3_ERROR = /^For immediate help type H <return>\.$/;
const HELP_MAX = 280;

/**
 * The first error's help — what TeX says after an error to explain it — its
 * first paragraph only, less TeX's terminal instructions (the owner's ask via
 * Clew-boss, 2026-10-22; every instruction, 2026-11-06), or ''. From a log
 * (the desktop's latexmk .log; mp-tikz-wasm's result.log): in nonstop mode TeX
 * writes it after the error's context, `l.N …` and the line under it, up to a
 * blank line or the next error — `! Undefined control sequence.` has "The
 * control sequence at the end of the top line of your error message was never
 * \def'ed. …"; a LaTeX3 error writes a blank line first (fontspec's "A font
 * might not be found for many reasons. …", the owner's "TeX's own help where
 * TeX gives one", 2026-11-06; until then the Mac showed none, and the iPad,
 * from 0.5.1's diagnostics, did). Or from mp-tikz-wasm's diagnostics: the
 * first error's `help`, the same lines. A log's lines are TeX's (unwrapLog),
 * as firstLatexError's — the empty line a line ended at its engine's width
 * leaves is not one (a LaTeX error's help in a long source line, 2026-11-12).
 *
 * @param {Uint8Array | string | { severity?: string, help?: string[] }[]} source
 */
export function firstLatexHelp(source) {
	let lines = [];
	if (Array.isArray(source)) {
		// The FIRST error's, or none — never a later one's, as from a log: under
		// a missing package the first has none, and the Emergency stop's is
		// "*** (cannot \read from terminal in nonstop modes)".
		const first = source.find((d) => d?.severity === 'error');
		lines = Array.isArray(first?.help) ? first.help : [];
	} else {
		const log = unwrapLog(source);
		const at = log.findIndex((l) => l.startsWith('!'));
		if (at === -1) return '';
		// The context must be the first error's own: one that only another
		// error's has (a missing package's `! LaTeX Error: File … not found.`,
		// then `! Emergency stop.`) has no help to give.
		const next = log.slice(at + 1, at + 16).findIndex((l) => l.startsWith('!'));
		const window = log.slice(at + 1, next === -1 ? at + 16 : at + 1 + next);
		const context = window.findIndex((l) => /^l\.\d+ /.test(l)) + at + 1;
		// TeX always writes a line under `l.N` (the rest of the source line,
		// indented — spaces at least); an empty one there means no help.
		if (context === at || !log[context + 1]) return '';
		// A LaTeX3 error — LATEX3_ERROR under its message — writes a blank line
		// after its context and then its help: read past that one line.
		const latex3 = log.slice(at + 1, context).some((l) => LATEX3_ERROR.test(l));
		lines = log.slice(context + (latex3 && !log[context + 2]?.trim() ? 3 : 2));
	}
	// To a blank line, or the next error's `!` (a missing \input's prompt runs
	// straight on into its Emergency stop).
	const end = lines.findIndex((l) => !String(l).trim() || String(l).startsWith('!'));
	const paragraph = (end === -1 ? lines : lines.slice(0, end)).map(withoutInstructions).filter(Boolean);
	const help = paragraph.join(' ').replace(/\s+/g, ' ').trim();
	return help.length > HELP_MAX ? `${help.slice(0, HELP_MAX - 1).replace(/\s+\S*$/, '')}…` : help;
}

/**
 * What a failed PDF via LaTeX says, on every host: the engine, why it was
 * chosen, and the log's first error with its help's first paragraph — else
 * the run's own error, else that no PDF came out. The log as BYTES where it
 * can be read so — latexmk's .log, mp-tikz-wasm's `texLogBytes` — since
 * pdfTeX cuts a letter's bytes at a line break; else as text (`texLog`).
 *
 * A host whose TeX reports diagnostics (mp-tikz-wasm's) passes them too, and
 * their help is read only where the log has no first error, or there is no
 * log: the help is the LOG's (Clew-boss, 2026-11-12, reversing 8ea4594's
 * diagnostics first). Once the log's lines were TeX's own — a LaTeX3 error's
 * help read (21d6d0f), lines joined as bytes (f094a58), the empty line a full
 * line leaves dropped (245f41c) — the diagnostics' help was never better and
 * sometimes worse: over 128 pinned-build runs with an error under both
 * engines, 17 differed and in none did the diagnostics have help the log had
 * not; 0.5.1's cut a help line at TeX's break ("ful l", "ta il", a letter as
 * two U+FFFD) and stopped a help at a 79-byte line's empty one. So the iPad
 * says what the Mac says, from the same bytes through the same function.
 *
 * @param {{ engine: string, reason: string, log?: Uint8Array | string, error?: string,
 *   diagnostics?: { severity?: string, help?: string[] }[] }} o
 */
export function pdfViaLatexFailure({ engine, reason, log = '', error = '', diagnostics = null }) {
	const logError = firstLatexError(log);
	const first = logError || error || 'no PDF was produced';
	const help = logError ? firstLatexHelp(log) : (diagnostics ? firstLatexHelp(diagnostics) : '');
	return `PDF via LaTeX failed — ${engineName(engine)} ran (${reason}). First error: ${first}${help ? ` — ${help}` : ''}`;
}
