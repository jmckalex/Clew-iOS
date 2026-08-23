/*
	LaTeX document assembly — the peer of html-template.js.

	processLatexTemplate() wraps the rendered body in a complete, compilable
	document: \documentclass + an assembled preamble + frontmatter (\maketitle
	from Title/Author/Date) + the body + \end{document}. The --fragment path in
	index.js bypasses this and emits the body alone.

	All substitutions in the .tex template use TRIPLE braces ({{{ }}}): Mustache
	HTML-escapes single-brace tags, which would corrupt LaTeX backslashes and
	ampersands. To sidestep brace-nesting entirely, structural lines like
	\documentclass[...]{...} are precomputed here and passed as single variables.
*/

import Mustache from 'mustache';
import fs from 'fs';
import path from 'path';
import { configManager } from './config-manager.js';
import { assemblePreamble, requirePackage, addPreamble, addLatePreamble } from './preamble.js';
import { escapeLatexText } from './latex-escape.js';

// Metadata values arrive as single-element arrays (from the metadata-header
// parser) or as strings (from config files / DEFAULT_CONFIG). Coerce to a
// trimmed string.
function asString(v) {
	if (v == null) return '';
	if (Array.isArray(v)) return v.join(' ').trim();
	return String(v).trim();
}

function asList(v) {
	if (v == null) return [];
	if (Array.isArray(v)) return v;
	return [v];
}

export function processLatexTemplate(content) {
	const meta = (key) => configManager.getMeta(key);

	const docClass = asString(meta('Document class')) || 'article';
	const classOptions = asString(meta('Class options'));
	const engine = (asString(meta('LaTeX engine')) || 'pdflatex').toLowerCase();
	const userPackages = asList(meta('Packages'));
	const userPreamble = asList(meta('LaTeX preamble'));

	const documentclass = classOptions
		? `\\documentclass[${classOptions}]{${docClass}}`
		: `\\documentclass{${docClass}}`;

	// Title / Author / Date — plain-text metadata (not markdown-parsed), so escape
	// the prose specials &/# before they hit \title{} / \hypersetup{}.
	const title = escapeLatexText(asString(meta('Title')));
	const author = escapeLatexText(asString(meta('Author')));
	const date = escapeLatexText(asString(meta('Date')));

	// --- Page setup (metadata → preamble); registered before assembly ---
	// Geometry (margins / paper): raw geometry options, e.g. "margin=1in".
	const geometry = asString(meta('Geometry'));
	if (geometry) requirePackage('geometry', geometry);

	// Line spacing: single | onehalf | double, or a numeric stretch factor.
	const lineSpacing = asString(meta('Line spacing')).toLowerCase();
	if (lineSpacing) {
		requirePackage('setspace');
		const preset = { single: '\\singlespacing', onehalf: '\\onehalfspacing', double: '\\doublespacing' }[lineSpacing];
		addPreamble(preset || `\\setstretch{${lineSpacing}}`);
	}

	// Running header / footer via fancyhdr (centre slot; author may use \thepage).
	const header = asString(meta('Header'));
	const footer = asString(meta('Footer'));
	if (header || footer) {
		requirePackage('fancyhdr');
		addPreamble('\\pagestyle{fancy}');
		addPreamble('\\fancyhf{}');
		if (header) addPreamble(`\\fancyhead[C]{${header}}`);
		addPreamble(`\\fancyfoot[C]{${footer || '\\thepage'}}`);
	}

	// Math macros (`Math macros` key): the same raw \newcommand lines the HTML
	// build injects for MathJax become preamble definitions here. Registered
	// as raw preamble lines, so they precede the user `LaTeX preamble` (which
	// may build on them). One source for both outputs — no drift.
	const mathMacros = configManager.get('Math macros') || [];
	if (mathMacros.length) {
		// Parity: MathJax loads its `ams` package by default, so the macro
		// language available on the web side includes \DeclareMathOperator,
		// \mathbb, and friends — the LaTeX side must offer the same
		// vocabulary (amsmath + amssymb together ≈ MathJax's `ams`) or
		// identical definitions would compile in one output only.
		requirePackage('amsmath');
		requirePackage('amssymb');
		for (const line of mathMacros) addPreamble(line);
	}

	// hyperref for every full document: clickable refs/ToC + PDF bookmarks, plus
	// PDF metadata from Title/Author. (cleveref, when used, still loads after it.)
	requirePackage('hyperref');
	const pdf = [];
	if (title) pdf.push(`pdftitle={${title}}`);
	if (author) pdf.push(`pdfauthor={${author}}`);
	if (pdf.length) addLatePreamble(`\\hypersetup{${pdf.join(', ')}}`);

	const preamble = assemblePreamble({ engine, userPackages, userPreamble });

	// Frontmatter — no Title → no \maketitle.
	let frontmatter = '';
	if (title) {
		frontmatter += `\\title{${title}}\n`;
		if (author) frontmatter += `\\author{${author}}\n`;
		if (date) frontmatter += `\\date{${date}}\n`;
		frontmatter += '\\maketitle\n\n';
	}

	const view = {
		Documentclass: documentclass,
		Preamble: preamble,
		Frontmatter: frontmatter,
		Content: content
	};

	const templatePath = path.join(
		configManager.get('Jmarkdown app directory'),
		'default-template.tex.mustache'
	);
	const template = fs.readFileSync(templatePath, 'utf8');
	return Mustache.render(template, view);
}
