// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ENGINE_TIKZ_LIBRARIES, UNBUNDLED_TIKZ_LIBRARIES, TiKZ, metapost,
	figureElement, latexFence, metapostFence, parseFigureAttrs, registerMetapostGrammar, showMode,
	texFence, tikzDirective, tikzFence, unwrapTikzJax, wrapLatex, wrapTex,
} from '../vendor/clew/engine/figures.js';
import { figureMatches, hasFigures } from '../vendor/clew/main/figure-bake.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---- attributes ------------------------------------------------------------

test('attribute tails: quoted, bare and flag forms', () => {
	assert.deepEqual(parseFigureAttrs(`libraries="arrows.meta,calc" border=4pt show-console`),
		{ libraries: 'arrows.meta,calc', border: '4pt', 'show-console': 'true' });
	assert.deepEqual(parseFigureAttrs(`{width='45%'}`), { width: '45%' });
	assert.deepEqual(parseFigureAttrs(''), {});
	assert.deepEqual(parseFigureAttrs(undefined), {});
});

test('a quoted value keeps its spaces and does not spill into new keys', () => {
	assert.deepEqual(parseFigureAttrs(`preamble="\\usepackage[T1]{fontenc} \\usepackage{lmodern}" border=1pt`),
		{ preamble: '\\usepackage[T1]{fontenc} \\usepackage{lmodern}', border: '1pt' });
});

// ---- the TikZJax dialect ---------------------------------------------------

test('a TikZJax body becomes a preamble and a picture', () => {
	const source = '\\usepackage{pgfplots}\n\\begin{document}\n\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}\n\\end{document}';
	const { source: body, attrs } = unwrapTikzJax(source, {});
	assert.equal(body, '\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}');
	assert.equal(attrs.preamble, '\\usepackage{pgfplots}');
});

test('an existing preamble attribute is kept, with the body preamble after it', () => {
	const source = '\\usepackage{amsmath}\n\\begin{document}\nx\n\\end{document}';
	const { attrs } = unwrapTikzJax(source, { preamble: '\\usetikzlibrary{fit}' });
	assert.equal(attrs.preamble, '\\usetikzlibrary{fit}\n\\usepackage{amsmath}');
});

test('a complete document and a plain picture both pass through untouched', () => {
	const complete = '\\documentclass{standalone}\n\\begin{document}\\tikz\\draw (0,0)--(1,1);\\end{document}';
	assert.equal(unwrapTikzJax(complete, {}).source, complete);
	assert.deepEqual(unwrapTikzJax(complete, {}).attrs, {});
	const plain = '\\draw (0,0) circle (1);';
	assert.equal(unwrapTikzJax(plain, {}).source, plain);
});

// ---- the emitted element ---------------------------------------------------

const attrOf = (html, name) => new RegExp(`${name}="([^"]*)"`).exec(html)?.[1] ?? null;

test('the element carries the source as text, escaped for an HTML parser', () => {
	const html = figureElement('tikz', '\\node {$a < b$ & more};');
	assert.match(html, /^<tikz-diagram /);
	assert.match(html, /\\node \{\$a &lt; b\$ &amp; more\};/);
	assert.match(html, /<\/tikz-diagram>\n$/);
});

test('mathjax_ignore is on the element: MathJax must not claim a $…$ in TikZ source', () => {
	assert.match(figureElement('tikz', '\\node {$x^2$};'), /class="mathjax_ignore"/);
	assert.match(figureElement('metapost', 'label(btex $\\pi$ etex, origin);'), /class="mathjax_ignore"/);
});

test('metapost source gets the metapost element', () => {
	assert.match(figureElement('metapost', 'draw fullcircle scaled 20;'), /^<metapost-diagram /);
});

test('library attributes pass through as data-*, presentation ones as style', () => {
	const html = figureElement('tikz', 'x', { libraries: 'calc', border: '4pt', width: '45%', scale: '2' });
	assert.equal(attrOf(html, 'data-libraries'), 'calc');
	assert.equal(attrOf(html, 'data-border'), '4pt');
	assert.match(attrOf(html, 'style'), /width: 45%/);
	assert.match(attrOf(html, 'style'), /transform: scale\(2\)/);
});

test('the native path’s own attributes are dropped, not passed on', () => {
	const html = figureElement('tikz', 'x', { embed: 'true', 'empty-cache': 'true', nonsense: '1' });
	assert.doesNotMatch(html, /data-embed|data-empty-cache|data-nonsense/);
});

test('an attribute value cannot break out of the attribute', () => {
	const html = figureElement('tikz', 'x', { alt: 'a "quoted" <caption>' });
	assert.equal(attrOf(html, 'data-alt'), 'a &quot;quoted&quot; &lt;caption&gt;');
});

test('data-fig-key tracks the figure: source, attributes, kind', () => {
	const key = (html) => attrOf(html, 'data-fig-key');
	const base = figureElement('tikz', '\\draw (0,0)--(1,1);');
	assert.equal(key(base), key(figureElement('tikz', '\\draw (0,0)--(1,1);')), 'same figure, same key');
	assert.notEqual(key(base), key(figureElement('tikz', '\\draw (0,0)--(2,2);')), 'changed source');
	assert.notEqual(key(base), key(figureElement('tikz', '\\draw (0,0)--(1,1);', { border: '4pt' })), 'changed attribute');
	assert.notEqual(key(base), key(figureElement('metapost', '\\draw (0,0)--(1,1);')), 'changed kind');
	assert.match(key(base), /^[0-9a-f]{12}$/);
});

// ---- fences ----------------------------------------------------------------

test('the tikz fence claims its own language and nothing that merely starts with it', () => {
	const fence = '```tikz\n\\draw (0,0) circle (1);\n```\n';
	assert.equal(tikzFence.start(fence), 0);
	assert.equal(tikzFence.tokenizer(fence).text, '\\draw (0,0) circle (1);');
	// ```tikzcd is a different language (tikz-cd matrices) and stays a code block.
	assert.equal(tikzFence.start('```tikzcd\nA \\to B\n```\n'), undefined);
	assert.equal(tikzFence.tokenizer('```tikzcd\nA \\to B\n```\n'), undefined);
	assert.equal(tikzFence.start('```tikzpicture\nx\n```\n'), undefined);
});

test('a fence info string carries attributes', () => {
	const token = tikzFence.tokenizer('```tikz libraries="arrows.meta" border=4pt\nx\n```\n');
	assert.deepEqual(token.figureAttrs, { libraries: 'arrows.meta', border: '4pt' });
	assert.match(tikzFence.renderer(token), /data-libraries="arrows.meta"/);
});

test('the metapost fence is its own language', () => {
	const token = metapostFence.tokenizer('```metapost\ndraw unitsquare scaled 40;\n```\n');
	assert.equal(token.text, 'draw unitsquare scaled 40;');
	assert.match(metapostFence.renderer(token), /^<metapost-diagram /);
	assert.equal(metapostFence.start('```metapostx\nx\n```\n'), undefined);
});

test('a fence keeps a blank line inside the figure', () => {
	const token = tikzFence.tokenizer('```tikz\n\\draw (0,0)--(1,1);\n\n\\draw (1,1)--(2,2);\n```\n');
	assert.equal(token.text, '\\draw (0,0)--(1,1);\n\n\\draw (1,1)--(2,2);');
});

// ---- the :::TiKZ directive -------------------------------------------------

test('the colon directive takes its body to the closing marker', () => {
	const src = ':::TiKZ\n\\draw (0,0)--(1,1);\n:::\n\nProse after.\n';
	assert.equal(tikzDirective.start(src), 0);
	const token = tikzDirective.tokenizer(src);
	assert.equal(token.text, '\\draw (0,0)--(1,1);');
	assert.ok(!token.raw.includes('Prose after'), 'the block ends at :::');
});

test('the colon directive reads an attribute tail on its opening line', () => {
	const token = tikzDirective.tokenizer(':::TiKZ{scale=2}\n\\draw (0,0)--(1,1);\n:::\n');
	assert.deepEqual(token.figureAttrs, { scale: '2' });
	assert.equal(token.text, '\\draw (0,0)--(1,1);');
});

test('a marker mid-line is not a directive (start must be a line start)', () => {
	assert.equal(tikzDirective.start('## The :::TiKZ directive\n\nprose\n'), undefined);
});

// ---- the @begin environments ----------------------------------------------

test('the environment handlers render the same element, verbatim body', () => {
	const html = TiKZ.html({ rawText: '\\draw (0,0)--(1,1);', attrs: { width: '30%' } });
	assert.match(html, /^<tikz-diagram /);
	assert.match(html, /\\draw \(0,0\)--\(1,1\);/);
	assert.match(attrOf(html, 'style'), /width: 30%/);
	assert.equal(TiKZ.mode, 'custom');
	assert.equal(metapost.mode, 'custom');
	assert.match(metapost.html({ rawText: 'draw fullcircle scaled 20;', attrs: {} }), /^<metapost-diagram /);
});

test('the directives keep the engine’s library promise, plus the author’s', () => {
	const libraries = attrOf(TiKZ.html({ rawText: 'x', attrs: { libraries: 'spy' } }), 'data-libraries').split(',');
	for (const lib of ENGINE_TIKZ_LIBRARIES.split(',')) {
		if (UNBUNDLED_TIKZ_LIBRARIES.has(lib)) continue;
		assert.ok(libraries.includes(lib), `${lib} is promised by :::TiKZ`);
	}
	assert.ok(libraries.includes('spy'), 'the author’s own library is added');
	assert.equal(new Set(libraries).size, libraries.length, 'no duplicates');
	// A fence promises nothing it was not asked for.
	assert.equal(attrOf(figureElement('tikz', 'x'), 'data-libraries'), null);
});

test('the library list still matches the engine it mirrors', () => {
	// vendor/jmarkdown/src/tikz.js is re-synced from the master wholesale, so
	// this is the one place a changed list would otherwise go unnoticed.
	const engine = fs.readFileSync(path.join(root, 'vendor', 'jmarkdown', 'src', 'tikz.js'), 'utf8');
	const declared = /const TIKZ_LIBRARIES = '([^']+)'/.exec(engine)?.[1];
	assert.ok(declared, 'the engine still declares TIKZ_LIBRARIES');
	assert.equal(ENGINE_TIKZ_LIBRARIES, declared,
		'src/engine/figures.js mirrors vendor/jmarkdown/src/tikz.js — re-check UNBUNDLED_TIKZ_LIBRARIES too');
});

test('every library the directives load is one the wasm bundle actually has', (t) => {
	// The staged engines (scripts/stage-mptikz.js) are not on every machine.
	const assets = process.env.CLEW_MPTIKZ_DIR
		?? [path.join(os.homedir(), 'Source', 'mp-tikz-wasm', 'dist'), path.join(root, 'mptikz-assets')]
			.find((dir) => fs.existsSync(path.join(dir, 'bundles')));
	if (!assets) return t.skip('no staged mp-tikz-wasm build to check against');
	const files = new Set();
	for (const entry of fs.readdirSync(path.join(assets, 'bundles'), { withFileTypes: true, recursive: true })) {
		if (entry.isFile()) files.add(entry.name);
	}
	const missing = ENGINE_TIKZ_LIBRARIES.split(',').filter((lib) =>
		!files.has(`tikzlibrary${lib}.code.tex`) && !files.has(`pgflibrary${lib}.code.tex`));
	// \usetikzlibrary failing takes the whole figure with it, so anything the
	// bundle lacks MUST be named in UNBUNDLED_TIKZ_LIBRARIES.
	assert.deepEqual(missing, [...UNBUNDLED_TIKZ_LIBRARIES],
		'the bundle’s libraries changed: update UNBUNDLED_TIKZ_LIBRARIES in src/engine/figures.js');
});

// ---- ```latex and ```tex ---------------------------------------------------

test('a complete latex document passes through as written, page numbers and all', () => {
	const doc = '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}';
	const { source, attrs } = wrapLatex(doc, { packages: 'booktabs', border: '4pt', alt: 'x' });
	assert.equal(source, doc, 'nothing is injected: a document that wants no folio says \\pagestyle{empty} itself');
	assert.deepEqual(attrs, { alt: 'x' }, 'the wrapper’s attributes are consumed either way; the rest are kept');
});

test('packages, preamble and border go into the wrapped document, not onto the element', () => {
	const html = figureElement('latex', 'x', { packages: 'booktabs, amsmath', preamble: '\\newtheorem{thm}{Theorem}', border: '5pt' });
	assert.match(html, /border=5pt/);
	assert.match(html, /\\usepackage\{amsmath,amssymb,booktabs\}/, 'deduplicated, the defaults first');
	assert.match(html, /\\newtheorem\{thm\}\{Theorem\}\n\\begin\{document\}/);
	assert.doesNotMatch(html, /data-packages|data-preamble|data-border/);
});

test('an explicit engine wins over the kind’s default', () => {
	assert.equal(attrOf(figureElement('latex', 'x', { engine: 'latex' }), 'data-engine'), 'latex');
	assert.equal(attrOf(figureElement('tex', 'x', { engine: 'plain' }), 'data-engine'), 'plain');
});

test('plain tex gets its \\bye and plain LuaTeX; a \\documentclass body is LaTeX after all', () => {
	const html = texFence.renderer(texFence.tokenizer('```tex\n\\centerline{Plain}\n```\n'));
	assert.match(html, /\n\\centerline\{Plain\}\n\\bye\n<\/tikz-diagram>/, 'a \\bye added, nothing else');
	assert.match(html, /class="mathjax_ignore clew-doc"/);
	assert.equal(attrOf(html, 'data-engine'), 'luatex');
	assert.equal(wrapTex('x\n\\bye', {}).source, 'x\n\\bye', 'an existing \\bye is kept');
	const doc = '\\documentclass{article}\\begin{document}x\\end{document}';
	assert.deepEqual(wrapTex(doc, {}), { source: doc, attrs: { engine: 'lualatex' } });
	assert.equal(wrapTex(doc, { engine: 'latex' }).attrs.engine, 'latex');
});

test('font=note: the fontspec block, a Lua engine, woff2 output and the data-opentype mark', () => {
	process.env.CLEW_NOTE_FONTS = JSON.stringify({
		Regular: 'NoteFont-Regular.ttf', Bold: 'NoteFont-Bold.ttf', Italic: 'NoteFont-Italic.ttf', BoldItalic: 'NoteFont-BoldItalic.ttf',
	});
	try {
		// A wrapped ```latex snippet: the block goes in right after \documentclass.
		const latex = figureElement('latex', 'Hello', { font: 'note' });
		assert.match(latex, /\\documentclass\[varwidth,border=2pt\]\{standalone\}\n\\usepackage\{fontspec\}\n\\setmainfont\{NoteFont-Regular\.ttf\}\[Path=\.\/,BoldFont=NoteFont-Bold\.ttf,ItalicFont=NoteFont-Italic\.ttf,BoldItalicFont=NoteFont-BoldItalic\.ttf\]\n\\setsansfont\{NoteFont-Regular\.ttf\}\[[^\]]*\]\n\\usepackage\{amsmath,amssymb\}/);
		assert.equal(attrOf(latex, 'data-engine'), 'lualatex');
		assert.equal(attrOf(latex, 'data-fonts'), 'woff2', 'real <text> in an embedded subset, not outlines');
		assert.equal(attrOf(latex, 'data-opentype'), '1', 'the mark the preview keys the bundle on');
		assert.doesNotMatch(latex, /data-font=/, 'font itself is consumed');
		// A tikz body: the library wraps, so the block rides in preamble — and pdfTeX becomes LuaLaTeX.
		const tikz = figureElement('tikz', '\\draw (0,0) -- (1,1);', { font: 'note', engine: 'latex' });
		assert.match(attrOf(tikz, 'data-preamble'), /^\\usepackage\{fontspec\}\n\\setmainfont/);
		assert.equal(attrOf(tikz, 'data-engine'), 'lualatex');
		assert.equal(attrOf(tikz, 'data-opentype'), '1', 'marked though the block is in the preamble attribute, not the source — a note with only this figure must still fetch the bundle');
		assert.equal(attrOf(figureElement('tikz', 'x', { font: 'note', engine: 'luatex' }), 'data-engine'), 'luatex', 'a Lua engine the author chose stands');
		// The author's own preamble follows ours.
		const both = figureElement('tikz', 'x', { font: 'note', preamble: '\\usetikzlibrary{calc}' });
		assert.match(attrOf(both, 'data-preamble'), /\\setsansfont[^\n]*\n\\usetikzlibrary\{calc\}$/);
		// Plain TeX: luaotfload input directly, one \font per face in the bracket-file
		// form, \let over plain's tenrm/tenbf/tenit so {\bf …} and {\it …} switch.
		const tex = figureElement('tex', '\\centerline{Hi}', { font: 'note' });
		assert.match(tex, /\n\\input luaotfload\.sty\n\\font\\notefont="\[NoteFont-Regular\.ttf\]:mode=node;\+liga;\+kern;\+tlig" at 10pt\n\\font\\notefontbf="\[NoteFont-Bold\.ttf\][^"]*" at 10pt\n\\font\\notefontit="\[NoteFont-Italic\.ttf\][^"]*" at 10pt\n\\let\\tenrm\\notefont \\let\\tenbf\\notefontbf \\let\\tenit\\notefontit \\rm\n\\centerline\{Hi\}\n\\bye\n/);
		assert.equal(attrOf(tex, 'data-engine'), 'luatex');
		assert.equal(attrOf(tex, 'data-fonts'), 'woff2');
		assert.equal(attrOf(tex, 'data-opentype'), '1');
		// …but a ```tex body that is really LaTeX gets the LaTeX treatment.
		const texDoc = figureElement('tex', '\\documentclass{article}\\begin{document}x\\end{document}', { font: 'note' });
		assert.match(texDoc, /\\documentclass\{article\}\n\\usepackage\{fontspec\}/);
		assert.equal(attrOf(texDoc, 'data-opentype'), '1');
		// fonts=paths is the author's to keep.
		assert.equal(attrOf(figureElement('latex', 'x', { font: 'note', fonts: 'paths' }), 'data-fonts'), 'paths');
		// A complete document with font=note: the block after ITS \documentclass, nothing else touched.
		const doc = figureElement('latex', '\\documentclass[12pt]{article}\n\\begin{document}x\\end{document}', { font: 'note' });
		assert.match(doc, /\\documentclass\[12pt\]\{article\}\n\\usepackage\{fontspec\}\n\\setmainfont/);
		assert.match(doc, /\\setsansfont[^\n]*\n\\begin\{document\}x/);
		// MetaPost has no LaTeX preamble to put it in: ignored, unmarked.
		const mp = figureElement('metapost', 'draw origin;', { font: 'note' });
		assert.doesNotMatch(mp, /data-opentype|fontspec|data-font/);
	} finally {
		delete process.env.CLEW_NOTE_FONTS;
	}
});

test('a document that loads fontspec itself is marked for the bundle; one that does not is not', () => {
	const own = figureElement('latex', '\\documentclass{article}\\usepackage[no-math]{fontspec}\\begin{document}x\\end{document}');
	assert.equal(attrOf(own, 'data-opentype'), '1');
	assert.doesNotMatch(own, /NoteFont|setmainfont/, 'the author’s fontspec block is theirs; nothing is added');
	assert.equal(attrOf(figureElement('latex', '\\documentclass{article}\\usepackage{amsmath,unicode-math}\\begin{document}x\\end{document}'), 'data-opentype'), '1');
	assert.doesNotMatch(figureElement('latex', 'x'), /data-opentype/);
	assert.doesNotMatch(figureElement('tikz', '\\draw (0,0) circle (1);'), /data-opentype/);
});

test('with no note face on the machine, font=note still asks for fontspec and typesets in its defaults', () => {
	delete process.env.CLEW_NOTE_FONTS;
	const html = figureElement('latex', 'x', { font: 'note' });
	assert.match(html, /\\documentclass\[[^\]]*\]\{standalone\}\n\\usepackage\{fontspec\}\n\\usepackage\{amsmath,amssymb\}/, 'no \\setmainfont naming a file that is not there');
	assert.equal(attrOf(html, 'data-opentype'), '1');
	const tex = figureElement('tex', 'x', { font: 'note' });
	assert.match(tex, /<tikz-diagram[^>]*>\nx\n\\bye\n/, 'plain TeX has no default OpenType face to fall back to: left in Computer Modern, untouched');
	assert.doesNotMatch(tex, /data-opentype|luaotfload|data-fonts/, 'and no bundle is fetched for it');
});

test('the new fences bound their language names', () => {
	assert.equal(texFence.start('```text\nnot ours\n```\n'), undefined, '```text is somebody else’s');
	assert.equal(texFence.tokenizer('```text\nnot ours\n```\n'), undefined);
	assert.equal(latexFence.start('```latexcd\nx\n```\n'), undefined);
	assert.equal(texFence.start('```tex\nx\n```\n'), 0);
	assert.equal(latexFence.start('```latex show=code\nx\n```\n'), 0);
});

// ---- show= -----------------------------------------------------------------

test('show= and its bare shorthands', () => {
	assert.equal(showMode({}), 'figure');
	assert.equal(showMode({ show: 'code' }), 'code');
	assert.equal(showMode({ show: 'BOTH' }), 'both');
	assert.equal(showMode({ code: 'true' }), 'code');
	assert.equal(showMode({ both: 'true' }), 'both');
	assert.equal(showMode({ figure: 'true' }), 'figure');
	assert.equal(showMode({ show: 'nonsense' }), 'figure');
});

test('show=code hands marked its own code token, in the language that highlights it', () => {
	const token = tikzFence.tokenizer('```tikz code\n\\draw (0,0)--(1,1);\n```\n');
	assert.equal(token.type, 'code');
	assert.equal(token.lang, 'latex');
	assert.equal(token.text, '\\draw (0,0)--(1,1);');
	assert.equal(token.raw, '```tikz code\n\\draw (0,0)--(1,1);\n```\n', 'raw is the block, so the source-line pass finds it');
	assert.equal(metapostFence.tokenizer('```metapost show=code\ndraw origin;\n```\n').lang, 'metapost');
	assert.equal(texFence.tokenizer('```tex code\nx\n```\n').lang, 'tex');
	assert.equal(latexFence.tokenizer('```latex code\nx\n```\n').lang, 'latex');
	assert.equal(tikzDirective.tokenizer(':::TiKZ{show=code}\n\\draw (0,0);\n:::\n').type, 'code');
});

test('show=both is the code child, then the figure', () => {
	const token = latexFence.tokenizer('```latex both\nHello\n```\n');
	assert.equal(token.type, 'latexFence');
	assert.equal(token.mode, 'both');
	assert.equal(token.tokens.length, 1);
	assert.equal(token.tokens[0].type, 'code');
	const parser = { parse: (tokens) => `<pre>${tokens[0].text}</pre>` };
	const html = latexFence.renderer.call({ parser }, token);
	assert.match(html, /^<pre>Hello<\/pre><tikz-diagram /);
	const plain = latexFence.tokenizer('```latex\nHello\n```\n');
	assert.equal(plain.mode, 'figure');
	assert.deepEqual(plain.tokens, []);
	assert.match(latexFence.renderer.call({ parser }, plain), /^<tikz-diagram /);
	const directive = tikzDirective.tokenizer(':::TiKZ{show=both}\n\\draw (0,0);\n:::\n');
	assert.match(tikzDirective.renderer.call({ parser }, directive), /^<pre>\\draw \(0,0\);<\/pre><tikz-diagram /);
});

test('the environments take show= through the custom-mode hook', () => {
	const token = { raw: '@begin(TiKZ){show=both}\nx\n@end(TiKZ)\n', attrs: { show: 'both' } };
	TiKZ.tokenize('\\draw (0,0);\n', token);
	assert.equal(token.showMode, 'both');
	assert.equal(token.tokens[0].type, 'code');
	assert.equal(token.tokens[0].text, '\\draw (0,0);');
	const parser = { parse: () => '<pre>CODE</pre>' };
	assert.match(TiKZ.html({ rawText: '\\draw (0,0);', attrs: token.attrs, token, parser }), /^<pre>CODE<\/pre><tikz-diagram /);
	const codeOnly = { raw: '', attrs: { show: 'code' } };
	metapost.tokenize('draw origin;', codeOnly);
	assert.equal(metapost.html({ rawText: 'draw origin;', attrs: codeOnly.attrs, token: codeOnly, parser }), '<pre>CODE</pre>');
	const figure = { raw: '', attrs: {} };
	metapost.tokenize('draw origin;', figure);
	assert.equal(figure.tokens, undefined, 'no child token for a plain figure');
	assert.match(metapost.html({ rawText: 'draw origin;', attrs: {}, token: figure, parser }), /^<metapost-diagram /);
});

test('the MetaPost grammar registers with highlight.js when it can be found', (t) => {
	const hljs = registerMetapostGrammar();
	if (!hljs) return t.skip('no highlight.js reachable from here — the preview would fall back to plain text');
	assert.ok(hljs.getLanguage('metapost'));
	const out = hljs.highlight('draw fullcircle scaled 2cm withcolor red; % c\nlabel(btex $x$ etex, origin);', { language: 'metapost' }).value;
	assert.match(out, /<span class="hljs-keyword">draw<\/span>/);
	assert.match(out, /<span class="hljs-literal">fullcircle<\/span>/);
	assert.match(out, /<span class="hljs-built_in">scaled<\/span>/);
	assert.match(out, /<span class="hljs-number">2<\/span><span class="hljs-literal">cm<\/span>/);
	assert.match(out, /<span class="hljs-comment">% c<\/span>/);
	assert.match(out, /<span class="hljs-keyword">btex<\/span>/);
	assert.match(out, /class="language-latex"/, 'a label’s TeX is highlighted as TeX');
});

// ---- the export bake -------------------------------------------------------

test('a page scan finds every figure, however often it is scanned', () => {
	const page = ['<h1>Note</h1>',
		figureElement('tikz', '\\draw (0,0)--(1,1);'),
		'<p>between</p>',
		figureElement('metapost', 'draw fullcircle scaled 20;'),
	].join('\n');
	// hasFigures() first, deliberately: a shared /g/ regex would leave
	// lastIndex past figure one and matchAll (which copies it) would skip it,
	// which is how the first figure on every exported page came out unbaked.
	assert.equal(hasFigures(page), true);
	assert.equal(hasFigures(page), true);
	const found = figureMatches(page);
	assert.equal(found.length, 2);
	assert.equal(found[0][1], 'tikz-diagram');
	assert.match(found[0][3], /\\draw \(0,0\)--\(1,1\);/);
	assert.equal(found[1][1], 'metapost-diagram');
	assert.equal(figureMatches(page).length, 2, 'and again');
});

test('a page with no figure is left alone', () => {
	assert.equal(hasFigures('<h1>Note</h1><p>No figures here.</p>'), false);
	assert.equal(hasFigures('<p>the word tikz-diagram in prose</p>'), false);
});
