/*
	JMarkdown's layer over the generic @begin/@end core (begin-end-core.js).

	This file is the rip-out boundary.  Everything LaTeX- and JMarkdown-specific
	lives here, so the core can be lifted out and published as a standalone,
	HTML-only marked extension simply by dropping this file.  Here we:

	  • detect the output format from JMarkdown's global.isLatex switch,
	  • read the `Block elements` policy from the JMarkdown config,
	  • supply the generic LaTeX fallback (\begin{name}…\end{name}) and the LaTeX
	    form of an orphan opener,
	  • register the four parity environments (abstract / feedback / TeX / HTML)
	    so that @begin(x) renders identically to :::x.

	Other modules register their own environments into the same registry — see
	metadata-header.js (comment / optionals) and strategic-form-games.js (game).

	Parity notes:
	  • abstract / feedback share their render bodies with the directives in
	    additional-directives.js (no drift), and have *no* LaTeX branch — like the
	    directives, they emit their HTML in both output formats, by design.  With
	    only an `html` renderer they fall back to HTML in LaTeX mode, which is
	    exactly that behaviour.
	  • TeX (verbatim, LaTeX-only) and HTML (markdown, HTML-only) are output-format
	    gated; here that is expressed directly as separate html/latex renderers —
	    the dual-output design the core was built for.  Their one-line bodies
	    mirror renderTeXEnv / renderHTMLEnv in additional-directives.js.
*/

import { createBeginEnd, createAtInline, createAtBlock, registerBlockEnvironment } from './begin-end-core.js';
import { renderAbstract, renderFeedback } from './additional-directives.js';
import { configManager } from './config-manager.js';
import { addPreamble, requirePackage } from './preamble.js';
import { addWarning } from './warnings.js';

const format = () => (global.isLatex ? 'latex' : 'html');

// Parity with the existing directives: @begin(x) ≡ :::x for these four names.
registerBlockEnvironment('abstract', {
	mode: 'markdown',
	html: (ctx) => renderAbstract(ctx.inner)
});
registerBlockEnvironment('feedback', {
	mode: 'markdown',
	html: (ctx) => renderFeedback(ctx.inner)
});
registerBlockEnvironment('TeX', {
	mode: 'verbatim',          // raw LaTeX: $, _, \ etc. survive untouched
	html: () => '',
	latex: (ctx) => ctx.rawText
});
registerBlockEnvironment('HTML', {
	mode: 'markdown',          // markdown prose, emitted only in HTML output
	html: (ctx) => ctx.inner,
	latex: () => ''
});
// Conditional content (the @begin parity of :::print / :::web): markdown prose
// emitted in one output only — e.g. a static figure for print vs. an interactive
// widget for the web, from a single source.
registerBlockEnvironment('print', {
	mode: 'markdown',
	html: () => '',
	latex: (ctx) => ctx.inner
});
registerBlockEnvironment('web', {
	mode: 'markdown',
	html: (ctx) => ctx.inner,
	latex: () => ''
});

/* --- Parity handlers for the new @name[…] / @name+[…] single-shot forms --------

	First slice of retiring the colon-directive framework: these names work via
	`@name[…]` (inline, parity with `:name`) and `@name+[…]` (block, parity with
	`::name`), sharing the one registry — and `:`/`::` stay fully live alongside.

	Cross-references reuse the EXACT markers the post-processor (HTML) and the
	engine (LaTeX) already consume, so `@ref[k]` is byte-identical to `:ref[k]`.
	They are `verbatim` so a key like `eq:1` is never re-lexed as markdown; the raw
	key is ctx.text.
*/
const escKey = (k) => String(k).replaceAll("'", '&#39;');
registerBlockEnvironment('label', {
	mode: 'verbatim',
	html: (ctx) => `<span class='xref-label' id='xref-${escKey(ctx.text)}' data-key='${escKey(ctx.text)}'></span>`,
	latex: (ctx) => `\\label{${ctx.text}}`
});
registerBlockEnvironment('ref', {
	mode: 'verbatim',
	html: (ctx) => `<span class='xref-ref' data-key='${escKey(ctx.text)}'></span>`,
	latex: (ctx) => `\\ref{${ctx.text}}`
});
registerBlockEnvironment('cref', {
	mode: 'verbatim',
	html: (ctx) => `<span class='xref-cref' data-key='${escKey(ctx.text)}' data-cap='0'></span>`,
	latex: (ctx) => { requirePackage('cleveref'); return `\\cref{${ctx.text}}`; }
});
registerBlockEnvironment('Cref', {
	mode: 'verbatim',
	html: (ctx) => `<span class='xref-cref' data-key='${escKey(ctx.text)}' data-cap='1'></span>`,
	latex: (ctx) => { requirePackage('cleveref'); return `\\Cref{${ctx.text}}`; }
});
// A plain generic span, parity with the old `:span`. A registered handler owns its
// own output, so `@span` and `@span+` both emit <span> (the `+` still changes DOM
// placement: inside <p> vs a top-level node). The span↔div DEFAULT flip is shown
// instead by the generic fallback for UNREGISTERED names (`@foo[…]` → <span class>,
// `@foo+[…]` → <div class>).
registerBlockEnvironment('span', {
	mode: 'markdown',
	html: (ctx) => `<span${ctx.attrs ? ' ' + String(ctx.attrs).trim() : ''}>${ctx.inner}</span>`,
	latex: (ctx) => ctx.inner
});

const blockPolicy = () => configManager.get('Block elements', 'hyphenated');

export const beginEnd = createBeginEnd({
	getFormat: format,
	blockElements: () => configManager.get('Block elements', 'hyphenated'),

	// The generic LaTeX environment for any unregistered name: \begin{name}…\end.
	// (The core supplies the matching generic HTML; this is the LaTeX half.)
	fallback: {
		latex: (ctx) => {
			// Graceful degradation, mirroring the HTML side: an unstyled
			// <div class="name"> renders fine before the author writes CSS, so
			// an undefined \begin{name} should typeset as a plain block, not
			// die with "Environment name undefined". The guard is deferred to
			// \AtBeginDocument — i.e. past the ENTIRE preamble — so an author
			// definition (LaTeX preamble key, a package, a class) always wins
			// regardless of where it appears; the no-op only fills genuine
			// gaps. Full-document builds only by nature: --fragment output is
			// body-only and its consumer owns the preamble. addPreamble
			// dedupes, so re-rendering the same name adds one line.
			addPreamble(`\\AtBeginDocument{\\ifcsname ${ctx.name}\\endcsname\\else\\newenvironment{${ctx.name}}{}{}\\fi}`);
			const opt = ctx.text ? `[${ctx.text}]` : '';
			return `\\begin{${ctx.name}}${opt}\n${ctx.inner}\n\\end{${ctx.name}}\n\n`;
		}
	},

	// An orphan opener in LaTeX is emitted as the verbatim line.
	orphan: {
		latex: (literal) => literal + '\n'
	}
});

// The inline (@name[…]) and block (@name+[…]) single-shot forms, sharing the same
// registry as @begin/@end. Generic LaTeX fallbacks: an unregistered inline form
// passes its content through; an unregistered block form becomes \begin{name}…\end
// with the same guarded no-op definition begin-end uses.
export const atInline = createAtInline({
	getFormat: format,
	blockElements: blockPolicy,
	fallback: { latex: (ctx) => ctx.inner },
	// A `@name+[…]` block form used mid-paragraph (it must start its own line):
	// record a build warning and emit a visible marker (HTML) / nothing (LaTeX).
	misplaced: (name, fmt) => {
		addWarning(`@${name}+ used mid-paragraph — a +-block directive must start its own line; it was not rendered`);
		return fmt === 'latex' ? '' : `<span class="jmd-error">[@${name}+ must start its own line]</span>`;
	}
});

export const atBlock = createAtBlock({
	getFormat: format,
	blockElements: blockPolicy,
	fallback: {
		latex: (ctx) => {
			addPreamble(`\\AtBeginDocument{\\ifcsname ${ctx.name}\\endcsname\\else\\newenvironment{${ctx.name}}{}{}\\fi}`);
			return `\\begin{${ctx.name}}\n${ctx.inner}\n\\end{${ctx.name}}\n\n`;
		}
	}
});

export default beginEnd;
