/*
	LaTeX rendering for GFM alerts / callouts (> [!NOTE] …), which marked-alert
	turns into `alert` tokens. index.js captures marked-alert's HTML renderer and
	delegates here in LaTeX mode, so the callout becomes a coloured tcolorbox
	instead of leaking its HTML into the .tex.
*/

import { requirePackage } from './preamble.js';
import { escapeLatexText } from './latex-escape.js';

// variant → xcolor colour for the box frame/background. Covers the five GFM
// variants plus JMarkdown's custom question/suggestion; anything else falls back.
const ALERT_COLORS = {
	note: 'blue',
	tip: 'teal',
	important: 'violet',
	warning: 'orange',
	caution: 'red',
	question: 'cyan',
	suggestion: 'teal'
};

export function renderAlertLatex(parser, token) {
	requirePackage('tcolorbox');
	const meta = token.meta || {};
	const variant = meta.variant || 'note';
	const color = ALERT_COLORS[variant] || 'gray';
	const title = escapeLatexText(meta.title || variant);
	const body = parser.parse(token.tokens).trim();
	return `\\begin{tcolorbox}[colframe=${color},colback=${color}!8,title=${title}]\n${body}\n\\end{tcolorbox}\n\n`;
}
