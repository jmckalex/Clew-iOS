/*
	LaTeX renderer for marked.js built-in tokens.

	This module exports a renderer object suitable for passing to
	marked.use({ renderer: latexRenderer }).  It covers the core
	structural tokens: paragraphs, headings, emphasis, bold, code,
	links, images, lists, blockquotes, horizontal rules, and line breaks.

	Tokens produced by custom extensions (e.g. /italics/, ==highlight==)
	are handled in their own extension renderers, not here.
*/

import { configManager } from './config-manager.js';
import { requirePackage } from './preamble.js';
import { escapeLatexText as escapeLatex } from './latex-escape.js';
import { commandForDepth } from './sectioning.js';

// Candidate \mintinline delimiters, tried in order. \mintinline takes its code
// verbatim between a delimiter pair (like \verb), so the delimiter just has to
// be a character the code does not contain — that is what lets inline code keep
// literal braces, backslashes, %, & and so on.
const MINTINLINE_DELIMS = ['|', '!', '+', '@', '/', ':', ';', '"', "'", '~', '?', '='];

const latexRenderer = {

	paragraph(token) {
		return `${this.parser.parseInline(token.tokens)}\n\n`;
	},

	heading(token) {
		let content = this.parser.parseInline(token.tokens);
		const command = commandForDepth(token.depth);

		// Check for {-} suffix, which signals an unnumbered heading.
		let starred = '';
		if (/\s*\{-\}\s*$/.test(content)) {
			content = content.replace(/\s*\{-\}\s*$/, '');
			starred = '*';
		}

		return `\\${command}${starred}{${content}}\n\n`;
	},

	strong(token) {
		return `\\textbf{${this.parser.parseInline(token.tokens)}}`;
	},

	em(token) {
		return `\\emph{${this.parser.parseInline(token.tokens)}}`;
	},

	codespan(token) {
		requirePackage('minted');
		const lang = configManager.get('Code language') || 'text';
		const code = token.text;
		// Use a delimiter the code doesn't contain. The brace form
		// \mintinline{lang}{code} breaks on a literal `}` in the code (the group
		// closes early); a \verb-style delimiter avoids that.
		const delim = MINTINLINE_DELIMS.find(c => !code.includes(c));
		if (delim) return `\\mintinline{${lang}}${delim}${code}${delim}`;
		// Pathological: code contains every candidate delimiter. Fall back to the
		// brace form, which still works when the braces in the code are balanced.
		return `\\mintinline{${lang}}{${code}}`;
	},

	code(token) {
		// Prefer the fence's named language (```javascript) over the
		// document-wide default. Requires \usepackage{minted} in the
		// preamble (declared here) and pdflatex -shell-escape at compile time.
		requirePackage('minted');
		const lang = token.lang || configManager.get('Code language') || 'text';
		return `\\begin{minted}{${lang}}\n${token.text}\n\\end{minted}\n\n`;
	},

	link(token) {
		requirePackage('hyperref');
		const text = this.parser.parseInline(token.tokens);
		return `\\href{${escapeLatex(token.href)}}{${text}}`;
	},

	image(token) {
		// A bare image is just the graphic — NOT a floating, numbered figure.
		// Use @begin(figure) (see floats.js) for a captioned, numbered,
		// referenceable float; nesting \includegraphics there avoids a figure
		// inside a figure.
		requirePackage('graphicx');
		return `\\includegraphics[width=\\textwidth]{${escapeLatex(token.href)}}`;
	},

	blockquote(token) {
		const body = this.parser.parse(token.tokens).trimEnd();
		return `\\begin{quote}\n${body}\n\\end{quote}\n\n`;
	},

	list(token) {
		const env = token.ordered ? 'enumerate' : 'itemize';
		let body = '';
		for (const item of token.items) {
			body += this.listitem(item);
		}
		return `\\begin{${env}}\n${body}\\end{${env}}\n\n`;
	},

	listitem(token) {
		const content = this.parser.parse(token.tokens);
		return `\\item ${content.trim()}\n`;
	},

	table(token) {
		// Fallback for marked's built-in `table` token. The two table
		// extensions in `marked-extended-tables-headerless.js` intercept
		// most tables and render directly to LaTeX, but marked's GFM
		// tokenizer is more permissive (e.g. accepts rows without trailing
		// pipes) and falls through to this renderer for those edge cases.
		const ncols = token.header.length;
		const aligns = token.align.map(a => {
			if (a === 'center') return 'c';
			if (a === 'right') return 'r';
			return 'l';
		});
		const colspec = aligns.join('');

		// booktabs rules (\toprule/\midrule/\bottomrule) — the publication
		// look, not \hline's spreadsheet look. Same rules in both table paths
		// (see renderTableLatex in marked-extended-tables-headerless.js).
		requirePackage('booktabs');
		let tex = `\\begin{tabular}{${colspec}}\n\\toprule\n`;

		// Header row
		const headerCells = token.header.map(cell =>
			this.parser.parseInline(cell.tokens)
		);
		tex += headerCells.join(' & ') + ' \\\\\n\\midrule\n';

		// Body rows
		for (const row of token.rows) {
			const cells = row.map(cell =>
				this.parser.parseInline(cell.tokens)
			);
			tex += cells.join(' & ') + ' \\\\\n';
		}

		tex += '\\bottomrule\n\\end{tabular}\n\n';
		return tex;
	},

	hr(token) {
		return '\\bigskip\\noindent\\rule{\\textwidth}{0.4pt}\\bigskip\n\n';
	},

	br(token) {
		return '\\\\\n';
	},

	text(token) {
		// A text token may contain inline sub-tokens (e.g. when it appears
		// inside a paragraph that has been partially parsed).
		if (token.tokens) {
			return this.parser.parseInline(token.tokens);
		}
		return escapeLatex(token.text);
	}
};

export default latexRenderer;
