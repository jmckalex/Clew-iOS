/*
	Float environments — currently @begin(figure); table to follow.

	A captioned, numbered, cross-referenceable float:

	    @begin(figure)[A caption]{id=fig:demo}
	    ![alt](diagram.png)
	    @end(figure)

	LaTeX emits the native float and lets the engine number it (so \ref/\cref
	resolve); HTML emits a <figure> that the post-processor numbers in document
	order and records for :ref/:cref (see number_figures in post-processor.js).

	A BARE markdown image (![alt](src)) is just a graphic, not a float — reach for
	a figure environment when you want a caption + number + reference. The label
	key goes in {id=…} (the {#…} shorthand can't carry a colon, so {id=fig:x} is
	the colon-safe form).
*/

import { registerBlockEnvironment } from './begin-end-core.js';
import { requirePackage, crefName } from './preamble.js';
import { escapeLatexText } from './latex-escape.js';

function htmlEscape(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

// A {width=0.45} fraction → an HTML percentage ("45%"). attributes-parser coerces
// the number, so width arrives as 0.45.
function pct(width) {
	const n = Number(width);
	if (!Number.isFinite(n)) return '';
	return `${Math.round(n * 100)}%`;
}

registerBlockEnvironment('figure', {
	mode: 'markdown',

	// The "Figure N:" prefix and the cross-ref record are added later by the
	// post-processor, so numbering follows document order and forward refs work.
	html: (ctx) => {
		const id = ctx.attrs?.id ? ` id="${ctx.attrs.id}"` : '';
		const caption = ctx.text ? htmlEscape(ctx.text) : '';
		return `<figure class="figure"${id}>\n${ctx.inner}\n<figcaption class="figure-caption">${caption}</figcaption>\n</figure>\n`;
	},

	// The native float; the engine numbers it. \label after \caption so it
	// captures the figure counter. A blank line before \caption keeps it below
	// the contents (and below a row of subfigures).
	latex: (ctx) => {
		requirePackage('graphicx');
		crefName('figure', 'figure', 'figures');
		const caption = ctx.text ? `\\caption{${escapeLatexText(ctx.text)}}\n` : '';
		const label = ctx.attrs?.id ? `\\label{${ctx.attrs.id}}\n` : '';
		return `\\begin{figure}[htbp]\n\\centering\n${ctx.inner}\n\n${caption}${label}\\end{figure}\n\n`;
	}
});

// @begin(table) — a captioned, numbered, referenceable table float. The body is
// a JMarkdown table; this wraps it with a caption (above, per LaTeX convention)
// and a number. Same machinery as figures, with its own counter.
//
//     @begin(table)[A caption]{id=tab:results}
//     | A | B |
//     |---|---|
//     | 1 | 2 |
//     @end(table)
registerBlockEnvironment('table', {
	mode: 'markdown',

	// Caption first (above the table); the post-processor prefixes "Table N:"
	// and records the cross-ref.
	html: (ctx) => {
		const id = ctx.attrs?.id ? ` id="${ctx.attrs.id}"` : '';
		const caption = ctx.text ? htmlEscape(ctx.text) : '';
		return `<figure class="table-float"${id}>\n<figcaption class="table-caption">${caption}</figcaption>\n${ctx.inner}\n</figure>\n`;
	},

	// The native table float; \caption before the tabular, \label after \caption
	// so it captures the table counter.
	latex: (ctx) => {
		crefName('table', 'table', 'tables');
		// A long inner table renders as a page-breaking longtable, which can't
		// live in a (page-locked) table float. Caption it with \captionof above
		// the longtable instead — still numbered as a table and referenceable.
		if (ctx.inner.includes('\\begin{longtable}')) {
			requirePackage('caption');
			const cap = ctx.text ? `\\captionof{table}{${escapeLatexText(ctx.text)}}` : '';
			const label = ctx.attrs?.id ? `\\label{${ctx.attrs.id}}` : '';
			const head = (cap || label) ? `${cap}${label}\n` : '';
			return `${head}${ctx.inner}`;
		}
		const caption = ctx.text ? `\\caption{${escapeLatexText(ctx.text)}}\n` : '';
		const label = ctx.attrs?.id ? `\\label{${ctx.attrs.id}}\n` : '';
		return `\\begin{table}[htbp]\n\\centering\n${caption}${label}${ctx.inner}\n\\end{table}\n\n`;
	}
});

// @begin(listing) — a captioned, numbered, referenceable code float. The body is
// a fenced code block; this wraps it with a caption and a number.
//
//     @begin(listing)[A caption]{id=lst:hello}
//     ```python
//     print("hi")
//     ```
//     @end(listing)
registerBlockEnvironment('listing', {
	mode: 'markdown',

	// Caption below the code; the post-processor prefixes "Listing N:" and
	// records the cross-ref.
	html: (ctx) => {
		const id = ctx.attrs?.id ? ` id="${ctx.attrs.id}"` : '';
		const caption = ctx.text ? htmlEscape(ctx.text) : '';
		return `<figure class="listing"${id}>\n${ctx.inner}\n<figcaption class="listing-caption">${caption}</figcaption>\n</figure>\n`;
	},

	// minted's `listing` float environment wraps the minted code block; \caption
	// after it, \label after \caption so it captures the listing counter.
	latex: (ctx) => {
		requirePackage('minted');
		crefName('listing', 'listing', 'listings');
		const caption = ctx.text ? `\\caption{${escapeLatexText(ctx.text)}}\n` : '';
		const label = ctx.attrs?.id ? `\\label{${ctx.attrs.id}}\n` : '';
		return `\\begin{listing}[htbp]\n${ctx.inner}\n${caption}${label}\\end{listing}\n\n`;
	}
});

// @begin(subfigure) — a sub-panel inside an @begin(figure). Each gets its own
// caption, its own label, and a sub-letter ((a), (b), …) so a reference reads
// "1a"/"figure 1a". Width is {width=0.45} (a fraction of \textwidth / of the
// row); panels sit side by side. LaTeX uses the subcaption package.
registerBlockEnvironment('subfigure', {
	mode: 'markdown',

	// The "(a)" sub-letter and the cross-ref record are added by the
	// post-processor (number_figures), which knows the parent figure's number.
	html: (ctx) => {
		const id = ctx.attrs?.id ? ` id="${ctx.attrs.id}"` : '';
		const caption = ctx.text ? htmlEscape(ctx.text) : '';
		const w = ctx.attrs?.width != null ? pct(ctx.attrs.width) : '';
		const style = w ? ` style="width:${w}"` : '';
		return `<figure class="subfigure"${id}${style}>\n${ctx.inner}\n<figcaption class="subfigure-caption">${caption}</figcaption>\n</figure>\n`;
	},

	// subcaption's subfigure environment; the engine sub-numbers it and \ref/\cref
	// resolve to "1a". \hfill lets adjacent panels share a row.
	latex: (ctx) => {
		requirePackage('subcaption');
		crefName('subfigure', 'figure', 'figures');
		const w = ctx.attrs?.width != null ? ctx.attrs.width : 0.45;
		const caption = ctx.text ? `\\caption{${escapeLatexText(ctx.text)}}\n` : '';
		const label = ctx.attrs?.id ? `\\label{${ctx.attrs.id}}\n` : '';
		return `\\begin{subfigure}[b]{${w}\\textwidth}\n\\centering\n${ctx.inner}\n${caption}${label}\\end{subfigure}\n\\hfill\n`;
	}
});
