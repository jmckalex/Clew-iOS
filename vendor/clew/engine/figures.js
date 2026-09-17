// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// TikZ, MetaPost, LaTeX and plain TeX, typeset by mp-tikz-wasm in the
// preview rather than by a TeX installation on the machine.
//
// Six syntaxes reach the same two elements:
//
//   ```tikz / ```metapost        Obsidian's fence (its TikZJax plugin's
//                                shape, bodies in that dialect included)
//   ```latex / ```tex            Clew's own: a LaTeX snippet or document
//                                (LuaLaTeX), or plain TeX (LuaTeX)
//   :::TiKZ … :::                jmarkdown's container directive
//   @begin(TiKZ) … @end(TiKZ)    and its @-sigil twin
//   @begin(metapost) … @end(metapost)
//
// Every one of them takes `show=` on its opening line — `show=code` to
// display the source as a highlighted code block instead of typesetting it,
// `show=both` for the code followed by the figure (the tutorial shape), and
// `show=figure`, the default. The bare words `code`, `both` and `figure` are
// the same thing. The code block is marked's OWN `code` token (returned from
// the tokenizer, or attached as a child), so it is highlighted by the same
// highlight.js pass as any other fence and stamped with its source line;
// the one thing this file adds to that pass is a MetaPost grammar, which
// highlight.js does not ship.
//
// The last three ALREADY work in jmarkdown: vendor/jmarkdown/src/tikz.js and
// metapost.js shell out to the user's own lualatex/mpost + dvisvgm and cache
// an SVG in a TiKZ/ or MetaPost/ folder beside the note. That path is
// untouched and still owns every LaTeX export (exports run with the user's
// own config cascade, which never loads this file — src/main/export.js). What
// this file changes is how Clew DISPLAYS a figure: no TeX installation, no
// files written into the vault, and the same picture on every machine.
//
// It wins the syntax two different ways, both load-order facts:
//
//   • The fences and the :::TiKZ directive are marked extensions listed in
//     the generated preview config's `Extensions`, which the engine loads
//     (index.js) AFTER registering its own. marked UNSHIFTS extension
//     tokenizers, so the most recently registered is offered first — the
//     arrangement callouts.js relies on.
//   • @begin(TiKZ) and @begin(metapost) are block ENVIRONMENTS, a registry
//     keyed by name. The config's `Environments` key is loaded one line later
//     still, so exporting `TiKZ` and `metapost` from here replaces the
//     engine's handlers while inheriting all of @begin's machinery — name
//     nesting, indentation, dedenting, attribute parsing.
//
// Rendering happens in the browser: see src/preview-client/figures.js, which
// loads the library and keeps the elements alive across a morph.

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import {
	METAPOST_CONSTANTS, METAPOST_KEYWORDS, METAPOST_OPERATORS, METAPOST_TYPES,
} from './metapost-words.js';

// The TikZ libraries the DIRECTIVES promise. vendor/jmarkdown/src/tikz.js
// loads exactly this list for every :::TiKZ / @begin(TiKZ) body, so a note
// written against it uses `->`, `fit`, `positioning` and the rest without
// declaring anything — and would break here if this file loaded less.
// tests/figures.test.js reads the list out of the vendored engine and fails
// if the two ever drift (a re-sync of the master can move it).
export const ENGINE_TIKZ_LIBRARIES = 'arrows,arrows.meta,positioning,shapes,backgrounds,calc,fit,decorations,decorations.pathreplacing,decorations.markings,patterns,matrix,calligraphy,trees,graphs,intersections,through,shapes.geometric,datavisualization';

// …minus any the wasm TeX bundle does not carry, because ONE failing
// \usetikzlibrary takes the whole figure down with it — including the
// libraries that are there. Empty as of mp-tikz-wasm's bundles gaining
// spath3 (2026-09-16), which is where `calligraphy` lives: it is not part of
// pgf, so it used to be missing and had to be dropped here.
// tests/figures.test.js checks this set against the staged bundle, so a
// bundle that loses a library again fails loudly rather than quietly taking
// every `@begin(TiKZ)` figure with it.
export const UNBUNDLED_TIKZ_LIBRARIES = new Set();

const DIRECTIVE_LIBRARIES = ENGINE_TIKZ_LIBRARIES.split(',')
	.filter((lib) => !UNBUNDLED_TIKZ_LIBRARIES.has(lib));

// data-* the library itself reads (auto.js strips the prefix and hands them
// to wrapTikz/wrapMetaPost). Anything else an author writes is ignored
// rather than passed on: it would change the figure's identity for nothing.
const FIGURE_ATTRS = new Set([
	'libraries', 'packages', 'preamble', 'border', 'gdlibraries', 'engine',
	'tex', 'prologues', 'fonts', 'cache', 'alt', 'show-console',
]);

// Two more the native path implemented as CSS, which this one keeps: `scale`
// (a transform) and `width`. Its `embed` and `empty-cache` have nothing left
// to mean here — the SVG is always inline, and a content-addressed cache is
// never stale — so they are ignored, not reported as errors in somebody's
// working note.

function escapeHtml(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
	return escapeHtml(s).replace(/"/g, '&quot;');
}

/**
 * The `{key=value key2='v 2' flag}` tail of a directive or fence. A
 * deliberate subset of the engine's own attributes-parser (which is an npm
 * dependency this file cannot reach — dist/engine is a verbatim copy served
 * to a worker): quoted and bare values, and a bare key meaning "true".
 * Enough for every attribute a figure takes.
 */
export function parseFigureAttrs(text) {
	const attrs = {};
	if (!text) return attrs;
	const re = /([A-Za-z][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s'"}]+)))?/g;
	for (const m of text.matchAll(re)) {
		attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? 'true';
	}
	return attrs;
}

/**
 * A TikZJax-shaped body — what an Obsidian vault's ```tikz fences hold —
 * carries its own preamble and `\begin{document}` but no `\documentclass`,
 * which is the one thing the library's wrapper looks for. Hand the preamble
 * over as a preamble (it is already legal LaTeX: \usepackage with options
 * and all) and keep what is between the document markers.
 *
 * A body with \documentclass is a complete document and passes through
 * untouched; so does a plain picture.
 */
export function unwrapTikzJax(source, attrs) {
	if (/\\documentclass/.test(source)) return { source, attrs };
	const open = /\\begin\s*\{document\}/.exec(source);
	if (!open) return { source, attrs };
	const close = /\\end\s*\{document\}/.exec(source);
	const head = source.slice(0, open.index).trim();
	const body = source.slice(open.index + open[0].length, close ? close.index : undefined).trim();
	const preamble = [attrs.preamble, head].filter(Boolean).join('\n');
	return { source: body, attrs: preamble ? { ...attrs, preamble } : attrs };
}

/**
 * What each kind of source becomes. The library knows two elements and two
 * wrappers (a TikZ body → a standalone picture; a MetaPost body → one
 * figure); LaTeX and plain TeX ride on the TikZ element as COMPLETE
 * documents, which the library passes to the engine untouched and crops
 * to the ink, one SVG per page. `code` is the highlight.js language the
 * source is shown in under `show=code`.
 */
//
// ```latex runs on LuaLaTeX and ```tex on plain LuaTeX. That needs the
// staged mp-tikz-wasm to be 0.2.1 AS PUBLISHED (shared/mptikz-manifest.json):
// before its LuaTeX rule fix, every DVI rule — \sqrt, \frac, \hrule — trapped
// the wasm module under both LuaTeX formats (a call-arity mismatch in the
// engine's back-end dispatch table that native C tolerates and WebAssembly
// does not), which first showed up here as "plain LuaTeX fails on any math"
// and briefly had ```tex running on the e-TeX format instead. `engine=` on
// the fence overrides either default.
const KINDS = {
	tikz: { tag: 'tikz-diagram', code: 'latex' },
	metapost: { tag: 'metapost-diagram', code: 'metapost' },
	latex: { tag: 'tikz-diagram', code: 'latex', engine: 'lualatex', wrap: wrapLatex },
	tex: { tag: 'tikz-diagram', code: 'tex', engine: 'luatex', wrap: wrapTex },
};

/** The packages a wrapped ```latex snippet can count on. */
const LATEX_PACKAGES = ['amsmath', 'amssymb'];

const isLatexDocument = (source) => /\\documentclass/.test(source);

/**
 * A ```latex body: a complete document (it says \documentclass) is typeset
 * as written — page numbers included: an article's folio at the page foot
 * makes the cropped SVG a page tall, which is the document's business and
 * the manual's to explain (owner's decision 2026-09-17: someone wanting
 * pages as pages must get them, so nothing is injected). Anything else is a snippet — a paragraph, an align, a table,
 * a theorem — and is wrapped in a `standalone` document whose page is as
 * wide as the content needs (`varwidth`), so the SVG is the snippet and not
 * a sheet of A4 around it. `packages=`, `preamble=` and `border=` are
 * consumed here, because the library applies its own only when IT does the
 * wrapping; they are dropped from the element so they cannot be applied
 * twice or change the figure's identity for nothing.
 */
export function wrapLatex(source, attrs = {}) {
	const { packages, preamble, border, ...rest } = attrs;
	if (isLatexDocument(source)) return { source, attrs: rest };
	const pkgs = [...new Set([...LATEX_PACKAGES, ...String(packages ?? '').split(/[,\s]+/).filter(Boolean)])];
	const doc = [
		`\\documentclass[varwidth,border=${border ?? '2pt'}]{standalone}`,
		`\\usepackage{${pkgs.join(',')}}`,
		...(preamble ? [preamble] : []),
		'\\begin{document}',
		source,
		'\\end{document}',
	].join('\n');
	return { source: doc, attrs: rest };
}

/**
 * A ```tex body is plain TeX: it gets its `\bye` if it forgot one and runs
 * under the plain format. A body that turns out to be LaTeX (it says
 * \documentclass) is treated as one — the engine switches to lualatex —
 * rather than failing on `\documentclass` being undefined in plain.
 *
 * Nothing else is added — not `\nopagenumbers`, though plain TeX's folio
 * in the footline makes a one-line snippet's cropped SVG a page tall
 * (663pt, measured): as with a complete LaTeX document, the page is the
 * author's (owner's decision 2026-09-17), and the manual says what to
 * write.
 */
export function wrapTex(source, attrs = {}) {
	if (isLatexDocument(source)) return { source, attrs: { engine: 'lualatex', ...attrs } };
	const body = /\\bye\b/.test(source) ? source : `${source}\n\\bye`;
	return { source: body, attrs };
}

/**
 * `show=figure` (default) typesets; `show=code` displays the source as a
 * highlighted code block instead; `show=both` is the code, then the figure.
 * A bare `code` / `both` / `figure` on the opening line means the same.
 */
export function showMode(attrs = {}) {
	const value = String(attrs.show ?? (attrs.code ? 'code' : attrs.both ? 'both' : 'figure')).toLowerCase();
	return value === 'code' || value === 'both' ? value : 'figure';
}

/**
 * The source as marked's own `code` token, in the language that highlights
 * it. `raw` is the block it came from, which is how the engine's
 * source-position pass finds the line to stamp on it.
 */
export function codeToken(kind, text, raw) {
	return { type: 'code', raw, lang: KINDS[kind].code, text: String(text ?? '').replace(/\n+$/, '') };
}

/**
 * The figure element. `kind` is 'tikz', 'metapost', 'latex' or 'tex'.
 *
 * data-fig-key identifies the figure for the preview's morph guard ONLY: it
 * says "this is a different picture now, typeset it again". It is
 * deliberately NOT the library's own figureHash, which keys the result cache
 * and is computed in the browser from the WRAPPED document — duplicating that
 * here would mean duplicating the wrappers, and a drifting copy of a cache
 * key is worse than no copy at all.
 */
export function figureElement(kind, rawSource, rawAttrs = {}) {
	const spec = KINDS[kind] ?? KINDS.tikz;
	let source = String(rawSource ?? '').replace(/^\n+/, '').replace(/\s+$/, '');
	let attrs = { ...rawAttrs };
	if (kind === 'tikz') ({ source, attrs } = unwrapTikzJax(source, attrs));
	if (spec.wrap) {
		({ source, attrs } = spec.wrap(source, attrs));
		// The kind's engine, unless the author named one (or the wrapper did).
		attrs.engine ??= spec.engine;
	}

	const data = [];
	const styles = [];
	for (const [key, value] of Object.entries(attrs)) {
		if (value === undefined || value === null || value === '') continue;
		if (FIGURE_ATTRS.has(key)) data.push(` data-${key}="${escapeAttr(value)}"`);
		else if (key === 'scale') styles.push(`transform: scale(${escapeAttr(value)}); transform-origin: left top`);
		else if (key === 'width') styles.push(`width: ${escapeAttr(value)}`);
		// Anything else (embed, empty-cache, show, a typo) is ignored: passing
		// it on would change the figure's identity for nothing.
	}
	const key = crypto.createHash('md5')
		.update(`${kind}\0${JSON.stringify(Object.entries(attrs).sort())}\0${source}`)
		.digest('hex').slice(0, 12);
	const style = styles.length ? ` style="${styles.join('; ')}"` : '';
	// A `width` meant the width of the PICTURE in the native path (it went on
	// the <img>), so the SVG has to fill the box rather than just be
	// constrained by it — preview.css styles .mpw-sized for that.
	const sized = attrs.width ? ' mpw-sized' : '';
	// A document rather than a picture: its pages stack (preview.css).
	const doc = spec.wrap ? ' clew-doc' : '';
	// mathjax_ignore is load-bearing, not decoration: until the library
	// typesets it, the source sits in the document as TEXT, and a TikZ node
	// label or a btex block is full of `$…$`. MathJax typesets the whole
	// document and would claim those first, leaving the figure an empty
	// picture (measured: `mpw-ok`, zero paths, 0×0). This is MathJax's own
	// default opt-out class, so the elements are skipped wherever they end
	// up — an exported site included.
	//
	// The source is the element's TEXT: entities are what an HTML parser
	// decodes, and what the library's own page scan decodes (figures.js
	// #decodeEntities), so the browser and the site-export bake read the
	// same characters.
	return `<${spec.tag} class="mathjax_ignore${doc}${sized}" data-fig-key="${key}"${data.join('')}${style}>\n${escapeHtml(source)}\n</${spec.tag}>\n`;
}

/**
 * What a block renders to under its show mode: the code (already parsed
 * from the child token by marked, highlighted and all), the figure, or
 * both in that order — source above result, the way a tutorial reads.
 */
function figureOutput(kind, mode, codeHtml, source, attrs) {
	if (mode === 'code') return codeHtml;
	const figure = figureElement(kind, source, attrs);
	return mode === 'both' ? codeHtml + figure : figure;
}

// ---- highlight.js: a MetaPost grammar --------------------------------------
// highlight.js knows LaTeX (`latex`, alias `tex`) but not MetaPost, so a
// ```metapost show=code block would be plain text. The engine highlights in
// the render worker with ITS highlight.js — the one this file must register
// with, found the way the engine itself finds it: by resolving from the
// worker script (process.argv[1] is the engine's own watch-worker.js, and
// its node_modules hold the engine's dependencies, in dev and in the
// packaged app alike). ESM and CJS loads of that package share one
// instance (measured), so a grammar registered here is seen by the
// marked-highlight pass. Unreachable — a test runner, some other host —
// means unhighlighted MetaPost, never a failed render.

function metapostGrammar(hljs) {
	return {
		name: 'MetaPost',
		keywords: {
			$pattern: /[A-Za-z_][A-Za-z_]*/,
			keyword: METAPOST_KEYWORDS.join(' '),
			type: METAPOST_TYPES.join(' '),
			literal: METAPOST_CONSTANTS.join(' '),
			built_in: METAPOST_OPERATORS.join(' '),
		},
		contains: [
			hljs.COMMENT('%', '$'),
			// MetaPost strings have no escapes and never span a line.
			{ scope: 'string', begin: '"', end: '"|$' },
			// A label's TeX, typeset by TeX: highlighted as such between the
			// two keywords.
			{
				begin: /\b(?:btex|verbatimtex)\b/, end: /\betex\b/,
				beginScope: 'keyword', endScope: 'keyword',
				subLanguage: 'latex',
			},
			// `2cm` is 2 × cm: the digits are the number, the unit a constant.
			{ scope: 'number', begin: /(?<![A-Za-z_\d])(?:\d+\.?\d*|\.\d+)/ },
			// @# and @ are the suffix parameters of a vardef.
			{ scope: 'variable', begin: /@#?/ },
			{ scope: 'operator', begin: /:=|\.\.\.|\.\.|--|->|<=|>=|<>|[-+*/=<>&]/ },
		],
	};
}

export function registerMetapostGrammar() {
	let hljs = null;
	for (const from of [process.argv?.[1], import.meta.url]) {
		if (!from) continue;
		try { hljs = createRequire(from)('highlight.js'); break; } catch { /* the next candidate */ }
	}
	if (!hljs || typeof hljs.registerLanguage !== 'function') return null;
	if (!hljs.getLanguage('metapost')) hljs.registerLanguage('metapost', metapostGrammar);
	return hljs;
}

registerMetapostGrammar();

// ---- ```tikz / ```metapost / ```latex / ```tex fences ---------------------
// Obsidian writes TikZ as a ```tikz fence (its TikZJax plugin); the other
// three are Clew's own, for symmetry. An optional attribute tail follows the
// language, `key=value` style: ```tikz libraries="arrows.meta" border=4pt
//
// The lookahead is what keeps ```tikzcd (and any other ```tikz-prefixed
// language a vault may carry — ```text, for one) out of our hands.

function fenceExtension(name, kind, language) {
	// The language must END at the fence line's whitespace or its newline, in
	// BOTH patterns: marked offers a block tokenizer the current position
	// whatever start() said, so a `whole` that treated the rest of the word as
	// an info string would swallow ```tikzcd (a different language, tikz-cd
	// matrices) and ```tikzpicture along with it.
	const open = new RegExp(`^\`\`\`${language}(?=[ \\t]*\\n|[ \\t]+[^\\n]*\\n)`, 'm');
	const whole = new RegExp(`^\`\`\`${language}(?:[ \\t]+([^\\n]*?))?[ \\t]*\\n([\\s\\S]*?)\\n\`\`\`[ \\t]*(?:\\n+|$)`);
	return {
		name,
		level: 'block',
		start(src) { return src.match(open)?.index; },
		tokenizer(src) {
			const match = whole.exec(src);
			if (!match) return undefined;
			const figureAttrs = parseFigureAttrs(match[1]);
			const mode = showMode(figureAttrs);
			// Code only: marked's own token, so it renders, highlights and
			// stamps its source line exactly as any other fence does.
			if (mode === 'code') return codeToken(kind, match[2], match[0]);
			return {
				type: name,
				raw: match[0],
				text: match[2],
				figureAttrs,
				mode,
				// `both`: the code block is a child token, which marked's
				// walkTokens pass highlights and this renderer parses.
				tokens: mode === 'both' ? [codeToken(kind, match[2], match[0])] : [],
			};
		},
		renderer(token) {
			const code = token.tokens?.length ? this.parser.parse(token.tokens) : '';
			return figureOutput(kind, token.mode ?? 'figure', code, token.text, token.figureAttrs);
		},
	};
}

export const tikzFence = fenceExtension('tikzFence', 'tikz', 'tikz');
export const metapostFence = fenceExtension('metapostFence', 'metapost', 'metapost');
export const latexFence = fenceExtension('latexFence', 'latex', 'latex');
export const texFence = fenceExtension('texFence', 'tex', 'tex');

// ---- :::TiKZ … ::: ---------------------------------------------------------
// jmarkdown's container directive, claimed before the engine's own rule (see
// the header). The body boundaries are the engine's to the character —
// `^:::TiKZ([\s\S]*?)\n:::` — because a note written for one must tokenize
// the same under the other.

export const tikzDirective = {
	name: 'tikzDirective',
	level: 'block',
	start(src) {
		const m = src.match(/(?:^|\n):::TiKZ/);
		return m ? m.index + (m[0].startsWith('\n') ? 1 : 0) : undefined;
	},
	tokenizer(src) {
		const match = /^:::TiKZ([\s\S]*?)\n:::[ \t]*(?:\n+|$)/.exec(src);
		if (!match) return undefined;
		// The label may be followed by an attribute tail on its own line; the
		// body is everything after that first newline.
		const content = match[1];
		const split = content.indexOf('\n');
		const head = split === -1 ? content : content.slice(0, split);
		const body = split === -1 ? '' : content.slice(split + 1);
		const figureAttrs = parseFigureAttrs(head);
		const mode = showMode(figureAttrs);
		if (mode === 'code') return codeToken('tikz', body, match[0]);
		return {
			type: 'tikzDirective',
			raw: match[0],
			text: body,
			figureAttrs,
			mode,
			tokens: mode === 'both' ? [codeToken('tikz', body, match[0])] : [],
		};
	},
	renderer(token) {
		const code = token.tokens?.length ? this.parser.parse(token.tokens) : '';
		return figureOutput('tikz', token.mode ?? 'figure', code, token.text, withDirectiveLibraries(token.figureAttrs));
	},
};

// ---- @begin(TiKZ) / @begin(metapost) ---------------------------------------
// Block-environment handlers, exported under the names the `Environments`
// config line registers them as. mode 'custom' keeps the body raw (a figure
// is not markdown) and hands it over as ctx.rawText, dedented — exactly what
// 'verbatim' does — plus a `tokenize` hook run in the lexer, which is where
// a `show=code` / `show=both` body gets its code child token, so that the
// engine's highlight pass sees it like any fence.
//
// HTML only, on purpose: there is no `latex` renderer here because no LaTeX
// build ever loads this file. Clew's generated preview config does (and the
// site exporter's, which is also HTML); a LaTeX export runs the engine with
// the user's own config cascade, where the native handlers are still in
// place and still emit a real tikzpicture.

/** The directives' library promise (see ENGINE_TIKZ_LIBRARIES), plus whatever the author asked for. */
function withDirectiveLibraries(attrs) {
	const extra = String(attrs.libraries ?? '').split(/[,\s]+/).filter(Boolean);
	const libraries = [...new Set([...DIRECTIVE_LIBRARIES, ...extra])].join(',');
	return { ...attrs, libraries };
}

function attrsOf(ctx) {
	const out = {};
	// attributes-parser hands back an object-like value; be tolerant of a
	// Map-ish one, and of there being none at all.
	const attrs = ctx?.attrs;
	if (!attrs) return out;
	if (typeof attrs.forEach === 'function' && typeof attrs.get === 'function') {
		attrs.forEach((value, key) => { out[String(key).toLowerCase()] = String(value); });
		return out;
	}
	for (const [key, value] of Object.entries(attrs)) {
		if (typeof value === 'function') continue;
		out[String(key).toLowerCase()] = String(value);
	}
	return out;
}

function environment(kind, finishAttrs = (attrs) => attrs) {
	return {
		mode: 'custom',
		tokenize(body, token) {
			token.showMode = showMode(attrsOf(token));
			if (token.showMode !== 'figure') token.tokens = [codeToken(kind, body, token.raw)];
		},
		html(ctx) {
			const mode = ctx.token?.showMode ?? 'figure';
			const code = mode === 'figure' ? '' : ctx.parser.parse(ctx.token.tokens);
			return figureOutput(kind, mode, code, ctx.rawText ?? ctx.inner, finishAttrs(attrsOf(ctx)));
		},
	};
}

export const TiKZ = environment('tikz', withDirectiveLibraries);
export const metapost = environment('metapost');
