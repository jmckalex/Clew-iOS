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

	1a. `citefile` — an inline extension for \citefile[…]{key}, which links to a
	   reference's attachment on disk (BibDesk's Bdsk-File-N, or a JabRef/Zotero
	   `file` field). Unlike the \cite family it is resolved at BUILD time in
	   both output formats — a file path is a static fact with no CSL in it — so
	   it works whether or not `Resolve citations` is on, and the runtime Biblify
	   client never sees it. See src/bib-attachments.js for the reading of the
	   .bib and the resolving of the path.

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
import { attachmentsFor } from './bib-attachments.js';
import { addWarning } from './warnings.js';
import { requirePackage } from './preamble.js';

// The canonical \cite-family grammar, shared with the post-pass. Anchored so it
// can be used to re-parse a single stored command.
//   1:full  2:no  3:author  4:year  5:t|p|par  6:*  7:[opt]  8:[opt]  9:keys
//
// `year` (\citeyear, \citeyearpar) is the author-suppressed form — natbib has
// both, and it is what pandoc's [-@key] / -@key translate to. `par` must precede
// `p` in the alternation so \citeyearpar isn't read as \citeyear + "ar".
export const CITE_RE =
	/^\\(full)?(no)?cite(author)?(year)?(t|par|p)?(\*)?(\[[^\]]*\])?(\[[^\]]*\])?\{([^}]*)\}/i;

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
		return renderCiteCommand(token.text);
	}
};

/*
	Render one \cite-family command, in whichever of the three modes is active.
	Shared with pandoc-citations.js, which translates [@key] / @key into exactly
	these commands and hands them here — so all three back-ends (native natbib in
	LaTeX, the compile-time CSL pass, the runtime Biblify client) serve both
	syntaxes with no further work.
*/
export function renderCiteCommand(cmd) {
	{
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
}

/* --- \citefile[…]{key} — a link to the reference's file on disk ---------------

	\citefile{key}                          the first attachment, labelled with its
	                                        filename
	\citefile[file=2]{key}                  the second attachment
	\citefile[text="the preprint"]{key}     custom link text
	\citefile[file=2, text="…"]{key}        both
	\citefile[2]{key}                       shorthand: a bare number is file=

	Nothing is emitted when the entry has no attachment at all — the command is
	meant to be dropped into prose that reads correctly without it. An attachment
	that is RECORDED but missing from disk still emits its link, plus a build
	warning: a broken link the author can see beats a silent omission.

	The optional argument is LaTeX keyval, not the {…} attribute syntax used
	elsewhere: commas separate the pairs, and a value may be quoted with straight
	or CURLY quotes, since those are what an author actually types.
*/

const CITEFILE_RE = /^\\citefile(?:\[([^\]]*)\])?\{([^}]*)\}/i;

// Straight and curly quote pairs, opener → closer.
const QUOTES = { '"': '"', "'": "'", '\u201c': '\u201d', '\u2018': '\u2019' };

function parseKeyval(raw) {
	if (raw === undefined) return {};
	const text = raw.trim();
	if (text === '') return {};
	if (/^\d+$/.test(text)) return { file: Number(text) };      // [2] shorthand

	// Split on top-level commas, dropping quote marks as we pass through them so
	// a quoted value may itself contain a comma.
	const parts = [];
	let current = '', closer = null;
	for (const ch of text) {
		if (closer) {
			if (ch === closer) closer = null;
			else current += ch;
		} else if (QUOTES[ch]) {
			closer = QUOTES[ch];
		} else if (ch === ',') {
			parts.push(current); current = '';
		} else {
			current += ch;
		}
	}
	parts.push(current);

	const out = {};
	for (const part of parts) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf('=');
		if (eq < 0) { out[trimmed.toLowerCase()] = true; continue; }
		out[trimmed.slice(0, eq).trim().toLowerCase()] = trimmed.slice(eq + 1).trim();
	}
	return out;
}

// An absolute path as a file:// URL for a browser. encodeURI leaves # and ?
// alone and both would truncate the URL, so they are encoded here as well.
function fileURL(absolutePath) {
	return 'file://' + encodeURI(absolutePath).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

/*
	The LaTeX target for the same file — deliberately NOT the URL above.

	hyperref recognises a file:/run: target and writes a PDF *file action* whose
	/F is a PATH, not a URL, so a percent-encoded space arrives as a literal
	"%20" and the link fails. Raw spaces are correct there and compile fine
	(verified: xelatex, no errors, /F carries the real path).

	Which action to ask for depends on the file. A .pdf goes through file://,
	which hyperref turns into /GoToR — the viewer opens it as a document, the
	smooth path for the PDFs that make up nearly every BibDesk attachment.
	Anything else uses run:, giving /Launch, which hands the file to whatever
	application owns it.
*/
function latexTarget(absolutePath) {
	const target = /\.pdf$/i.test(absolutePath) ? `file://${absolutePath}` : `run:${absolutePath}`;
	// % and # would still be read by TeX itself before hyperref sees them.
	return target.replace(/([%#])/g, '\\$1');
}

export const citefile = {
	name: 'citefile',
	level: 'inline',
	start(src) {
		const m = src.match(/\\citefile/i);
		return m ? m.index : undefined;
	},
	tokenizer(src) {
		const match = CITEFILE_RE.exec(src);
		if (!match) return;
		return {
			type: 'citefile',
			raw: match[0],
			text: match[0],
			options: parseKeyval(match[1]),
			key: match[2].trim(),
			tokens: []
		};
	},
	renderer(token) {
		const key = token.key.split(',')[0].trim();
		if (token.key.includes(',')) {
			addWarning(`\\citefile{${token.key}} takes a single key; only ${key} was used`);
		}

		const { error, attachments } = attachmentsFor(key);
		if (error === 'no-bibliography') {
			addWarning(`\\citefile{${key}}: no \`Bibliography\` file is configured, so attachments cannot be looked up`);
			return '';
		}
		if (error === 'bibliography-missing') {
			addWarning(`\\citefile{${key}}: the \`Bibliography\` file could not be read`);
			return '';
		}
		if (error === 'unknown-key') {
			addWarning(`\\citefile{${key}}: no bibliography entry with that key`);
			return '';
		}
		// No attachment recorded: emit nothing, silently. This is the ordinary
		// case for most entries and is what makes the command safe in prose.
		if (attachments.length === 0) return '';

		const index = Number(token.options.file ?? 1);
		if (!Number.isInteger(index) || index < 1 || index > attachments.length) {
			addWarning(`\\citefile[file=${token.options.file}]{${key}}: the entry has ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`);
			return '';
		}

		const attachment = attachments[index - 1];
		if (!attachment.exists) {
			addWarning(`\\citefile{${key}}: ${attachment.path} is recorded as an attachment but was not found on disk`);
		}

		const label = typeof token.options.text === 'string' && token.options.text !== ''
			? token.options.text
			: path.basename(attachment.path);
		if (global.isLatex) {
			requirePackage('hyperref');
			return `\\href{${latexTarget(attachment.path)}}{${escapeLatexText(label)}}`;
		}
		return `<a class="citation-file" href="${escapeAttr(fileURL(attachment.path))}" title="${escapeAttr(attachment.path)}">${escapeAttr(label)}</a>`;
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
