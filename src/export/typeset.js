// PDF via LaTeX on the iPad (UPSTREAM-LATEX-EXPORT-PLAN.md §4, P2/L3): the
// .tex the export worker built, typeset by mp-tikz-wasm's own TeX as latexmk
// would typeset it — a pass, BibTeX when the .aux names a database,
// makeindex when there is an .idx, two more passes, and one more while the
// log asks for a rerun, five at most — in a NEW engine instance, disposed of
// at the end (mp-tikz-wasm's sandbox review: /texmf-var is writable by a
// document, so no instance outlives its export).
//
// Which engine is desktop's rule, imported (shared/latex-engine.js
// #chooseLatexEngine, U5) over the two this TeX has: a document that needs
// XeLaTeX is refused in words. What TeX sees is `inputs` alone — the
// figures the build made, the bibliographies the .tex names — never a path
// of the device's (the owner's (3): every vault may typeset, because nothing
// outside it reaches the engine). A failure says what desktop's compilePdf
// says (pdfViaLatexFailure: the engine, why, the log's first error).

import { chooseLatexEngine, pdfViaLatexFailure } from '../../vendor/clew/shared/latex-engine.js';

/** The bundles a document needs (Clew-boss, against 0.5.0): the default ones,
 *  OpenType (fontspec), otf-fonts (latinmodern-math, which unicode-math falls
 *  back to without Garamond-Math), and latex-doc (natbib, babel, tcolorbox,
 *  BibTeX's styles, EB Garamond…). */
export const DOCUMENT_BUNDLES = ['opentype', 'otf-fonts', 'latex-doc'];
export const MAX_PASSES = 5;
const RERUN = /Rerun to get|Label\(s\) may have changed|Rerun LaTeX|Please rerun LaTeX|undefined references.*rerun/i;

const text = (bytes) => (bytes ? new TextDecoder().decode(bytes) : '');

/**
 * @param {{ lib: { MetaPost: any, DEFAULT_BUNDLES: string[] }, tex: string,
 *   inputs?: Record<string, string | Uint8Array>, date?: 'now' | 'fixed' }} o
 * @returns {Promise<{ pdf: Uint8Array, engine: string, reason: string, passes: number,
 *   bibtex: boolean, makeindex: boolean, warnings: string[], ms: number }>}
 */
export async function typeset({ lib, tex, inputs = {}, date = 'now' }) {
	const t0 = Date.now();
	const choice = chooseLatexEngine(tex, 'auto', { available: ['pdflatex', 'lualatex'], host: 'the iPad\'s TeX' });
	if (choice.unavailable) throw new Error(choice.refusal);
	// Nothing here limits a pass: in-process, a document that loops never
	// returns (0.5.0 declares `texTimeoutMs` and reads it nowhere). Clew's
	// own limit stops it — three minutes, ExportHost.swift, which ends the
	// page and with it this worker.
	const mp = await lib.MetaPost.create({ bundles: [...lib.DEFAULT_BUNDLES, ...DOCUMENT_BUNDLES], logLevel: 'silent' });
	try {
		const run = (files) => mp.latex(tex, {
			engine: choice.engine === 'lualatex' ? 'lualatex' : 'latex', output: 'pdf', jobName: 'doc', date, files,
		});
		const warnings = [];
		let passes = 1;
		let r = await run({ ...inputs });
		let extra = {};
		let bibtex = false;
		let makeindex = false;
		if (/\\bibdata\{/.test(text(r.artifacts['doc.aux']))) {
			const b = await mp.bibtex({ jobName: 'doc', files: r.artifacts });
			bibtex = true;
			extra = { ...extra, ...b.artifacts };
			for (const d of b.diagnostics ?? []) warnings.push(`BibTeX: ${d.message}`);
		}
		if (r.artifacts['doc.idx']) {
			const i = await mp.makeindex({ input: 'doc.idx', files: r.artifacts });
			makeindex = true;
			extra = { ...extra, ...i.artifacts };
			for (const d of i.diagnostics ?? []) warnings.push(`makeindex: ${d.message}`);
		}
		r = await run({ ...r.artifacts, ...extra });
		passes += 1;
		r = await run(r.artifacts);
		passes += 1;
		while (passes < MAX_PASSES && RERUN.test(r.texLog ?? '')) {
			r = await run(r.artifacts);
			passes += 1;
		}
		if (!r.pdf || r.status === 'fatal') {
			throw new Error(pdfViaLatexFailure({ engine: choice.engine, reason: choice.reason, log: r.texLog, error: r.diagnostics?.find((d) => d.severity === 'error')?.message }));
		}
		return { pdf: r.pdf, engine: choice.engine, reason: choice.reason, passes, bibtex, makeindex, warnings, ms: Date.now() - t0 };
	} finally {
		mp.dispose?.();
	}
}
