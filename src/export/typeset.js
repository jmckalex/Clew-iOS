// PDF via LaTeX on the iPad (UPSTREAM-LATEX-EXPORT-PLAN.md §4, P2/L3): the
// .tex the export worker built, typeset by mp-tikz-wasm's own TeX as latexmk
// would typeset it — a pass, BibTeX when the .aux names a database,
// makeindex when there is an .idx, two more passes, and one more while the
// log asks for a rerun, five at most; a first pass that writes no PDF ends
// it — each pass in a NEW engine instance, the last one disposed of before
// the next is made. mp-tikz-wasm's sandbox review: /texmf-var is writable
// by a document, so no instance outlives its pass. And memory: a pass's
// LuaTeX is freed only when JavaScriptCore collects it, often well into the
// next pass, so on one instance two passes' engines overlapped; disposing
// ends the instance's worker, and its memory with it (the simulator's
// footprint: UPSTREAM-LATEX-EXPORT-PLAN.md §4, "Memory, measured").
//
// Which engine is desktop's rule, imported (shared/latex-engine.js
// #chooseLatexEngine, U5) over the two this TeX has: a document that needs
// XeLaTeX is refused in words. What TeX sees is `inputs` alone — the
// figures the build made, the bibliographies the .tex names — never a path
// of the device's (the owner's (3): every vault may typeset, because nothing
// outside it reaches the engine). A failure says what desktop's compilePdf
// says (pdfViaLatexFailure: the engine, why, the log's first error).

import { BUILT_IN_TEX, chooseLatexEngine, pdfViaLatexFailure } from '../../vendor/clew/shared/latex-engine.js';

/** The bundles a document needs beside the library's default ones, upstream's
 *  (shared/latex-engine.js#BUILT_IN_TEX, with mp-tikz-wasm's 0.5.0 pin):
 *  OpenType (fontspec), otf-fonts (latinmodern-math, which unicode-math falls
 *  back to without Garamond-Math), and latex-doc (natbib, babel, tcolorbox,
 *  BibTeX's styles, EB Garamond…). */
export const DOCUMENT_BUNDLES = BUILT_IN_TEX.bundles;
export const MAX_PASSES = 5;
/** How long a pass may print nothing before mp-tikz-wasm's watchdog ends it. */
export const SILENCE_MS = 60_000;
/**
 * In front of the .tex as TeX is given it, under LuaLaTeX only: Lua's
 * collector runs eagerly, so luaotfload's font tables leave less garbage, and
 * a styled pass's heap peaks 30–40% lower at about the same speed. On the
 * .tex's first line, so no line number moves; never in a .tex Clew exports.
 */
export const LUA_GC = '\\directlua{collectgarbage("setpause", 100) collectgarbage("setstepmul", 400)}';
const RERUN = /Rerun to get|Label\(s\) may have changed|Rerun LaTeX|Please rerun LaTeX|undefined references.*rerun/i;

const text = (bytes) => (bytes ? new TextDecoder().decode(bytes) : '');

/**
 * @param {{ lib: { MetaPost: any, DEFAULT_BUNDLES: string[] }, tex: string,
 *   inputs?: Record<string, string | Uint8Array>, date?: 'now' | 'fixed' }} o
 * @returns {Promise<{ pdf: Uint8Array, engine: string, reason: string, passes: number,
 *   bibtex: boolean, makeindex: boolean, warnings: string[], ms: number }>}
 */
export async function typeset({ lib, tex, inputs = {}, date = BUILT_IN_TEX.date }) {
	const t0 = Date.now();
	const choice = chooseLatexEngine(tex, 'auto', { available: ['pdflatex', 'lualatex'], host: 'the iPad\'s TeX' });
	if (choice.unavailable) throw new Error(choice.refusal);
	// Two limits stop a pass that never ends. In the export host,
	// mp-tikz-wasm runs TeX in a worker of its own, whose stall watchdog
	// ends a pass that prints nothing for SILENCE_MS (`timeoutMs`; 20 s
	// unless set, which a slow iPad could reach legitimately): a safety net,
	// said here in desktop's words. A document that loops while printing
	// feeds the watchdog; Clew's own limit stops it — three minutes,
	// ExportHost.swift, which ends the page and with it this worker
	// (tools/sim-pdf-checks.mjs, `limit`). Under Node, in-process, there is
	// no watchdog (0.5.0 declares `texTimeoutMs` and reads it nowhere).
	const lua = choice.engine === 'lualatex';
	const source = lua ? LUA_GC + tex : tex;
	let mp = null;
	/** A new instance for the next pass, the last one gone first. */
	const fresh = async () => {
		mp?.dispose?.();
		mp = null;
		mp = await lib.MetaPost.create({ bundles: [...lib.DEFAULT_BUNDLES, ...DOCUMENT_BUNDLES], logLevel: 'silent', timeoutMs: SILENCE_MS });
		return mp;
	};
	const failure = (o) => new Error(pdfViaLatexFailure({ engine: choice.engine, reason: choice.reason, ...o }));
	try {
		// Every pass is handed the inputs again: files given to an instance
		// stay on it, and a new one has none (the figures, the images).
		const run = async (files) => {
			const engine = await fresh();
			try {
				return await engine.latex(source, {
					engine: lua ? 'lualatex' : 'latex', output: 'pdf', jobName: 'doc', date, files: { ...inputs, ...files },
				});
			} catch (err) {
				if (/made no progress/.test(String(err?.message))) throw failure({ error: `TeX went ${SILENCE_MS / 1000} seconds without any output and was stopped` });
				throw err;
			}
		};
		const failed = (r) => !r.pdf || r.status === 'fatal';
		const why = (r) => ({ log: r.texLog, error: r.diagnostics?.find((d) => d.severity === 'error')?.message });
		const warnings = [];
		let passes = 1;
		let r = await run({});
		// A first pass that wrote no PDF ends it (a file TeX could not find, a
		// fatal error): the passes after it would only fail again.
		if (failed(r)) throw failure(why(r));
		let extra = {};
		let bibtex = false;
		let makeindex = false;
		// BibTeX and makeindex on the first pass's instance, given the
		// bibliographies again with its artifacts.
		if (/\\bibdata\{/.test(text(r.artifacts['doc.aux']))) {
			const b = await mp.bibtex({ jobName: 'doc', files: { ...inputs, ...r.artifacts } });
			bibtex = true;
			extra = { ...extra, ...b.artifacts };
			for (const d of b.diagnostics ?? []) warnings.push(`BibTeX: ${d.message}`);
		}
		if (r.artifacts['doc.idx']) {
			const i = await mp.makeindex({ input: 'doc.idx', files: { ...inputs, ...r.artifacts } });
			makeindex = true;
			extra = { ...extra, ...i.artifacts };
			for (const d of i.diagnostics ?? []) warnings.push(`makeindex: ${d.message}`);
		}
		// The .bbl and .ind go to every later pass: a run returns only what
		// TeX wrote, and a new instance keeps nothing it was handed before.
		r = await run({ ...r.artifacts, ...extra });
		passes += 1;
		r = await run({ ...r.artifacts, ...extra });
		passes += 1;
		while (passes < MAX_PASSES && RERUN.test(r.texLog ?? '')) {
			r = await run({ ...r.artifacts, ...extra });
			passes += 1;
		}
		if (failed(r)) throw failure(why(r));
		return { pdf: r.pdf, engine: choice.engine, reason: choice.reason, passes, bibtex, makeindex, warnings, ms: Date.now() - t0 };
	} finally {
		mp?.dispose?.();
	}
}
