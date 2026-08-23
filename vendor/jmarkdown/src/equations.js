/*
	Numbered, cross-referenceable display equations.

	    @begin(equation){id=eq:mass}
	    E = mc^2
	    @end(equation)

	The body is raw math (no $$ delimiters — the environment supplies them), and
	is taken verbatim so _, ^, \ survive. JMarkdown assigns the number itself
	(document order) rather than leaning on MathJax's client-side numbering, so
	:ref/:cref resolve at build time exactly like figures/tables/theorems:
	:ref[eq:mass] -> "1", :cref[eq:mass] -> "equation 1".

	LaTeX emits an amsmath `equation` environment (engine-numbered); HTML emits a
	display block the post-processor numbers (see number_equations). The two stay
	in step because both count @begin(equation) blocks in order.
*/

import { registerBlockEnvironment } from './begin-end-core.js';
import { requirePackage, crefName } from './preamble.js';

registerBlockEnvironment('equation', {
	mode: 'verbatim',

	// The (N) number and the cross-ref record are added by the post-processor.
	// \[…\] is an unnumbered MathJax display, so our injected number is the only
	// one — no double numbering.
	html: (ctx) => {
		const id = ctx.attrs?.id ? ` id="${ctx.attrs.id}"` : '';
		const math = ctx.inner.trim();
		return `<div class="equation"${id}>\n<span class="eqn-body">\\[\n${math}\n\\]</span>\n</div>\n`;
	},

	// amsmath's equation environment; \label right after \begin captures the
	// equation counter so \ref/\cref resolve.
	latex: (ctx) => {
		requirePackage('amsmath');
		crefName('equation', 'equation', 'equations');
		const label = ctx.attrs?.id ? `\n\\label{${ctx.attrs.id}}` : '';
		return `\\begin{equation}${label}\n${ctx.inner.trim()}\n\\end{equation}\n\n`;
	}
});
