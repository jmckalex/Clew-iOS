/*
	Compile-time citation support for JMarkdown.

	This file defines the two *parse-time* pieces of the compile-time citation
	system; the heavy lifting (looking entries up in the .bib file, formatting
	them with citation.js + CSL, and assembling bibliographies) happens later, in
	a cheerio post-pass — see src/biblify-compile.js.

	1. `citations` — an inline extension that recognises the natbib-style
	   \cite-family commands (\cite, \citet, \citep, \citeauthor[*], \fullcite,
	   \nocite, and combinations like \fullnocite). It deliberately claims the
	   whole raw command *before* marked's inline rules can run, so the optional
	   arguments (\citep[see][p. 5]{…} looks like a reference-style link), the
	   trailing * (\citeauthor*), and keys containing _ or / are never mangled by
	   the /italics/, *strong*, sub/sup, or link tokenizers. It also never fires
	   inside fenced code or code spans, so literal \cite examples in code blocks
	   are left alone for free.

	2. `bibliography` — a block extension implementing the `@bibliography`
	   placement marker. (A dedicated block extension rather than a labelled
	   directive because the directive framework in extended-directives.js
	   requires trailing content, so a bare marker on its own line would not
	   tokenize.)

	   Spelled `@bibliography{…}`, mirroring `@endnotes{…}` in
	   inline-footnotes.js: both are line-anchored block markers naming a place
	   where a generated list belongs, and both take an optional `{title="…"}`.
	   The older `::Bibliography` spelling remains accepted as a silent alias so
	   existing documents keep building.

	Output dispatch:
	  - LaTeX            → commands pass through verbatim (native natbib), and
	                       `@bibliography` emits \bibliographystyle + \bibliography.
	  - HTML, resolve on → emit placeholder elements for the post-pass to resolve.
	  - HTML, resolve off→ leave the commands literal so the *runtime* Biblify
	                       client can process them in the browser.

	`global.resolveCitations` (set in index.js from the `Resolve citations`
	metadata/config key) selects compile-time resolution; `global.isLatex`
	selects the LaTeX branch.
*/

import attributesParser from 'attributes-parser';
import path from 'path';
import { configManager } from './config-manager.js';
import { isChapterClass } from './sectioning.js';
import { escapeLatexText } from './latex-escape.js';

// The canonical \cite-family grammar, shared with the post-pass. Anchored so it
// can be used to re-parse a single stored command.
//   1:full  2:no  3:author  4:t|p  5:*  6:[opt]  7:[opt]  8:keys
export const CITE_RE =
	/^\\(full)?(no)?cite(author)?(t|p)?(\*)?(\[[^\]]*\])?(\[[^\]]*\])?\{([^}]*)\}/i;

// Locate where the next cite command could begin (a backslash followed by an
// optional full/no prefix and "cite").
const CITE_START = /\\(?:full)?(?:no)?cite/i;

function escapeAttr(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export const citations = {
	name: 'citation',
	level: 'inline',
	start(src) {
		const m = src.match(CITE_START);
		return m ? m.index : undefined;
	},
	tokenizer(src) {
		const match = CITE_RE.exec(src);
		if (match) {
			return {
				type: 'citation',
				raw: match[0],
				text: match[0], // the whole command, verbatim
				tokens: []
			};
		}
	},
	renderer(token) {
		const cmd = token.text;

		if (global.isLatex) {
			// Native natbib: hand the command through unchanged. natbib has no
			// \fullcite, so translate it to \bibentry (the bibentry package).
			return cmd.replace(
				/^\\fullcite(?:\[[^\]]*\])?(?:\[[^\]]*\])?\{([^}]*)\}/i,
				(_m, keys) => keys.split(',').map(k => `\\bibentry{${k.trim()}}`).join('; ')
			);
		}

		if (!global.resolveCitations) {
			// Compile-time resolution is off: leave the command literal so the
			// runtime Biblify client can process it in the browser.
			return cmd;
		}

		// Compile-time HTML: emit a placeholder for the post-pass to resolve.
		return `<span class="biblify-cite" data-cite-cmd="${escapeAttr(cmd)}"></span>`;
	}
};

// Parse the optional `{title="…" style="…" scope="…" all}` argument of
// @bibliography.
function parseBibAttrs(raw) {
	const result = { title: '', style: '', scope: '', all: false };
	if (!raw) return result;
	const inside = raw.trim().replace(/^\{/, '').replace(/\}$/, '');
	let attrs = {};
	try {
		attrs = attributesParser(inside) || {};
	} catch {
		attrs = {};
	}
	if (attrs.title != null) result.title = String(attrs.title).trim();
	if (attrs.style) result.style = String(attrs.style).trim();
	if (attrs.scope) result.scope = String(attrs.scope).trim();
	if ('all' in attrs) {
		const v = String(attrs.all).trim().toLowerCase();
		result.all = v === '' || v === 'true' || v === 'all';
	}
	return result;
}

// Map a CSL style name to a reasonable natbib .bst, for LaTeX output. Authors
// can override with the `LaTeX bib style` metadata key.
function styleToBst(style) {
	switch ((style || '').toLowerCase()) {
		case 'apa':
		case 'harvard1':
			return 'apalike';
		case 'chicago':
		case 'ajp':
		case 'bjps':
			return 'plainnat';
		default:
			return 'plainnat';
	}
}

export const bibliography = {
	name: 'bibliography',
	level: 'block',
	// Line-anchored, exactly like @endnotes: a block `start()` must only report a
	// position its own tokenizer can claim, or it shreds the paragraph being
	// built (see the note in CLAUDE.md). `::Bibliography` is the legacy alias.
	start(src) {
		const m = src.match(/(?:^|\n)(?:@bibliography|::Bibliography)\b/);
		return m ? (m.index + (m[0].startsWith('\n') ? 1 : 0)) : undefined;
	},
	tokenizer(src) {
		const match = /^(?:@bibliography|::Bibliography)[ \t]*(\{[^}]*\})?[ \t]*(?:\n|$)/.exec(src);
		if (match) {
			return {
				type: 'bibliography',
				raw: match[0],
				attrsRaw: match[1] || '',
				tokens: []
			};
		}
	},
	renderer(token) {
		const { title, style, scope, all } = parseBibAttrs(token.attrsRaw);

		if (global.isLatex) {
			const bibStyle =
				configManager.get('Biblify.latex bib style') ||
				styleToBst(style || configManager.get('Biblify.bibliography style'));
			const bibPath = configManager.get('Biblify.bibliography') || '';
			const bibBase = bibPath
				? path.basename(bibPath, path.extname(bibPath))
				: 'references';
			// A `title` retitles the list the standard LaTeX way, by redefining the
			// class's heading macro — \bibname in chapter-bearing classes,
			// \refname in article and friends. The engine still draws the heading,
			// so it stays in the ToC and keeps the class's own formatting.
			const heading = title
				? `\\renewcommand{\\${isChapterClass() ? 'bibname' : 'refname'}}{${escapeLatexText(title)}}\n`
				: '';
			return `\n${heading}\\bibliographystyle{${bibStyle}}\n\\bibliography{${bibBase}}\n`;
		}

		if (!global.resolveCitations) {
			// Runtime mode: the browser Biblify client places the bibliography
			// itself, so there's nothing for this marker to emit here — including
			// no `title`, which has nothing to attach to. Documented as
			// compile-time/LaTeX only.
			return '';
		}

		let attrs = '';
		if (title) attrs += ` data-title="${escapeAttr(title)}"`;
		if (style) attrs += ` data-style="${escapeAttr(style)}"`;
		if (scope) attrs += ` data-scope="${escapeAttr(scope)}"`;
		if (all) attrs += ` data-all="true"`;
		return `<div class="biblify-bibliography"${attrs}></div>\n`;
	}
};
