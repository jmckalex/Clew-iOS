/*
	`LaTeX highlighter: highlight.js` — code in LaTeX without minted (the owner,
	2026-10-20: Clew's iPad PDFs, "coloured like the Mac's").

	minted highlights through Pygments, a Python program LaTeX runs while it
	compiles (shell escape, or TeX Live's restricted list). A TeX with no Python
	and no shell — mp-tikz-wasm's, which typesets Clew's PDFs on the iPad — cannot
	run it. Under this key the code is coloured here instead, by highlight.js (the
	highlighter the HTML already uses), in the colours of Pygments' `default`
	style (minted's), and set as minted sets it:

	- a block in fvextra's Verbatim with commandchars \ { } — what minted's own
	  output is — each piece of code in \textcolor, \textbf and \textit, as
	  Pygments' LaTeX formatter writes them (colour outermost);
	- inline code in \texttt, the same colours, every special written as a
	  command: no verbatim, so it works in a heading, a note, a title, where
	  \mintinline's delimiters break.

	Colours are \textcolor[HTML]{…}: fancyvrb makes the comma active inside
	Verbatim (no `,,` ligature), so an [rgb]{r,g,b} written there would not
	parse — and with no colour of our own to define, a --fragment needs nothing
	but fvextra and xcolor. Nothing here needs shell escape. A document loads
	fvextra and xcolor, and minted's listing float (the float package) for
	@begin(listing) and {{LOL}} (latex-template.js, minted's six lines) — never
	minted itself.

	The two highlighters read code differently, so the colours are Pygments' but
	the reading is highlight.js's, nudged towards Pygments' where it is cheap
	(LANGUAGE_SCOPES, OPERATORS): operators are greyed in Python, JavaScript,
	TypeScript, Java and C, and print black elsewhere; a string's escapes
	print in the string's colour. The default, `minted`, is code as it always
	was (latex-renderer.js).
*/

import hljs from 'highlight.js';
import { configManager } from './config-manager.js';
import { requirePackage, addPreamble } from './preamble.js';
import { addWarning, getWarnings } from './warnings.js';

const HIGHLIGHTERS = ['minted', 'highlight.js'];

// Whether code is highlighted here. An unknown value is the default, warned.
export function highlightsCode() {
	const value = String(configManager.get('LaTeX highlighter') ?? 'minted').trim().toLowerCase();
	if (!HIGHLIGHTERS.includes(value)) {
		const message = `LaTeX highlighter: "${value}" is not one of ${HIGHLIGHTERS.join(', ')} — code is set with minted`;
		if (!getWarnings().includes(message)) addWarning(message);
	}
	return value === 'highlight.js';
}

// Pygments' `default` style (pygments/styles/default.py, 2.19, as TeX Live's
// latexminted ships it), each token type as minted prints it. Its LaTeX gives a
// token its parents' styles and then its own (\PYG{k+kt}{int}), and a `noitalic`
// or `nobold` writes nothing, so Comment.Preproc keeps Comment's italic and
// Keyword.Type Keyword's bold, as they do not in Pygments' HTML.
const PYGMENTS = {
	comment:      { color: '3D7B7B', italic: true },   // Comment
	preproc:      { color: '9C6500', italic: true },   // Comment.Preproc
	keyword:      { color: '008000', bold: true },     // Keyword (and .Constant, .Declaration, …)
	keywordType:  { color: 'B00040', bold: true },     // Keyword.Type
	operator:     { color: '666666' },                 // Operator
	operatorWord: { color: 'AA22FF', bold: true },     // Operator.Word
	builtin:      { color: '008000' },                 // Name.Builtin (and .Pseudo: self, this)
	function:     { color: '0000FF' },                 // Name.Function
	class:        { color: '0000FF', bold: true },     // Name.Class
	namespace:    { color: '0000FF', bold: true },     // Name.Namespace
	variable:     { color: '19177C' },                 // Name.Variable
	constant:     { color: '880000' },                 // Name.Constant
	entity:       { color: '717171', bold: true },     // Name.Entity
	attribute:    { color: '687822' },                 // Name.Attribute
	tag:          { color: '008000', bold: true },     // Name.Tag
	decorator:    { color: 'AA22FF' },                 // Name.Decorator
	string:       { color: 'BA2121' },                 // String
	doc:          { color: 'BA2121', italic: true },   // String.Doc
	escape:       { color: 'AA5D1F', bold: true },     // String.Escape
	regex:        { color: 'A45A77' },                 // String.Regex
	symbol:       { color: '19177C' },                 // String.Symbol
	number:       { color: '666666' },                 // Number
	heading:      { color: '000080', bold: true },     // Generic.Heading
	deleted:      { color: 'A00000' },                 // Generic.Deleted
	inserted:     { color: '008400' },                 // Generic.Inserted
	emph:         { italic: true },                    // Generic.Emph
	strong:       { bold: true },                      // Generic.Strong
	plain:        null,
};

// highlight.js's scopes, as the Pygments token type that colours the same thing.
// A scope not listed takes its parent's colour (highlight.js nests them: a
// tag's name inside the tag).
const SCOPES = {
	'keyword': 'keyword',
	'built_in': 'builtin',
	'type': 'keywordType',
	'literal': 'keyword',                  // True, None, null: Keyword.Constant
	'number': 'number',
	'operator': 'operator',
	'string': 'string',
	'regexp': 'regex',
	'symbol': 'symbol',
	'char.escape_': 'escape',
	'subst': 'plain',                      // the code in ${…}: Pygments colours it as code
	'comment': 'comment',
	'meta': 'preproc',
	'title': 'function',
	'title.function_': 'function',
	'title.function_.invoke__': 'plain',
	'title.class_': 'class',
	'title.class_.inherited__': 'plain',
	'variable': 'variable',
	'variable.language_': 'builtin',
	'variable.constant_': 'constant',
	'attr': 'attribute',
	'attribute': 'attribute',
	'name': 'tag',
	'selector-tag': 'tag',
	'selector-class': 'class',
	'selector-id': 'namespace',
	'selector-pseudo': 'decorator',
	'section': 'heading',
	'bullet': 'keyword',
	'emphasis': 'emph',
	'strong': 'strong',
	'addition': 'inserted',
	'deletion': 'deleted',
	'quote': 'emph',
	'link': 'attribute',
	'code': 'string',
	'template-tag': 'preproc',
	'template-variable': 'variable',
};

// Where a language's Pygments lexer reads a scope otherwise: a type, or a
// function of the text and { lineStart (only spaces before it on its line),
// scopes (the scopes it is in) }. Pygments' JavaScript colours no names,
// defined or called, nor an object's keys; its Python reads a triple-quoted
// string that starts a line as a docstring; its YAML colours a quoted scalar
// alone; its C reads a preprocessor line as one, and a library function as
// any name.
const JAVASCRIPT_SCOPES = {
	'meta': 'decorator',
	'title.function_': 'plain',
	'title.class_': 'plain',
	'attr': 'plain',
};
const C_SCOPES = {
	'keyword': (text, { scopes }) => (scopes.includes('meta') ? 'preproc' : 'keyword'),
	'string': (text, { scopes }) => (scopes.includes('meta') ? 'comment' : 'string'),   // <stdio.h>: Comment.PreprocFile
	'built_in': 'plain',
};
const LANGUAGE_SCOPES = {
	python: {
		meta: 'decorator',                 // @decorator
		string: (text, { lineStart }) => (lineStart && /^("""|''')/.test(text) ? 'doc' : 'string'),
	},
	javascript: JAVASCRIPT_SCOPES,
	typescript: JAVASCRIPT_SCOPES,
	java:       { meta: 'decorator' },     // @Override
	c:          C_SCOPES,
	cpp:        C_SCOPES,
	bash:       { meta: 'comment' },       // #!/bin/bash: Comment.Hashbang
	json:       { attr: 'tag' },           // a key
	yaml:       { attr: 'tag', string: (text) => (/^["']/.test(text) ? 'string' : 'plain') },
	xml:        { symbol: 'entity', keyword: 'preproc' },   // &amp;, <!DOCTYPE html>
	markdown:   { string: 'tag' },         // a link's text
};

// Keywords Pygments reads as Operator.Word.
const OPERATOR_WORDS = {
	python:     ['and', 'or', 'not', 'in', 'is'],
	javascript: ['typeof', 'instanceof', 'in', 'void', 'delete', 'new'],
	typescript: ['typeof', 'instanceof', 'in', 'void', 'delete', 'new'],
};

// What Pygments reads as Operator, greyed, where highlight.js marks nothing:
// in text with no colour of its own. (Python's `.` is an operator; C's,
// Java's and JavaScript's is punctuation, as Python's `:` is.)
const C_OPERATORS = /[-~!%^&*+=|?:<>/]+/g;
const OPERATORS = {
	python:     /[-~!%^&*+=|<>/.@]+/g,
	javascript: C_OPERATORS,
	typescript: C_OPERATORS,
	java:       C_OPERATORS,
	c:          C_OPERATORS,
	cpp:        C_OPERATORS,
};

// A fence's language as highlight.js names it (`js` → `javascript`), or null
// for none it knows and for plain text: as minted, the first word of the info
// string, else `Code language`.
const languageNames = new Map();
function languageOf(lang) {
	const name = String(lang ?? '').trim().split(/\s+/)[0] || configManager.get('Code language') || 'text';
	if (!languageNames.has(name)) {
		const definition = hljs.getLanguage(name);
		const key = definition ? hljs.listLanguages().find((k) => hljs.getLanguage(k) === definition) : null;
		languageNames.set(name, key === 'plaintext' ? null : key ?? null);
	}
	return languageNames.get(name);
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'" };

// The code as pieces of one colour each: { text, style } (style null: none).
function pieces(code, lang) {
	const language = languageOf(lang);
	if (!language) return [{ text: code, style: null }];
	const html = hljs.highlight(code, { language }).value;
	const result = [];
	const scopes = [];
	let line = '';   // the current line, so far
	for (const m of html.matchAll(/<span class="([^"]*)">|<\/span>|[^<]+/g)) {
		if (m[1] !== undefined) scopes.push(m[1].split(' ').map((c) => c.replace(/^hljs-/, '')).join('.'));
		else if (m[0] === '</span>') scopes.pop();
		else {
			const text = m[0].replace(/&(?:amp|lt|gt|quot|#x27);/g, (e) => ENTITIES[e]);
			const style = styleOf(scopes, language, text, !line.trim());
			if (style || !OPERATORS[language]) result.push({ text, style });
			else {
				let at = 0;
				for (const op of text.matchAll(OPERATORS[language])) {
					result.push({ text: text.slice(at, op.index), style: null }, { text: op[0], style: PYGMENTS.operator });
					at = op.index + op[0].length;
				}
				result.push({ text: text.slice(at), style: null });
			}
			line = (line + text).split('\n').pop();
		}
	}
	// Neighbours of one colour as one piece, as Pygments merges its tokens.
	return result.filter((piece) => piece.text).reduce((merged, piece) => {
		const last = merged.at(-1);
		if (last && last.style === piece.style) last.text += piece.text;
		else merged.push({ ...piece });
		return merged;
	}, []);
}

function styleOf(scopes, language, text, lineStart) {
	const context = { lineStart, scopes };
	for (let i = scopes.length - 1; i >= 0; i--) {
		const entry = LANGUAGE_SCOPES[language]?.[scopes[i]] ?? SCOPES[scopes[i]];
		const name = typeof entry === 'function' ? entry(text, context) : entry;
		if (name === undefined) continue;
		if (name === 'keyword' && OPERATOR_WORDS[language]?.includes(text)) return PYGMENTS.operatorWord;
		return PYGMENTS[name];
	}
	return null;
}

// Text in its colour, bold and italic, nested as Pygments nests them.
function styled(text, style) {
	if (!style || !text) return text;
	requirePackage('xcolor');
	let out = text;
	if (style.bold) out = `\\textbf{${out}}`;
	if (style.italic) out = `\\textit{${out}}`;
	if (style.color) out = `\\textcolor[HTML]{${style.color}}{${out}}`;
	return out;
}

// A fenced block. Inside Verbatim, commandchars leaves only \ { } to write as
// commands — as the character itself in the current font, as Pygments writes
// them (\char`\\), so the typewriter's own glyph prints. Each piece is split at
// its line ends: an argument cannot run across a Verbatim line.
export function codeBlockLatex(code, lang) {
	requirePackage('fvextra');
	const lines = [''];
	for (const { text, style } of pieces(code, lang)) {
		text.split('\n').forEach((part, i) => {
			if (i > 0) lines.push('');
			const written = part.replace(/[\\{}]/g, (c) => `\\char${c.charCodeAt(0)}{}`);
			lines[lines.length - 1] += styled(written, style);
		});
	}
	return `\\begin{Verbatim}[commandchars=\\\\\\{\\}]\n${lines.join('\n')}\n\\end{Verbatim}\n\n`;
}

// Inline code's specials as commands that print the ASCII character, which the
// hyperref bookmark of a heading reads too. Quotes straight, as upquote prints
// them in minted's inline code.
const INLINE_SPECIALS = {
	'\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '$': '\\$', '&': '\\&', '#': '\\#',
	'^': '\\textasciicircum{}', '_': '\\_', '%': '\\%', '~': '\\textasciitilde{}',
	'<': '\\textless{}', '>': '\\textgreater{}', '|': '\\textbar{}',
	"'": '\\textquotesingle{}', '`': '\\textasciigrave{}',
};

// Inline code's text as LaTeX. The typewriter font of a T1 document makes
// ligatures of -- ,, << >> (– „ « »), which minted's verbatim never does: an
// italic correction between the two breaks them, in pdfTeX and LuaTeX alike
// (`{}` does not, in LuaTeX), and a bookmark reads nothing for it. A run of
// spaces keeps its width, as in minted's: each after the first is `\ `.
function inlineText(text) {
	let out = '';
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		out += INLINE_SPECIALS[c] ?? c;
		if ('-,<>'.includes(c) && text[i + 1] === c) out += '\\/';
	}
	return out.replace(/ {2,}/g, (run) => ` ${'\\ '.repeat(run.length - 1)}`);
}

// Inline code, in `Code language` (latex-renderer.js passes it).
export function inlineCodeLatex(code, lang) {
	let body = '';
	for (const { text, style } of pieces(code, lang)) body += styled(inlineText(text), style);
	return `\\texttt{${body}}`;
}

// minted's listing float and its list, as minted.sty defines them by default
// (the float package; its `newfloat` and `chapter` options are never given):
// for a document that asked minted for them (latex-template.js).
export function mintedListingFloat() {
	requirePackage('float');
	addPreamble('\\newfloat{listing}{tbp}{lol}');
	addPreamble('\\newcommand{\\listingscaption}{Listing}');
	addPreamble('\\floatname{listing}{\\listingscaption}');
	addPreamble('\\newcommand{\\listoflistingscaption}{List of Listings}');
	addPreamble('\\providecommand{\\listoflistings}{\\listof{listing}{\\listoflistingscaption}}');
}
