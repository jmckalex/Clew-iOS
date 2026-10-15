import { registerBlockEnvironment } from './begin-end-core.js';
import { marked, marked_copy } from './utils.js';

export const targets = {
	level: 'inline',
	label: 'target',
	marker: ':',
	renderer(token) {
		if (token.meta.name === "target") {
			// `:target` with no `[…]` (prose such as Meta Bind's
			// `INPUT[number:target]`, or `:target{…}`) names no target: its text
			// prints as it stands, exactly as a text token would, as if the rule
			// had not matched. It used to throw (`token.text` undefined) and stop
			// the build.
			if (typeof token.text !== 'string') {
				return this.parser.renderer.text({ type: 'text', raw: token.raw, text: token.raw });
			}
			if (global.isLatex) return latexTarget(this.parser, token);
			return `<span data-target-id='${token.text.trim()}'></span>`;
		}
		return false;
	}
}

export const sources = {
	level: 'container',
	label: "source",
	// tokenizer: function(text, token) {
	// 	token.text = text.replace("\n", '');
	// 	return token;
	// },
	renderer(token) {
		if (token.meta.name === "source") {
			// LaTeX: the content goes to its targets (latexTarget); here, nothing.
			if (global.isLatex) return '';
			const target = token.attrs.target.trim();
			return `<div data-target='${target}'>${this.parser.parse(token.tokens)}</div>`;
		}
		return false;
	}
};


export const inlineTarget = {
	name: 'inlineTarget',
	level: 'inline',
	start(src) { return src.match(/🎯/)?.index },
	tokenizer(src) {
		const match = src.match(/^🎯([a-zA-Z0-9_-]+)/);
		if (match) {
			const token = {
				type: 'inlineTarget',
				raw: match[0],
				text: match[1].trim(),
				tokens: []
			};
			return token;
		}
	},
	renderer(token) {
		if (global.isLatex) return latexTarget(this.parser, token);
		return `<span data-target-id='${token.text}'></span>`;
	}
};


/*
	@-sigil ports of the colon forms, sharing the begin-end registry (the ':::source'
	container and ':target' inline stay live alongside). The emoji `🎯` inlineTarget is
	not a colon directive; it is a third spelling of a target.

	  @begin(source){target=X} … @end(source)   ≡  :::source{target=X} … :::
	  @target[X]                                 ≡  :target[X]  ≡  🎯X
*/
registerBlockEnvironment('source', {
	mode: 'markdown',
	html: (ctx) => `<div data-target='${(ctx.attrs?.target ?? '').trim()}'>${ctx.inner}</div>`,
	latex: () => ''
});
registerBlockEnvironment('target', {
	mode: 'verbatim',
	html: (ctx) => `<span data-target-id='${ctx.text.trim()}'></span>`,
	latex: (ctx) => latexTarget(ctx.parser, ctx.token)
});


/*
	LaTeX. The HTML moves each source to its targets once the page is built
	(replaceTargetsBySources, below, over the DOM), and the LaTeX output has no
	such pass — so a LaTeX build used to print the markers themselves
	(`<div data-target='X'>…</div>`, `<span data-target-id='X'></span>`), with the
	source's content where it was written. The move is made in the tokens instead:
	every token is lexed before any is rendered, so a processAllTokens hook walks
	the parse's whole token tree once, finds the FIRST source for each target name
	in document order, and links each target token to it (`jmdSource`). A target
	then renders its source's content where it stands, and a source renders
	nothing where it was written. That is what the HTML shows: the first source
	with a name fills each of its targets, and a source with no target — or a
	second source with the same name — is gone. A target with no source is nothing
	in both. A book is one parse, so its sources reach targets in any chapter, as
	in the HTML, where the DOM pass runs over the whole book before any split.

	The links live on the token tree, so nothing carries from one parse to the
	next. LaTeX builds only (the HTML path is untouched). A target inside its own
	source would render the source inside itself forever, so a source being
	rendered gives nothing to a target within it (`rendering`, emptied by a
	finally even when a render throws).

	A table cell is where a source matters most — a Markdown table cannot hold a
	code block or two paragraphs, and a target puts them there — and LaTeX cannot
	set a listing or a paragraph break in a tabular cell either. So a target in a
	table's cells is also given the table's column count (`jmdCellColumns`), and
	block content (a blank line, or an environment) for it is set in a top-aligned
	minipage, an equal share of the line wide: \linewidth over the columns, less
	the cell's padding. (varwidth would fit the box to its content, but a listing
	is always \linewidth wide, which pushes the next column off the page.)
*/
const TABLES = new Set(['table', 'spanTable', 'headerlessTable']);

function sourceName(token) {
	const isSource = (token.type === 'beginEnd' && token.name === 'source')
		|| (token.meta?.level === 'container' && token.meta?.name === 'source');
	const target = isSource ? token.attrs?.target : undefined;
	return target === undefined || target === null ? null : String(target).trim();
}

// :target[X], @target[X] (or @target+[X]) and 🎯X; a :target with no [X] is prose.
function targetName(token) {
	const isTarget = token.type === 'inlineTarget'
		|| ((token.type === 'atInline' || token.type === 'atBlock') && token.name === 'target')
		|| (token.meta?.level === 'inline' && token.meta?.name === 'target');
	return isTarget && typeof token.text === 'string' ? token.text.trim() : null;
}

// Tokens are plain objects and arrays; nothing else in a tree holds tokens.
const isPlain = (value) => Array.isArray(value)
	|| (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);

export function linkSourcesAndTargets(tokens) {
	if (!global.isLatex) return tokens;
	const sources = new Map();
	const targets = [];
	const seen = new Set();
	const visit = (value, columns) => {
		if (!isPlain(value) || seen.has(value)) return;
		seen.add(value);
		if (!Array.isArray(value)) {
			const target = targetName(value);
			if (target !== null) targets.push({ token: value, name: target, columns });
			const source = sourceName(value);
			if (source !== null && !sources.has(source)) sources.set(source, value.tokens || []);
			if (TABLES.has(value.type)) columns = value.align?.length || 1;
		}
		for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, columns);
	};
	visit(tokens, 0);
	for (const { token, name, columns } of targets) {
		token.jmdSource = sources.get(name) ?? null;
		if (columns) token.jmdCellColumns = columns;
	}
	return tokens;
}

const rendering = new WeakSet();

function latexTarget(parser, token) {
	const tokens = token.jmdSource;
	if (!tokens || rendering.has(tokens)) return '';
	rendering.add(tokens);
	let content;
	try {
		content = parser.parse(tokens).trim();
	} finally {
		rendering.delete(tokens);
	}
	const columns = token.jmdCellColumns;
	if (columns && /\n[ \t]*\n|\\begin\{/.test(content)) {
		return `\\begin{minipage}[t]{\\dimexpr\\linewidth/${columns}-2\\tabcolsep\\relax}\n${content}\n\\end{minipage}`;
	}
	return content;
}

marked.use({ hooks: { processAllTokens: linkSourcesAndTargets } });
marked_copy.use({ hooks: { processAllTokens: linkSourcesAndTargets } });


export function replaceTargetsBySources($) {
	$('[data-target]').each(function () {
		const $sourceElement = $(this);
		const targetID = $sourceElement.attr('data-target');
		// Find all target elements
		$(`[data-target-id='${targetID}']`).each(function() {
			const $targetElement = $(this);
			$sourceElement.removeAttr('data-target');
			$targetElement.replaceWith($sourceElement.clone());
		});
		$sourceElement.remove();
	})
}


