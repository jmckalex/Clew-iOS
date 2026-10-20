/*
	These are some additional directives I've defined which seem useful.
	It's an experiment to see whether this capability can be used to give
	jmarkdown additional commands like LaTeX.
*/

/*
	Shared render bodies for the four directives that the `:::begin(name)` block
	environment mirrors (see begin-end.js), so `:::begin(abstract)` renders
	identically to `:::abstract`.  abstract/feedback delegate to these; the
	trivial :::TeX / :::HTML bodies are mirrored here for begin-end's use.

	Note: renderAbstract branches — LaTeX gets the standard `abstract`
	environment (so it compiles), HTML keeps the labelled div. renderFeedback
	branches too: LaTeX has no feedback environment, so it gets what the HTML
	shows, a bold "Feedback" line over the body (it used to be given the HTML,
	tags and all). Because the directive and @begin(name) forms share these
	bodies, the branch keeps them in parity automatically.
*/
import { requirePackage, addPreamble } from './preamble.js';
import { registerBlockEnvironment } from './begin-end-core.js';
import { escapeLatexText } from './latex-escape.js';
import { configManager } from './config-manager.js';
import { marked } from './utils.js';

export function renderAbstract(inner) {
	if (global.isLatex) return `\\begin{abstract}\n${inner.trim()}\n\\end{abstract}\n\n`;
	return `<div class="abstract"><div class='label'>Abstract</div>${inner}</div>`;
}

export function renderFeedback(innerHtml) {
	// LaTeX: the label, kept with the body's first line, then the body. Plain
	// kernel commands, so a --fragment compiles in any document. The body is
	// trimmed, as the abstract's is, so :::feedback and @begin(feedback) agree.
	if (global.isLatex) {
		return `\\par\\medskip\\noindent\\textbf{Feedback}\\par\\nopagebreak\n${innerHtml.trim()}\n\\par\\medskip\n\n`;
	}
	return `<p class='feedback'>Feedback</p><section class="feedback">${innerHtml}</section>`;
}

// :::TeX — raw LaTeX, emitted only in LaTeX output.
export function renderTeXEnv(rawText) {
	return global.isLatex ? rawText : '';
}

// :::HTML — markdown prose, emitted only in HTML output.
export function renderHTMLEnv(innerHtml) {
	return global.isLatex ? '' : innerHtml;
}

/*
	The title-page directives — title, subtitle, author, institution, date, and
	today inside them — in LaTeX. They used to receive their HTML, `<div
	class="title">…</div>` and so on. Each is now a line of its own, left-aligned
	and sized as the stylesheet sizes it (title bold and large, author and date
	a step up, subtitle and institution as body text), in kernel commands only,
	so a --fragment compiles anywhere. The content is what the HTML shows:
	inline markdown where the directive parses it, the bracket as written where
	it does not (escapeLatexText, as prose is escaped), an institution's line
	breaks as \\, and today's date as the same text.

	A document's `Title`/`Author`/`Date` header keys give \maketitle in a full
	LaTeX document, except when the body prints its own title (bodyPrintsTitle,
	below).

	`LaTeX maketitle` (default off; the owner, 2026-10-20) makes the title block
	LaTeX's own instead: \title{…}, \author{…} and \date{…}, then \maketitle,
	where the block stands (below).
*/
const TITLE_PAGE_LINES = {
	title:       (content) => `{\\noindent\\LARGE\\bfseries ${content.trim()}\\par}`,
	subtitle:    (content) => `{\\noindent ${content.trim()}\\par}`,
	author:      (content) => `{\\noindent\\large ${content.trim()}\\par}`,
	institution: (content) => `{\\noindent ${content.trim()}\\par}`,
	// The date closes the block in nearly every document: the gap after it is
	// the margin the next paragraph has in the HTML.
	date:        (content) => `{\\noindent\\large ${content.trim()}\\par}\\medskip`
};

function titlePageLine(kind, content) {
	const line = TITLE_PAGE_LINES[kind](content);
	if (kind === 'title') latexTitles.add(line);
	return `${line}\n\n`;
}

// Each kind's renderer, given the line's content and its token: the line, or,
// for a line of the title block `LaTeX maketitle` takes over, its part of it.
const titlePageLatex = Object.fromEntries(Object.keys(TITLE_PAGE_LINES).map((kind) => [kind,
	(content, token) => token?.jmdTitleRun ? titleRunPart(kind, content, token) : titlePageLine(kind, content)]));

/*
	`LaTeX maketitle`. The first run of title-page lines in the body — lines one
	after another, blank lines between them allowed, at the top level of the
	document and holding a title — becomes LaTeX's title page, where it stands:

		\title{Title\\{\large Subtitle}}
		\author{Author\\Institution \and Second author}
		\date{Date}
		\maketitle

	Several titles or dates are joined with \\; a subtitle is a smaller line
	under the title; an institution goes under the author before it, each
	author's set apart with \and. A part the block lacks is written empty —
	\author{}, \date{} — since the block is the title page, as it is in the HTML:
	LaTeX would print today's date, or a header's Author, which the page does not
	show. Any other title line stays a line: a second block (\maketitle works
	once), a block with no title, one nested in a container, and a book's
	chapter's (a book has one title page, the master's).

	The run is found before anything renders (a processAllTokens hook); each line
	then renders its content as always, and the last one writes the block. Every
	part is a macro's argument, so the lines' inline code and links are marked as
	a heading's are (token.jmdArgument, latex-renderer.js): \mintinline's
	delimiters and a `%` in a URL break there. A paragraph break, which \title
	cannot hold (an @begin(title) of two paragraphs), becomes \\.
*/
function latexMaketitle() {
	return configManager.get('LaTeX maketitle') === true;
}

// The kind of title-page line a token is, or null. Override sigils
// (`@.title+[…]`) render the same line in LaTeX, so they count.
function titleKind(token) {
	const name = token.meta?.marker?.startsWith('::') ? token.meta.name
		: ['atBlock', 'atInline', 'beginEnd'].includes(token.type) && token.literal === undefined && !token.misplaced ? token.name
		: null;
	return Object.hasOwn(TITLE_PAGE_LINES, name ?? '') ? name : null;
}

// A top-level token's title-page lines: a block form, or a paragraph that
// holds nothing but inline ones (`@title[…]` and `@author[…]` on lines of
// their own). Null for anything else.
function titleLinesIn(token) {
	if (titleKind(token)) return [token];
	if (token.type !== 'paragraph' || !token.tokens) return null;
	const lines = token.tokens.filter(titleKind);
	const others = token.tokens.filter((t) => !titleKind(t));
	if (lines.length && others.every((t) => t.type === 'br' || (t.type === 'text' && !t.text.trim()))) return lines;
	return null;
}

function markArgumentTokens(tokens) {
	for (const token of tokens ?? []) {
		if (token.type === 'codespan' || token.type === 'link') token.jmdArgument = true;
		markArgumentTokens(token.tokens);
	}
}

function markTitleRun(tokens) {
	if (!global.isLatex || !latexMaketitle()) return tokens;
	let lines = [];
	let inChapter = false;
	for (const token of tokens) {
		// Whitespace, and marked-footnote's list (nothing, in LaTeX), keep a run.
		if (token.type === 'space' || token.type === 'footnotes') continue;
		// book.js's chapter edges.
		if (token.type === 'jmdChapter') inChapter = token.edge === 'start';
		const found = inChapter ? null : titleLinesIn(token);
		if (found) {
			lines.push(...found);
			continue;
		}
		if (lines.some((line) => titleKind(line) === 'title')) break;
		lines = [];
	}
	if (!lines.some((line) => titleKind(line) === 'title')) return tokens;
	const run = { parts: [], last: lines.at(-1) };
	for (const line of lines) {
		line.jmdTitleRun = run;
		markArgumentTokens(line.tokens);
	}
	return tokens;
}

marked.use({ hooks: { processAllTokens: markTitleRun } });

function titleRunPart(kind, content, token) {
	const run = token.jmdTitleRun;
	run.parts.push({ kind, content: content.trim().replace(/\s*\n\s*\n\s*/g, '\\\\\n') });
	return token === run.last ? titleRunLatex(run.parts) : '';
}

function titleRunLatex(parts) {
	const of = (kind) => parts.filter((part) => part.kind === kind).map((part) => part.content);
	const title = [...of('title'), ...of('subtitle').map((subtitle) => `{\\large ${subtitle}}`)].join('\\\\');
	const authors = [];
	for (const { kind, content } of parts) {
		if (kind === 'author' || (kind === 'institution' && !authors.length)) authors.push(content);
		else if (kind === 'institution') authors[authors.length - 1] += `\\\\${content}`;
	}
	const block = `\\title{${title}}\n\\author{${authors.join(' \\and ')}}\n\\date{${of('date').join('\\\\')}}\n\\maketitle`;
	latexTitles.add(block);
	return `${block}\n\n`;
}

/*
	Whether a full LaTeX document's body prints its own title — a `@title+`,
	`::title` or any other form of the title directive — so that \maketitle
	would give it two. The HTML shows a `Title` header only in the page's
	<title>, so such a document shows one title there; latex-template.js asks
	this and, when it is so, leaves out \maketitle (the owner, 2026-10-11:
	"match the HTML").

	Asked of the finished body, not answered by a flag: a title rendered and
	then dropped (inside @begin(HTML), say) is not in the body, and nor is a
	title from an earlier build in the same process. The lines are forgotten
	once asked.
*/
const latexTitles = new Set();

export function bodyPrintsTitle(body) {
	const found = [...latexTitles].some((line) => body.includes(line));
	latexTitles.clear();
	return found;
}

// The date `today` prints: "11 October 2026".
function todayText() {
	const months = ['January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'];
	const today = new Date();
	return `${today.getDate()} ${months[today.getMonth()]} ${today.getFullYear()}`;
}

const additionalDirectives = [
	{
		'level': 'block',
		'marker': "::",
		label: "title",
		renderer(token) {
			if (token.meta.name === "title") {
				if (global.isLatex) return titlePageLatex.title(this.parser.parseInline(token.tokens), token);
				let html = marked.parser(token.tokens);
				html = html.replace(/<\/?p>/g, '');
				return `<div class="title">${html}</div>`;
			}
			return false;
		}
	},
	{
		'level': 'block',
		'marker': "::",
		label: "subtitle",
		renderer(token) {
			if (token.meta.name === "subtitle") {
				if (global.isLatex) return titlePageLatex.subtitle(this.parser.parseInline(token.tokens), token);
				let html = marked.parser(token.tokens);
				html = html.replace(/<\/?p>/g, '');
				return `<div class="subtitle">${html}</div>`;
			}
			return false;
		}
	},
	{
		'level': 'block',
		'marker': "::",
		label: "author",
		renderer(token) {
			if (token.meta.name === "author") {
				if (global.isLatex) return titlePageLatex.author(escapeLatexText(token.text), token);
				return `<div class="author">${token.text}</div>`;
			}
			return false;
		}
	},
	{
		'level': 'block',
		'marker': "::",
		label: "institution",
		tokenizer(text, token) {
			text = text.trim();
			text = text.replaceAll("\n", "<br>");
			token.tokens = this.lexer.inlineTokens(text);
		},
		renderer(token) {
			if (token.meta.name === "institution") {
				// The tokenizer made each line break a <br>, which LaTeX writes \\.
				if (global.isLatex) {
					return titlePageLatex.institution(this.parser.parseInline(token.tokens).replaceAll('<br>', '\\\\'), token);
				}
				let html = marked.parser(token.tokens);
				html = html.replace(/<\/?p>/g, '');
				return `<div class="institution">${html}</div>`;
			}
			return false;
		}
	},
	{
		'level': 'block',
		'marker': "::",
		label: "date",
		renderer(token) {
			if (token.meta.name === "date") {
				const content = this.parser.parseInline(token.tokens);
				if (global.isLatex) return titlePageLatex.date(content, token);
				return `<div class="date">${content}</div>`;
				// return `<div class="date">${token.text}</div>`;
			}
			return false;
		}
	},
	{
		'level': 'inline',
		'marker': ":",
		label: "today",
		renderer(token) {
			if (token.meta.name === "today") {
				if (global.isLatex) return todayText();
				return `<span class="date">${todayText()}</span>`;
			}
			return false;
		}
	},
	{
		'level': 'inline',
		'marker': ":",
		label: "label",
		renderer(token) {
			if (token.meta.name === "label") {
				// LaTeX: emit \label and let the engine attach it to the current
				// counter (works inside \section{…} and after captions).
				if (global.isLatex) return `\\label{${token.text}}`;
				// HTML: an invisible, anchored marker. The post-processor reads
				// the nearest preceding number for it; the id is the :ref target.
				const key = token.text.replaceAll("'", '&#39;');
				return `<span class='xref-label' id='xref-${key}' data-key='${key}'></span>`;
			}
			return false;
		}
	},
	{
		'level': 'inline',
		'marker': ":",
		label: "ref",
		renderer(token) {
			if (token.meta.name === "ref") {
				// LaTeX: native \ref (bare number). HTML: a placeholder the
				// post-processor turns into a hyperlink carrying the number.
				if (global.isLatex) return `\\ref{${token.text}}`;
				return `<span class='xref-ref' data-key='${token.text.replaceAll("'", '&#39;')}'></span>`;
			}
			return false;
		}
	},
	{
		'level': 'inline',
		'marker': ":",
		label: "cref",
		renderer(token) {
			if (token.meta.name === "cref") {
				// Typed reference: "section 3". LaTeX uses cleveref's \cref
				// (loaded on demand); HTML resolves the type word + number in
				// the post-processor.
				if (global.isLatex) { requirePackage('cleveref'); return `\\cref{${token.text}}`; }
				const key = token.text.replaceAll("'", '&#39;');
				return `<span class='xref-cref' data-key='${key}' data-cap='0'></span>`;
			}
			return false;
		}
	},
	{
		'level': 'inline',
		'marker': ":",
		label: "Cref",
		renderer(token) {
			if (token.meta.name === "Cref") {
				// Sentence-start typed reference: "Section 3" → cleveref's \Cref.
				if (global.isLatex) { requirePackage('cleveref'); return `\\Cref{${token.text}}`; }
				const key = token.text.replaceAll("'", '&#39;');
				return `<span class='xref-cref' data-key='${key}' data-cap='1'></span>`;
			}
			return false;
		}
	},
	/*
		:TeX[...] — emit the bracketed content verbatim in LaTeX output,
		emit nothing in HTML output.  Use for output-format-specific LaTeX
		commands (e.g. :TeX[\noindent] before a paragraph that should not
		be indented in the print version).
	*/
	{
		'level': 'inline',
		'marker': ":",
		label: "TeX",
		renderer(token) {
			if (token.meta.name === "TeX") {
				return global.isLatex ? token.text : '';
			}
			return false;
		}
	},
	/*
		:HTML[...] — inverse of :TeX.  Emit the bracketed content in HTML
		output (with markdown inline syntax processed normally), emit
		nothing in LaTeX output.  Use for HTML-specific inline markup in
		dual-output documents, e.g. an inline link to a web-only resource
		that should be rendered with any markdown formatting inside it.
	*/
	{
		'level': 'inline',
		'marker': ":",
		label: "HTML",
		renderer(token) {
			if (token.meta.name === "HTML") {
				return global.isLatex ? '' : this.parser.parseInline(token.tokens);
			}
			return false;
		}
	},
	/*
		:::TeX ... ::: — container form of :TeX[...].  Emit the block
		content verbatim in LaTeX output, emit nothing in HTML output.
		Use for block-level LaTeX that has no inline equivalent, e.g.
		a full \begin{figure}...\end{figure} block, a tabular environment,
		or a TiKZ picture that should only appear in the print version.

		The empty custom tokenizer is deliberate: its presence causes
		createToken() to skip marked's default block lexer for the
		container's content, so raw LaTeX (backslashes, dollar signs,
		braces) is preserved verbatim on token.text.  Running markdown
		processing on LaTeX source would actively corrupt it (e.g. $...$
		math would be eaten by the latex extension, _x_ would become
		italics).
	*/
	{
		'level': 'container',
		'marker': ":::",
		label: "TeX",
		tokenizer(text, token) {
			// Intentionally empty: token.text has already been set by
			// createToken(), and we don't want marked's lexer to run on
			// the raw LaTeX content.
		},
		renderer(token) {
			if (token.meta.name === "TeX") {
				return global.isLatex ? token.text : '';
			}
			return false;
		}
	},
	/*
		:::HTML ... ::: — inverse of :::TeX.  Emit the block content in
		HTML output (with markdown syntax processed normally), emit
		nothing in LaTeX output.  Use for block-level content that
		should only appear in the web version.

		Unlike :::TeX, markdown processing is enabled inside :::HTML —
		content here is typically prose, and writing raw <p> tags around
		every paragraph would defeat the point of a markdown authoring
		system.  Raw HTML (iframes, <details>, custom elements) still
		passes through since marked supports inline HTML by default.
	*/
	{
		'level': 'container',
		'marker': ":::",
		label: "HTML",
		renderer(token) {
			if (token.meta.name === "HTML") {
				return global.isLatex ? '' : marked.parser(token.tokens);
			}
			return false;
		}
	},
	/*
		:print[...] / :web[...] — inline conditional content (markdown inline
		processed). :print appears only in LaTeX output, :web only in HTML.
		Where :TeX/:HTML are about raw LaTeX/HTML *markup*, print/web are about
		which output a piece of ordinary prose belongs to in one source.
	*/
	{
		'level': 'inline',
		'marker': ":",
		label: "print",
		renderer(token) {
			if (token.meta.name === "print") {
				return global.isLatex ? this.parser.parseInline(token.tokens) : '';
			}
			return false;
		}
	},
	{
		'level': 'inline',
		'marker': ":",
		label: "web",
		renderer(token) {
			if (token.meta.name === "web") {
				return global.isLatex ? '' : this.parser.parseInline(token.tokens);
			}
			return false;
		}
	},
	/*
		:::print ... ::: / :::web ... ::: — block conditional content (markdown
		processed). :::print appears only in LaTeX output, :::web only in HTML —
		e.g. a static figure for print vs. an interactive widget for the web,
		from a single source.
	*/
	{
		'level': 'container',
		'marker': ":::",
		label: "print",
		renderer(token) {
			if (token.meta.name === "print") {
				return global.isLatex ? marked.parser(token.tokens) : '';
			}
			return false;
		}
	},
	{
		'level': 'container',
		'marker': ":::",
		label: "web",
		renderer(token) {
			if (token.meta.name === "web") {
				return global.isLatex ? '' : marked.parser(token.tokens);
			}
			return false;
		}
	},
	{
		'level': 'container',
		'marker': ":::",
		label: "abstract",
		renderer(token) {
			if (token.meta.name === "abstract") {
				return renderAbstract(marked.parser(token.tokens));
			}
			return false;
		}
	},
	{
		'level': 'container',
		'marker': ":::",
		label: "feedback",
		renderer(token) {
			if (token.meta.name === "feedback") {
				return renderFeedback(marked.parser(token.tokens));
			}
			return false;
		}
	}
];

export const titleBox = {
		'level': 'container',
		'marker': ":::",
		label: "title-box",
		tokenizer(text, token) {
			// Title and body are separated by a line of three or more asterisks.
			// When the author omits the separator, render the whole content as
			// the body with an empty title rather than crashing on an undefined
			// half of the split.
			token['title'] = [];
			token['body'] = [];
			if (text.includes('***')) {
				const [title, body] = text.split(/\*{3,}/);
				this.lexer.blockTokens(title, token['title']);
				this.lexer.blockTokens(body, token['body']);
			} else {
				this.lexer.blockTokens(text, token['body']);
			}
		},
		renderer(token) {
			if (token.meta.name === "title-box") {
				// LaTeX: a tcolorbox with the title in its title bar — the box the
				// stylesheet draws (a coloured title bar over a bordered body) —
				// breakable, so a long body runs onto the next page. The same
				// tcolorbox libraries as the callouts, so the preamble line is one.
				// It used to receive the HTML divs.
				if (global.isLatex) {
					requirePackage('tcolorbox');
					addPreamble('\\tcbuselibrary{skins,breakable}');
					const title = this.parser.parse(token['title']).trim();
					const body = this.parser.parse(token['body']).trim();
					const options = title ? `breakable, title={${title}}` : 'breakable';
					return `\\begin{tcolorbox}[${options}]\n${body}\n\\end{tcolorbox}\n\n`;
				}
				const title = this.parser.parse(token['title']);
				const body = this.parser.parse(token['body']);
				return `<div class="title-box"><div class='title'>${title}</div><div class='body'>${body}</div></div>`;
			}
			return false;
		}
	};

// This directive is just a minimal template to show how extended-directives.js
// allow you to specify a custom tokenizer, as well.  (The default marked-directives package
// doesn't provide that capability.)
const pass_through = {
	level: 'container',
	marker: ':::',
	label: "plaintext",
	tokenizer: function(text, token) {
	    console.log("Called by the plaintext tokenizer");
	  	console.log(token);
	},
	renderer(token) {
		if (token.meta.name == "plaintext") {
			console.log("Called by the plaintext renderer");
			console.log(token);
			return "Consumed plaintext";
		}
		return false;
	}
};

// And here's how you would install it.
//marked.use( createDirectives([pass_through]) );


/*
	@-sigil ports of the title-box container and the six title-page directives,
	sharing the begin-end registry (the ':'/'::'/'::' colon forms stay live).

	title-box reuses the directive's own tokenizer + renderer verbatim (the game/TiKZ
	no-drift pattern). The title-page group are block forms `@name+[…]` (they emit
	block <div>s) except @today, which is inline (a <span>, used bare). Output matches
	the colon twins: title/subtitle/date use the parsed inner (inline-parsed here — the
	<p>-stripped equivalent of the originals' block parse); author uses the raw bracket
	text; institution turns newlines into <br>; today regenerates the date. LaTeX, as
	the colon twins print it (titlePageLatex, above).
*/
registerBlockEnvironment('title', {
	html: (ctx) => `<div class="title">${ctx.inner}</div>`,
	latex: (ctx) => titlePageLatex.title(ctx.inner, ctx.token)
});
registerBlockEnvironment('subtitle', {
	html: (ctx) => `<div class="subtitle">${ctx.inner}</div>`,
	latex: (ctx) => titlePageLatex.subtitle(ctx.inner, ctx.token)
});
registerBlockEnvironment('author', {
	html: (ctx) => `<div class="author">${ctx.text}</div>`,
	latex: (ctx) => titlePageLatex.author(escapeLatexText(ctx.text), ctx.token)
});
registerBlockEnvironment('institution', {
	html: (ctx) => `<div class="institution">${ctx.text.trim().replaceAll('\n', '<br>')}</div>`,
	latex: (ctx) => titlePageLatex.institution(escapeLatexText(ctx.text.trim()).replaceAll('\n', '\\\\'), ctx.token)
});
registerBlockEnvironment('date', {
	html: (ctx) => `<div class="date">${ctx.inner}</div>`,
	latex: (ctx) => titlePageLatex.date(ctx.inner, ctx.token)
});
registerBlockEnvironment('today', {
	html: () => `<span class="date">${todayText()}</span>`,
	latex: () => todayText()
});
registerBlockEnvironment('title-box', {
	mode: 'custom',
	tokenize(body, token) {
		token.meta = { name: 'title-box' };
		titleBox.tokenizer.call(this, '\n' + body.replace(/\n+$/, ''), token);
	},
	render: (ctx) => titleBox.renderer.call({ parser: ctx.parser }, ctx.token)
});


export default additionalDirectives;