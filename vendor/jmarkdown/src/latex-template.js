/*
	LaTeX document assembly — the peer of html-template.js.

	processLatexTemplate() wraps the rendered body in a complete, compilable
	document: \documentclass + an assembled preamble + frontmatter (\maketitle
	from Title/Author/Date, unless the body prints its own title) + the body +
	\end{document}. The --fragment path in
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
import { assemblePreamble, requirePackage, addPreamble, addLatePreamble, requiredPackageNames, dropPackage } from './preamble.js';
import { checkMathPackages } from './latex-lint.js';
import { getBook, bookPreamble, warnPreambleClashes } from './book.js';
import { escapeArgumentPercent, escapeLatexText } from './latex-escape.js';
import { bodyPrintsTitle, bodyTitleBlockText } from './additional-directives.js';
import { highlightsCode, mintedListingFloat } from './latex-highlight.js';
import { addWarning } from './warnings.js';

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

/*
	`LaTeX T1 fonts` (config or host only, default off; the owner, 2026-10-20 —
	Clew's iPad, whose TeX has no cm-super): `lmodern` loads lmodern after a
	pdfLaTeX document's \usepackage[T1]{fontenc}, so its text is set in Latin
	Modern's Type 1 fonts rather than the EC fonts, which without cm-super
	come out as bitmaps (Type 3). The Unicode engines (fontspec) are not
	touched; nor is a document that loads lmodern itself (preamble.js). Any
	other value is warned and ignored. A header's is ignored (config-manager.js
	mergeMetadata): it can neither set the key nor clear it.
*/
function t1Fonts() {
	const value = configManager.get('LaTeX T1 fonts');
	if (value == null || value === false || String(value).trim() === '') return null;
	if (String(value).trim().toLowerCase() === 'lmodern') return 'lmodern';
	addWarning(`LaTeX T1 fonts: "${value}" is not lmodern — ignored`);
	return null;
}

export function processLatexTemplate(content) {
	const meta = (key) => configManager.getMeta(key);

	const docClass = asString(meta('Document class')) || 'article';
	const classOptions = asString(meta('Class options'));
	const engine = (asString(meta('LaTeX engine')) || 'pdflatex').toLowerCase();
	// A book's chapters add their Packages and LaTeX preamble after the
	// master's, each once; a definition that clashes is warned and left out.
	const chapters = bookPreamble();
	warnPreambleClashes();
	const userPackages = [...asList(meta('Packages')), ...chapters.packages];
	const userPreamble = [...asList(meta('LaTeX preamble')), ...chapters.preamble];

	const documentclass = classOptions
		? `\\documentclass[${classOptions}]{${docClass}}`
		: `\\documentclass{${docClass}}`;

	// Title / Author / Date — plain-text metadata (not markdown-parsed), so escape
	// the prose specials &/# before they hit \title{} / \hypersetup{}, and a
	// `%`, which in those arguments was a comment and stopped the build.
	const title = escapeArgumentPercent(escapeLatexText(asString(meta('Title'))));
	const author = escapeArgumentPercent(escapeLatexText(asString(meta('Author'))));
	const date = escapeArgumentPercent(escapeLatexText(asString(meta('Date'))));

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
	// Under `LaTeX maketitle`, a header with no Title takes the body's title
	// block's, as text (the owner, 2026-10-20).
	requirePackage('hyperref');
	const pdf = [];
	const pdfTitle = title || (configManager.get('LaTeX maketitle') === true ? bodyTitleBlockText(content) : '');
	if (pdfTitle) pdf.push(`pdftitle={${pdfTitle}}`);
	if (author) pdf.push(`pdfauthor={${author}}`);
	if (pdf.length) addLatePreamble(`\\hypersetup{${pdf.join(', ')}}`, 'hyperref');

	// A book numbered `continuous`: the book class numbers figures, tables and
	// equations per chapter, so take them out of it (listings too, when minted
	// defined their counter). Footnotes stay per chapter, as the HTML lists them.
	// Numbering per chapter, the default: the class already does so for those,
	// but minted's listing counter runs on — put it within the chapter, as the
	// HTML numbers it (Listing 2.1).
	const book = getBook();
	if (book && book.numbering === 'continuous') {
		addPreamble('\\counterwithout{figure}{chapter}\\counterwithout{table}{chapter}\\counterwithout{equation}{chapter}');
		addPreamble('\\AtBeginDocument{\\ifcsname c@listing\\endcsname\\counterwithout{listing}{chapter}\\fi}');
	} else if (book) {
		addPreamble('\\AtBeginDocument{\\ifcsname c@listing\\endcsname\\counterwithin{listing}{chapter}\\fi}');
	}

	// `LaTeX highlighter: highlight.js` loads no minted, which needs a shell:
	// what a document asked minted for besides its code — @begin(listing)'s
	// float, {{LOL}}'s \listoflistings — comes from minted's own definitions.
	if (highlightsCode() && dropPackage('minted')) mintedListingFloat();

	// Every package the document will load is known now: warn for maths that
	// needs one it won't (latex-lint.js).
	checkMathPackages(requiredPackageNames());

	const preamble = assemblePreamble({ engine, userPackages, userPreamble, t1Fonts: t1Fonts() });

	// Frontmatter — no Title → no \maketitle. A body that prints its own title
	// (`@title+`, additional-directives.js) gets no \maketitle either, as the
	// HTML shows that one title alone (the owner, 2026-10-11); \title, \author
	// and \date stay, for the PDF's metadata and a header that names the title.
	// Under `LaTeX maketitle` a Title with no Date gets \date{}: LaTeX would
	// print today's date, which the HTML does not show.
	const ownTitle = bodyPrintsTitle(content);
	let frontmatter = '';
	if (title) {
		frontmatter += `\\title{${title}}\n`;
		if (author) frontmatter += `\\author{${author}}\n`;
		if (date) frontmatter += `\\date{${date}}\n`;
		else if (configManager.get('LaTeX maketitle') === true) frontmatter += '\\date{}\n';
		frontmatter += ownTitle ? '\n' : '\\maketitle\n\n';
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
