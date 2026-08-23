/*
	Theorem-like environments — theorem / lemma / corollary / proposition /
	definition / example / remark, plus proof.

	    @begin(theorem)[Pythagoras]{id=thm:pyth}
	    For a right triangle, $a^2 + b^2 = c^2$.
	    @end(theorem)

	    @begin(proof)
	    By rearrangement.
	    @end(proof)

	Numbering: all theorem-like kinds share ONE sequential counter (Theorem 1,
	Lemma 2, Definition 3, …) — far easier for a reader than per-kind counters,
	where "is Lemma 1 before or after Theorem 2?" is a constant puzzle. proof is
	unnumbered. The optional [name] is amsthm's parenthetical note.

	LaTeX uses thmtools' \declaretheorem with `sibling=theorem`, so the kinds share
	the `theorem` counter AND cleveref still names each correctly ("lemma 2", not
	"theorem 2" — which plain amsthm counter-sharing would wrongly produce). HTML
	carries one shared counter in the post-processor (see number_theorems). A
	reference reads "theorem 1" / "lemma 2" etc. in both outputs.

	Cross-ref label keys go in {id=…} (colon-safe; the {#…} shorthand can't carry
	a colon).
*/

import { registerBlockEnvironment } from './begin-end-core.js';
import { requirePackage, addPreamble } from './preamble.js';
import { escapeLatexText } from './latex-escape.js';

// kind → presentation style (amsthm/thmtools): 'plain' italicises the body
// (theorems), 'definition'/'remark' keep it upright. The display name is the
// capitalised kind in both outputs, so it needn't be stored separately.
const THEOREM_KINDS = {
	theorem: 'plain', lemma: 'plain', corollary: 'plain', proposition: 'plain',
	definition: 'definition', example: 'definition', remark: 'remark'
};

function htmlEscapeAttr(s) {
	return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Declare a kind's thmtools environment, all sharing the primary `theorem`
// counter (sibling=theorem) for a single sequential numbering. The primary is
// always declared first (deduped), so a doc that uses only e.g. `definition`
// still gets a valid shared counter. cleveref (loaded later) reads these names.
function registerTheorem(kind, style) {
	requirePackage('amsthm');    // proof environment + base theorem styling
	requirePackage('thmtools');  // \declaretheorem with sibling counters + cleveref names
	addPreamble('\\declaretheorem{theorem}');
	if (kind !== 'theorem') {
		const styleOpt = style === 'plain' ? '' : `style=${style}, `;
		addPreamble(`\\declaretheorem[${styleOpt}sibling=theorem]{${kind}}`);
	}
}

for (const [kind, style] of Object.entries(THEOREM_KINDS)) {
	registerBlockEnvironment(kind, {
		mode: 'markdown',

		// The "Theorem N (name)." label and the cross-ref record are added by the
		// post-processor (number_theorems), which owns the shared counter.
		html: (ctx) => {
			const id = ctx.attrs?.id ? ` id="${ctx.attrs.id}"` : '';
			const name = ctx.text ? ` data-name="${htmlEscapeAttr(ctx.text)}"` : '';
			return `<div class="theorem-env theorem-${style}" data-kind="${kind}"${name}${id}>\n${ctx.inner}\n</div>\n`;
		},

		// thmtools/amsthm environment; \label right after \begin captures the number.
		latex: (ctx) => {
			registerTheorem(kind, style);
			const note = ctx.text ? `[${escapeLatexText(ctx.text)}]` : '';
			const label = ctx.attrs?.id ? `\\label{${ctx.attrs.id}}` : '';
			return `\\begin{${kind}}${note}${label}\n${ctx.inner}\n\\end{${kind}}\n\n`;
		}
	});
}

// proof — unnumbered, with a QED mark. amsthm provides the proof environment.
registerBlockEnvironment('proof', {
	mode: 'markdown',
	html: (ctx) => `<div class="proof-env">\n${ctx.inner}\n</div>\n`,
	latex: (ctx) => {
		requirePackage('amsthm');
		return `\\begin{proof}\n${ctx.inner}\n\\end{proof}\n\n`;
	}
});
