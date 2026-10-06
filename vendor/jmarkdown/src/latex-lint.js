/*
	LaTeX-export lint: build warnings for what renders in HTML but breaks — or
	silently mangles — a real LaTeX export. They join the build's warning
	summary (warnings.js), which watch mode and Clew show as a banner, so an
	author hears about it while writing, not at export time. Every build runs it,
	HTML included: that is the point.

	Each warning has a short code, and `Silence warnings: <code>, …` (header or
	config) turns those off; `latex-export` turns them all off.

	  dollars       `$5 and $10`: the dollars pair up as maths ("5 and " typeset,
	                in HTML too), and a lone `$` with no partner leaves LaTeX in
	                maths to the end of the paragraph ("Missing $ inserted").
	                Escaped, `\$5` prints a dollar sign in both (escapes.js).
	  display-math  `\begin{align*}` (or gather, multline, equation, …) inside
	                `$$ … $$`, `\[ … \]` or `$ … $`: MathJax takes it, LaTeX stops
	                ("Erroneous nesting of equation structures"). The environment
	                works bare, with no wrapper, in both.
	  mathjax-only  `\require`, `\bbox`, `\enclose`, `\class`, … — MathJax
	                extensions with no LaTeX meaning: an undefined control sequence.
	  package       maths a package must define — `\mathbb`, `\text`,
	                `\begin{cases}`, `\blacksquare`, `\cancel`, `\mathscr` — in a
	                document that loads nothing providing it. MathJax has all of
	                them built in; LaTeX has none. Checked at the END of a build
	                (checkMathPackages), when what the preamble will hold is known.
	  backslash     a Windows path in prose — `C:\Users\me` — whose backslashes
	                LaTeX reads as commands. Only path shapes: a single `\word`
	                may be LaTeX the author meant.
	  braces        an unmatched `{` or `}` in prose ("Too many }'s"). Matched
	                braces compile (as an invisible group) and are left alone.

	Kept to what is certain to go wrong, so a warning is worth reading: no
	guesses about prose, nothing in code, maths contents only where MathJax
	and LaTeX are known to part. A `\newcommand` / `\def` /
	`\DeclareMathOperator` the document makes (in its maths, `Math macros` or
	`LaTeX preamble`) is its own, never "a package's".

	Registered in index.js as a walkTokens hook on the main parser, with
	resetLatexLint() beside resetWarnings(); checkMathPackages() is called by
	post-processor.js (HTML) and latex-template.js (a full LaTeX document — a
	fragment's preamble is its host's, so a fragment build checks nothing).
*/

import { configManager } from './config-manager.js';
import { addWarning, getWarnings } from './warnings.js';
import { MATH_PACKAGE_COMMANDS } from './math-packages.js';
import { bookPreamble, bookMathMacros } from './book.js';

/* --- silencing ------------------------------------------------------------------ */

const listOf = (value) => (Array.isArray(value) ? value : [value ?? ''])
	.flatMap((v) => String(v).split(/[\s,]+/))
	.map((v) => v.trim().toLowerCase())
	.filter(Boolean);

function silenced(code) {
	const quiet = new Set([
		...listOf(configManager.get('Silence warnings')),
		...listOf(configManager.get('Silence_warnings')),
	]);
	return quiet.has(code) || quiet.has('latex-export');
}

function warn(code, message) {
	if (silenced(code)) return;
	const text = `latex-export [${code}]: ${message}`;
	if (!getWarnings().includes(text)) addWarning(text);
}

const clip = (s, n = 40) => {
	const one = String(s).replace(/\s+/g, ' ').trim();
	return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/* --- what the maths uses ---------------------------------------------------------- */

const DISPLAY_ENVS = new Set([
	'align', 'align*', 'alignat', 'alignat*', 'gather', 'gather*', 'multline', 'multline*',
	'flalign', 'flalign*', 'equation', 'equation*', 'eqnarray', 'eqnarray*', 'displaymath',
]);

// MathJax's own extensions, which no LaTeX package defines.
const MATHJAX_ONLY = new Set([
	'require', 'bbox', 'enclose', 'unicode', 'class', 'style', 'cssId',
	'toggle', 'begintoggle', 'endtoggle', 'mmlToken', 'texttip', 'mathtip',
]);

// Packages MathJax autoloads beyond the AMS set, by the commands that need them.
const SMALL_PACKAGES = {
	cancel: ['cancel', 'bcancel', 'xcancel', 'cancelto'],
	mathrsfs: ['mathscr'],
	bm: ['bm'],
	xcolor: ['color', 'textcolor', 'colorbox', 'fcolorbox'],
	mhchem: ['ce', 'pu'],
};
const NEEDS = new Map();   // command (or `end` + environment) → [packages]
for (const [pkg, names] of [...Object.entries(MATH_PACKAGE_COMMANDS), ...Object.entries(SMALL_PACKAGES)]) {
	for (const name of names) NEEDS.set(name, [...(NEEDS.get(name) || []), pkg]);
}

// What else provides each package's commands. Maths font packages define the
// AMS symbols themselves (and clash with amssymb), so they count as all three.
const MATH_FONTS = ['newtxmath', 'newpxmath', 'unicode-math', 'stix', 'stix2', 'mathabx', 'kpfonts',
	'fourier', 'mathdesign', 'libertinust1math', 'lucidabr', 'mtpro2', 'fdsymbol', 'MnSymbol', 'txfonts', 'pxfonts'];
const PROVIDED_BY = {
	amsmath: ['amsmath', 'mathtools', 'empheq'],
	mathtools: ['mathtools', 'empheq'],
	amsfonts: ['amsfonts', 'amssymb', ...MATH_FONTS],
	amssymb: ['amssymb', ...MATH_FONTS],
	latexsym: ['latexsym', 'amsfonts', 'amssymb', ...MATH_FONTS],
	cancel: ['cancel'],
	mathrsfs: ['mathrsfs'],
	bm: ['bm'],
	xcolor: ['xcolor', 'color', 'tcolorbox', 'tikz', 'pgf'],
	mhchem: ['mhchem'],
};
const CLASS_LOADS = {
	amsart: ['amsmath', 'amsfonts'], amsbook: ['amsmath', 'amsfonts'], amsproc: ['amsmath', 'amsfonts'],
	beamer: ['amsmath', 'amssymb'],
};

// The build's record: what its maths uses, and what it defines itself.
let used = new Map();      // name → an example of it, for the message
let defined = new Set();
let loadedByUse = new Set();   // packages the engine will load for what it saw

export function resetLatexLint() {
	used = new Map();
	defined = new Set();
	loadedByUse = new Set();
}

function definitions(text) {
	for (const m of String(text).matchAll(/\\(?:re)?newcommand\*?\s*\{?\\([A-Za-z]+)|\\def\s*\\([A-Za-z]+)|\\DeclareMathOperator\*?\s*\{\\([A-Za-z]+)/g)) {
		defined.add(m[1] || m[2] || m[3]);
	}
}

// One piece of maths: `wrapper` names its delimiters when it is a display or
// inline formula ($$, \[, $), and is null for an environment of its own.
function lintMath(text, wrapper) {
	const source = String(text);
	definitions(source);
	for (const m of source.matchAll(/\\begin\s*\{([A-Za-z]+\*?)\}/g)) {
		const env = m[1];
		if (wrapper && DISPLAY_ENVS.has(env)) {
			warn('display-math', `\\begin{${env}} inside ${wrapper} — LaTeX stops ("Erroneous nesting of equation structures"); write the environment on its own, without the ${wrapper}`);
		}
		if (!used.has(`end${env}`)) used.set(`end${env}`, `\\begin{${env}}`);
	}
	for (const m of source.matchAll(/\\([A-Za-z]+)/g)) {
		const name = m[1];
		if (MATHJAX_ONLY.has(name) && !defined.has(name)) {
			warn('mathjax-only', `\\${name} is MathJax's, not LaTeX's — undefined in a LaTeX export ("${clip(source)}")`);
		}
		if (!used.has(name)) used.set(name, `\\${name}`);
	}
}

const WRAPPERS = { dollar: '$$ … $$', bracket: '\\[ … \\]' };

/* --- the walk ----------------------------------------------------------------------- */

// A leaf of prose: a stray `$`, a Windows path.
function lintText(text) {
	const s = String(text);
	if (s.includes('$')) {
		const at = s.indexOf('$');
		warn('dollars', `a lone "$" ("${clip(s.slice(Math.max(0, at - 15), at + 20))}") starts maths in LaTeX that never ends — write \\$ for a dollar sign`);
	}
	const path = /(?:\b[A-Za-z]:\\|[\w.-]\\[\w.-]+\\)[^\s]*/.exec(s);
	if (path) {
		warn('backslash', `"${clip(path[0])}" — LaTeX reads each \\name in it as a command; escape the backslashes (\\\\) or put the path in \`code\``);
	}
}

// The children of a paragraph, heading, cell, …: dollar amounts read as maths
// (they need the token AFTER the maths), and braces that do not match.
function lintInline(tokens) {
	let depth = 0;
	let unmatched = null;
	tokens.forEach((token, i) => {
		if (token.type === 'latex' && !token.block) {
			const next = tokens[i + 1]?.raw ?? '';
			if (/^\s*\d/.test(token.text) && (/\s$/.test(token.text) || /^\d/.test(next))) {
				warn('dollars', `"${clip(token.raw + next.slice(0, 3))}" is read as maths — two dollar amounts? Write \\$ for a dollar sign`);
			}
		}
		if (token.type === 'text' && !token.tokens) {
			for (const c of String(token.text)) {
				if (c === '{') depth++;
				else if (c === '}' && --depth < 0 && !unmatched) unmatched = '}';
			}
		}
	});
	if (!unmatched && depth > 0) unmatched = '{';
	if (unmatched) {
		const prose = tokens.map((t) => t.raw ?? '').join('');
		warn('braces', `an unmatched "${unmatched}" in "${clip(prose)}" — LaTeX stops on it; write \\${unmatched}`);
	}
}

export function latexLint(token) {
	switch (token.type) {
	case 'latex':
		lintMath(token.text, token.raw.startsWith('\\[') ? '\\[ … \\]'
			: token.raw.startsWith('\\(') ? '\\( … \\)'
			: token.block ? '$$ … $$' : '$ … $');
		break;
	case 'mathBlock':
		lintMath(token.text, WRAPPERS[token.math] ?? null);
		break;
	case 'beginEnd':
		if (token.name === 'equation') {
			loadedByUse.add('amsmath');   // equations.js loads it
			lintMath(token.rawText, '@begin(equation)');
		}
		if (token.name === 'TiKZ') loadedByUse.add('tikz');
		break;
	case 'calloutBlock':
		loadedByUse.add('tcolorbox');   // callout-latex.js draws them with it
		break;
	case 'text':
		if (!token.tokens) lintText(token.text);
		break;
	case 'table':
		for (const cell of [...token.header, ...token.rows.flat()]) if (cell.tokens) lintInline(cell.tokens);
		break;
	default:
		break;
	}
	if (Array.isArray(token.tokens) && token.tokens.length) lintInline(token.tokens);
}

/* --- the end of the build: packages ------------------------------------------------- */

// The packages \usepackage / \RequirePackage lines name.
function packagesIn(lines) {
	return (Array.isArray(lines) ? lines : [lines ?? ''])
		.flatMap((line) => [...String(line).matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)])
		.flatMap((m) => m[1].split(',').map((p) => p.trim()).filter(Boolean));
}

/**
 * Warn for each package the document's maths needs and nothing loads. `loaded`
 * adds what the engine's own preamble holds (latex-template.js passes the
 * required packages); config supplies the rest — `Packages`, `LaTeX
 * preamble`, `Document class`, and `Math macros` (which loads amsmath and
 * amssymb, for MathJax parity).
 */
export function checkMathPackages(loaded = []) {
	const meta = (key) => configManager.getMeta(key);
	const have = new Set([...loaded, ...loadedByUse]);
	// In a book, what its chapters add to the one preamble counts too (book.js).
	const chapters = bookPreamble();
	for (const p of [...listOf(meta('Packages')), ...listOf(chapters.packages)]) have.add(p);
	for (const p of [...packagesIn(meta('LaTeX preamble')), ...packagesIn(chapters.preamble)]) have.add(p);
	for (const p of CLASS_LOADS[String(meta('Document class') ?? '').trim()] ?? []) have.add(p);
	const macros = meta('Math macros') || [];
	if ((Array.isArray(macros) ? macros : [macros]).some((line) => String(line).trim())) {
		have.add('amsmath');
		have.add('amssymb');
		for (const line of Array.isArray(macros) ? macros : [macros]) definitions(line);
	}
	for (const line of Array.isArray(meta('LaTeX preamble')) ? meta('LaTeX preamble') : [meta('LaTeX preamble') ?? '']) definitions(line);
	for (const line of chapters.preamble) definitions(line);
	// A book's chapters define their own macros at their starts (book.js).
	const chapterMacros = bookMathMacros();
	if (chapterMacros.length) {
		have.add('amsmath');
		have.add('amssymb');
		for (const line of chapterMacros) definitions(line);
	}

	const missing = new Map();   // package to suggest → [examples]
	for (const [name, example] of used) {
		const packages = NEEDS.get(name);
		if (!packages || defined.has(name)) continue;
		if (packages.some((pkg) => (PROVIDED_BY[pkg] ?? [pkg]).some((p) => have.has(p)))) continue;
		// amssymb loads amsfonts, so it is the one to name for either.
		const suggest = packages.includes('amsfonts') || packages.includes('amssymb') ? 'amssymb' : packages[0];
		if (!missing.has(suggest)) missing.set(suggest, []);
		missing.get(suggest).push(example);
	}
	for (const [pkg, examples] of missing) {
		const shown = examples.slice(0, 5).join(', ') + (examples.length > 5 ? `, and ${examples.length - 5} more` : '');
		warn('package', `${shown} need${examples.length === 1 ? 's' : ''} the ${pkg} package, which a LaTeX export of this document does not load — add \`Packages: ${pkg}\``);
	}
	resetLatexLint();
}
