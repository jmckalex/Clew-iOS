/*
	Numbered user-defined environments.

	A handler passed to `defineEnvironment` (script block) or loaded from a file
	may opt into automatic numbering and cross-referencing by declaring
	`numbered: true` — the same first-class treatment the built-in theorem,
	float, and equation environments get, but for any name an author invents:

	    defineEnvironment('exercise', {
	      numbered: true,           // turn on numbering + :ref/:cref participation
	      counter: 'exercise',      // optional; default = the name. Same value ⇒ shared counter.
	      refname: 'exercise',      // optional; the :cref word. Or ['exercise','exercises'].
	      title:   'Exercise',      // optional; the printed/heading word. Default = capitalised refname.
	      html:  (ctx) => `<aside class="exercise">${ctx.inner}</aside>`,
	      latex: (ctx) => …         // optional — omit for an automatic thmtools env.
	    });

	    @begin(exercise)[The hard one]{id=ex:hard}
	    Show that …
	    @end(exercise)

	The split follows the rest of JMarkdown: LaTeX emits native commands and lets
	the engine number/resolve; HTML resolves everything itself in the
	post-processor.

	  HTML  — the author's renderer is wrapped in a marker
	          (`<div class="jmd-env …" data-jmd-counter data-jmd-kind …>`), which
	          the post-processor's number_environments pass finds, numbers in
	          document order (per counter group), labels, and records in the
	          cross-ref registry. Because that pass also stamps
	          data-xref-number/-type, a :label INSIDE the body resolves for free
	          (the closest('[data-xref-number]') route), and :cref's word comes
	          from typedRefText's raw-type fallback — so a custom kind needs no
	          registration there.
	  LaTeX — with no author `latex`, the env is rendered as a thmtools
	          theorem-like (engine numbers it, cleveref names it via the
	          refname/Refname options so the wording matches HTML). An author
	          `latex` renderer is respected as-is (the author then owns the LaTeX
	          counter and naming).

	This module is the ONLY home of the numbering coupling; begin-end-core.js
	stays generic. The post-processor reads getNumberedSpecs(); index.js and
	metadata-header.js route their registration through defineEnvironment here.
*/

import { registerBlockEnvironment, getBlockEnvironment } from './begin-end-core.js';
import { requirePackage, addPreamble } from './preamble.js';
import { escapeLatexText } from './latex-escape.js';

// name → { counter, type, title } for the post-processor's HTML numbering pass.
// Module-level, like the begin-end registry itself: a definition, not per-run
// state (the running counters live locally in the pass and reset each build).
const specs = new Map();

export function getNumberedSpecs() {
	return specs;
}

const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const attrEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/*
	Register a block environment, honouring `numbered`. A non-numbered handler
	passes straight through to the core registry unchanged, so this is a safe
	drop-in for registerBlockEnvironment on every registration path (script
	block, `Load environments` file, `Environments` config).
*/
export function defineEnvironment(name, handler) {
	if (!handler || !handler.numbered) {
		registerBlockEnvironment(name, handler);
		return;
	}

	const counter = handler.counter || name;
	const refnameRaw = handler.refname || name;
	const [singular, plural] = Array.isArray(refnameRaw)
		? refnameRaw
		: [refnameRaw, `${refnameRaw}s`];
	const title = handler.title || cap(singular);

	// The post-processor numbers by `counter` (shared group) and labels with
	// `title`; cross-refs use `type` (the lower-case :cref word).
	specs.set(name, { counter, type: singular, title });

	// HTML: wrap the author's box in a marker the post-processor can find and
	// number. Regular function so the core's render.call(this,…) forwards the
	// parser as `this` to the author's renderer. The marker carries the id, so
	// the author should NOT set an id of their own on a numbered env.
	const html = function (ctx) {
		const inner = typeof handler.html === 'function' ? handler.html.call(this, ctx) : ctx.inner;
		const id = ctx.attrs?.id ? ` id="${attrEsc(ctx.attrs.id)}"` : '';
		const nm = ctx.text ? ` data-jmd-name="${attrEsc(ctx.text)}"` : '';
		return `<div class="jmd-env ${name}-env" data-jmd-counter="${attrEsc(counter)}" data-jmd-kind="${attrEsc(name)}"${nm}${id}>\n${inner}\n</div>\n`;
	};

	// LaTeX: an author renderer owns the LaTeX side entirely (their own counter
	// + naming). Otherwise render a thmtools theorem-like — the engine numbers
	// it and cleveref names it (refname/Refname keep the wording == HTML).
	const latex = typeof handler.latex === 'function'
		? handler.latex
		: function (ctx) {
			requirePackage('amsthm');
			requirePackage('thmtools');
			const refOpt = `refname={${singular},${plural}}, Refname={${cap(singular)},${cap(plural)}}`;
			if (counter === name) {
				// Standalone (the default): own counter, own name.
				addPreamble(`\\declaretheorem[name=${title}, ${refOpt}]{${name}}`);
			} else {
				// Shared counter group. Declare a synthetic base ONCE unless the
				// group name is itself a numbered env (then it's already declared
				// standalone, and we just sibling onto it — no double \declaretheorem).
				if (!specs.has(counter)) addPreamble(`\\declaretheorem[name=${cap(counter)}]{${counter}}`);
				addPreamble(`\\declaretheorem[name=${title}, ${refOpt}, sibling=${counter}]{${name}}`);
			}
			const note = ctx.text ? `[${escapeLatexText(ctx.text)}]` : '';
			const label = ctx.attrs?.id ? `\\label{${ctx.attrs.id}}` : '';
			return `\\begin{${name}}${note}${label}\n${ctx.inner}\n\\end{${name}}\n\n`;
		};

	registerBlockEnvironment(name, { ...handler, html, latex });
}

// Exposed for symmetry / potential future reset; specs are definitions, so the
// CLI one-shot never needs this (the running counters live in the pass).
export { getBlockEnvironment };
