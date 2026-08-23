/*
	Named-scope block environments for marked.js — the generic core.

	Adds `@begin(name) … @end(name)` as an alternative to colon-counted container
	directives.  Because the closer *names* what it closes, blocks nest by name
	instead of by colon count — so you can wrap a block in a new one, or drop a
	block into the middle of another, without renumbering any neighbours.

	The `@` opener follows the texinfo `@example … @end example` convention; it is
	otherwise an unused sigil, so it never collides with prose.

	Arguments reuse the directive convention, with one bracket type per job:

		@begin(name)[label]{class="foo" id="bar"}
		       ^^^^  ^^^^^  ^^^^^^^^^^^^^^^^^^^^^^
		       name  text   attributes

	HTML output — the name becomes either a `<div class="name">` or a custom
	element `<name>`:

		@begin(aside)   → <aside>…</aside>            (a known HTML element → itself)
		@begin(name)    → <div class="name">…</div>   (unknown, no hyphen → class)
		@begin(na-me)   → <na-me>…</na-me>            (hyphen → custom element)
		@begin(.name)   → <div class="name">…</div>   (`.` forces a class)
		@begin(<name>)  → <name>…</name>             (`<…>` forces an element)

	Under the default policy a name that is a real HTML block-container element
	(`aside`, `section`, `figure`, …) renders as that element, so an author never
	has to remember the `<…>` sigil for the semantic containers.  Otherwise the
	hyphen rule applies, following the HTML spec: a *valid* custom-element name
	must contain a hyphen, so a hyphenated name is an element and anything else is
	a `div.class`.  Both defaults are overridable per block with the `.` / `<…>`
	sigils above, and document-wide with the `blockElements` option — `hyphenated`
	(default: known elements + hyphenated names → element), `all` (always an
	element) or `none` (always a class).  The per-block sigils always win over the
	policy.  The known-element list is consulted only for *block* forms — an inline
	`@name[…]` can't hold a block element inside its `<p>`, so it keeps the plain
	hyphen rule.

	Nesting: differently-named blocks nest for free (the inner block is just part
	of the outer block's markdown content and is re-lexed normally).  Only
	*same-name* nesting needs care, so the tokenizer depth-counts `@begin(name)`
	against `@end(name)` to find the right closer.  An opener with no matching
	closer is left literal (with a warning) rather than swallowing the rest of the
	document or throwing.

	Indentation: openers and closers may sit at any indentation — `@begin`/`@end`
	are found regardless of leading whitespace — so nested blocks can be indented
	for readability, in any style, or not at all.  Each block then strips the
	common leading whitespace from its own body (dedent) before processing;
	relative indentation (e.g. inside a fenced code block) is preserved.

	--- Generic by design -------------------------------------------------------

	This module is deliberately free of any project coupling and of any knowledge
	of LaTeX (or any output format other than HTML).  All format- and
	project-specific behaviour is injected through `createBeginEnd(options)` and
	the block-environment registry, so the file can be lifted out and published as
	a standalone marked extension unchanged.  (In JMarkdown, begin-end.js is the
	layer that adds the LaTeX output and the parity environments.)
*/

import attributesParser from 'attributes-parser';

/* --- The block-environment registry ----------------------------------------

	name → handler.  A handler shapes how one named environment is lexed and
	rendered:

		{
			mode:     'markdown' | 'verbatim' | 'custom',  // how the body is lexed
			tokenize: function (body, token) { … },         // only for mode 'custom'
			html:     (ctx) => string,                      // the one required renderer
			latex:    (ctx) => string,                      // optional, per output format
			render:   (ctx) => string,                      // format-independent alt.
		}

	ctx = { name, attrs, text, inner, rawText, override, format, parser, token }.

	Output dispatch is a single line — `handler[format] || handler.html ||
	handler.render`.  Because the default format is 'html', the core never needs
	any key other than `html`/`render`; extra-format renderers (e.g. `latex`) are
	purely additive and can be deleted without touching the core.

	The registry is module-level so any module can register an environment
	independently of where the extension is built (createBeginEnd).
*/
const registry = new Map();

export function registerBlockEnvironment(name, handler) {
	registry.set(name, handler);
}

export function getBlockEnvironment(name) {
	return registry.get(name);
}

function regexEscape(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Strip the common leading-whitespace prefix shared by all non-blank lines, so a
// nested block's body can be indented for readability and still be processed as
// if it were at column 0.  Works on the actual whitespace prefix (not a count),
// so it's correct for tabs or spaces; relative indentation within the body
// (e.g. inside a code fence) is preserved.  Top-level bodies are unindented, so
// this is a no-op there.
function dedent(text) {
	const lines = text.split('\n');
	let prefix = null;
	for (const line of lines) {
		if (line.trim() === '') continue;                 // ignore blank lines
		const ws = line.match(/^[ \t]*/)[0];
		if (prefix === null) { prefix = ws; continue; }
		let i = 0;
		while (i < prefix.length && i < ws.length && prefix[i] === ws[i]) i++;
		prefix = prefix.slice(0, i);
		if (prefix === '') break;
	}
	if (!prefix) return text;
	return lines.map(l => l.startsWith(prefix) ? l.slice(prefix.length) : l).join('\n');
}

// Curated list of HTML elements that legitimately contain block/flow content, so
// a bare @begin(aside) can render as <aside> rather than <div class="aside">
// without the author having to remember the <…> element sigil. Sectioning +
// grouping flow-content containers only (list/table internals and <p> are left
// out — markdown produces those natively and they have strict content models).
// Compared case-insensitively.
const BLOCK_CONTAINER_ELEMENTS = new Set([
	'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div',
	'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'hgroup',
	'main', 'nav', 'search', 'section', 'summary'
]);

// Decide the HTML tag for a generic environment: 'div' (name as a CSS class) or
// the name itself (a custom or known-HTML element). The per-block override
// ('class'/'element') always wins; otherwise the policy ('hyphenated' | 'all' |
// 'none') decides. `isBlock` is false for the inline @name[…] form, which skips
// the known-block-element list (a block element can't sit inside its <p>).
function resolveTag(name, override, policy, isBlock = true) {
	if (override === 'class') return 'div';
	if (override === 'element') return name;
	const p = String(policy || 'hyphenated').toLowerCase();
	if (p === 'all') return name;     // everything is a custom element
	if (p === 'none') return 'div';   // everything is a div.class
	// 'hyphenated' (default): a known HTML block-container element (aside,
	// section, …) or a hyphenated custom-element name renders as itself; anything
	// else is a div.class.
	if (isBlock && BLOCK_CONTAINER_ELEMENTS.has(name.toLowerCase())) return name;
	return name.includes('-') ? name : 'div';
}

// Render a generic environment to HTML as either <div class="name"> or a custom
// element <name>. The optional [text] is exposed as a data-label attribute.
function renderGenericHTML(name, attrs, text, inner, override, policy) {
	const tag = resolveTag(name, override, policy);
	const label = text ? ` data-label="${String(text).replace(/"/g, '&quot;')}"` : '';
	let attrStr = attrs ? String(attrs).trim() : '';

	if (tag === 'div') {
		// The name becomes a class; merge into any author-supplied class rather
		// than emit two class attributes (the browser would drop one).
		const classRe = /class\s*=\s*"([^"]*)"/;
		if (classRe.test(attrStr)) {
			attrStr = attrStr.replace(classRe, (_m, c) => `class="${name} ${c}"`);
			return `<div ${attrStr}${label}>\n${inner}\n</div>\n`;
		}
		const a = attrStr ? ' ' + attrStr : '';
		return `<div class="${name}"${a}${label}>\n${inner}\n</div>\n`;
	}

	// Custom element: the name is the tag; author attrs pass through unchanged.
	const a = attrStr ? ' ' + attrStr : '';
	return `<${tag}${a}${label}>\n${inner}\n</${tag}>\n`;
}

/*
	Build the marked block extension.  Options (all optional, all defaulting to
	HTML-only behaviour so the bare `createBeginEnd()` is a complete standalone
	extension):

		getFormat()    → the current output format string (default 'html').
		blockElements  → the div/element policy: 'hyphenated' (default) | 'all' |
		                 'none', or a function returning one of those.
		fallback       → a handler for any unregistered name; merged over the
		                 built-in generic-HTML fallback (so a host can add e.g. a
		                 `latex` renderer while keeping the default `html`).
		orphan         → { html, [format]… } for an opener with no matching @end;
		                 merged over the built-in HTML (escaped paragraph) form.
*/
export function createBeginEnd(options = {}) {
	const getFormat = options.getFormat || (() => 'html');
	const policy = options.blockElements || 'hyphenated';
	const resolvePolicy = typeof policy === 'function' ? policy : () => policy;

	// Handler for any name with no registered environment. A host may add a
	// `latex` (or other-format) renderer via options.fallback; it merges over the
	// generic-HTML default below.
	const fallback = {
		mode: 'markdown',
		html: (ctx) => renderGenericHTML(ctx.name, ctx.attrs, ctx.text, ctx.inner, ctx.override, resolvePolicy()),
		...(options.fallback || {})
	};

	// Handler for an orphan opener (no matching @end): emit the opener line
	// verbatim. HTML escapes it into a paragraph; a host may add other formats.
	const orphan = {
		html: (literal) => `<p>${literal.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>\n`,
		...(options.orphan || {})
	};

	const handlerFor = (name) => registry.get(name) || fallback;

	return {
		name: 'beginEnd',
		level: 'block',

		start(src) {
			// Allow leading whitespace so indented (nested) openers are found, which
			// also lets marked break a paragraph before an indented @begin line.
			const m = src.match(/(?:^|\n)[ \t]*@begin\(/);
			if (!m) return undefined;
			return m.index + (src[m.index] === '\n' ? 1 : 0);
		},

		tokenizer(src) {
			// Opener line: @begin(name) — name optionally prefixed `.` (force class)
			// or wrapped in <…> (force element) — then optional [text] and/or {attrs}.
			// Leading whitespace is allowed (indented nested blocks).
			const open = /^[ \t]*@begin\(\s*(\.|<)?\s*([A-Za-z][\w-]*)\s*(>)?\s*\)([^\n]*)(?:\n|$)/.exec(src);
			if (!open) return;
			const sigil = open[1];
			const name = open[2];
			const argStr = open[4] || '';
			const openLen = open[0].length;
			const override = sigil === '.' ? 'class' : sigil === '<' ? 'element' : undefined;

			const text = (argStr.match(/\[([^\]]*)\]/) || [])[1];
			const attrsMatch = argStr.match(/\{([^}]*)\}/);
			let attrs;
			if (attrsMatch) {
				try { attrs = attributesParser(attrsMatch[1]); } catch { attrs = undefined; }
			}

			// Find the matching @end(name), depth-counting same-name @begin(name).
			// Match by the bare name, allowing the optional `.`/`<…>` sigils on either
			// side. A begin line may carry trailing [text]{attrs}; an end line may not.
			const nameEsc = regexEscape(name);
			const scanRe = new RegExp(
				`^[ \\t]*@(?:(begin)\\(\\s*[.<]?\\s*${nameEsc}\\s*>?\\s*\\)[^\\n]*|(end)\\(\\s*[.<]?\\s*${nameEsc}\\s*>?\\s*\\)[ \\t]*)$`,
				'gm'
			);
			scanRe.lastIndex = openLen;
			let depth = 0, closeStart = -1, closeEnd = -1, m;
			while ((m = scanRe.exec(src)) !== null) {
				if (m[1]) {                                   // nested @begin(name)
					depth++;
				} else if (depth === 0) {                     // our matching @end(name)
					closeStart = m.index;
					closeEnd = scanRe.lastIndex;
					break;
				} else {                                      // a nested @end(name)
					depth--;
				}
			}
			if (closeStart === -1) {
				// No matching closer. Consume *only* the opener line and emit it
				// literally, so the orphan stands as its own paragraph (rather than
				// merging into the following prose) instead of swallowing the rest of
				// the document.
				console.error(`@begin(${name}) has no matching @end(${name}); leaving it literal.`);
				return { type: 'beginEnd', raw: open[0], literal: open[0].replace(/\n$/, '') };
			}

			// Dedent the body so an indented nested block is processed as if at
			// column 0 (recursively, at each level).
			const inner = dedent(src.slice(openLen, closeStart));
			let consumed = closeEnd;
			if (src[consumed] === '\n') consumed++;
			const mode = handlerFor(name).mode || 'markdown';

			const token = {
				type: 'beginEnd',
				raw: src.slice(0, consumed),
				name,
				text,
				attrs,
				override,
				mode,
				rawText: inner,
				// Re-lex markdown content so nested blocks / prose render normally;
				// verbatim and custom content is kept raw for the handler.
				tokens: mode === 'markdown' ? this.lexer.blockTokens(inner) : []
			};

			// A 'custom' environment shapes its own body (e.g. a payoff matrix); the
			// hook runs in the lexer context, so it has this.lexer for sub-tokenizing.
			if (mode === 'custom') {
				const handler = registry.get(name);
				if (handler && typeof handler.tokenize === 'function') {
					handler.tokenize.call(this, inner, token);
				}
			}
			return token;
		},

		renderer(token) {
			const format = getFormat();

			// Orphan opener (no matching @end) — emit the line verbatim.
			if (token.literal !== undefined) {
				const render = orphan[format] || orphan.html;
				return render(token.literal);
			}

			const inner = token.mode === 'markdown'
				? this.parser.parse(token.tokens).trim()
				: token.rawText;

			const handler = handlerFor(token.name);
			const ctx = {
				name: token.name,
				attrs: token.attrs,
				text: token.text,
				inner,
				rawText: token.rawText,
				override: token.override,
				format,
				parser: this.parser,
				token
			};

			// HTML is the guaranteed renderer; a format-specific (e.g. latex) or a
			// format-independent (render) one is used when present.
			const render = handler[format] || handler.html || handler.render;
			return render.call(this, ctx);
		}
	};
}

/* --- Inline / block single-shot forms: @name[text]{attrs} and @name+[…] -------

	The same named-environment registry, reached through two more call-shapes that
	parallel the old colon directives:

		@name[text]{attrs}    inline   (parity with the old `:name`  — default <span>)
		@name+[text]{attrs}   block    (parity with the old `::name` — default <div>)

	A trailing `+` on the name is the ONLY difference between the two: it flips the
	construct from an inline marked extension (placed inside the enclosing <p>) to a
	block one (a top-level element, never wrapped in <p>).  The block form is
	line-anchored — it is recognised only at the start of its own line, the one
	place a block extension can intercept a line before marked folds it into a
	paragraph; a `+`-form buried mid-sentence is left literal.

	Both dispatch to the SAME handler a name is registered with (registerBlock-
	Environment), so one definition serves `@name[…]`, `@name+[…]` and
	`@begin(name)…@end(name)`.  The ctx mirrors the @begin one, with `inline`/`block`
	flags and `text` carrying the raw bracket content (handlers that want a raw key,
	e.g. cross-references, read ctx.text; handlers that want formatted content read
	ctx.inner).
*/

// Generic inline fallback for an unregistered @name[…]: a hyphenated name becomes
// a custom element (valid inline), otherwise <span class="name"> — the inline
// twin of renderGenericHTML's div/element rule.
function renderGenericInlineHTML(name, attrs, inner, override, policy) {
	const tag = resolveTag(name, override, policy, false);   // 'div' marks the class case; inline skips the block-element list
	const attrStr = attrs ? String(attrs).trim() : '';
	const a = attrStr ? ' ' + attrStr : '';
	if (tag === 'div') return `<span class="${name}"${a}>${inner}</span>`;
	return `<${tag}${a}>${inner}</${tag}>`;
}

// Shared renderer: build the ctx and dispatch to handler[format]/html/render. The
// caller passes `this` (marked's renderer context) so handlers get this.parser.
function renderAtToken(self, token, getFormat, fallback) {
	const format = getFormat();
	const inner = token.mode === 'verbatim'
		? token.text
		: self.parser.parseInline(token.tokens);
	const handler = registry.get(token.name) || fallback;
	const ctx = {
		name: token.name,
		attrs: token.attrs,
		text: token.text,
		inner,
		rawText: token.text,
		override: token.override,
		format,
		parser: self.parser,
		token,
		inline: token.type === 'atInline',
		block: token.type === 'atBlock'
	};
	const render = handler[format] || handler.html || handler.render;
	return render.call(self, ctx);
}

export function createAtInline(options = {}) {
	const getFormat = options.getFormat || (() => 'html');
	const policy = options.blockElements || 'hyphenated';
	const resolvePolicy = typeof policy === 'function' ? policy : () => policy;
	const fallback = {
		html: (ctx) => renderGenericInlineHTML(ctx.name, ctx.attrs, ctx.inner, ctx.override, resolvePolicy()),
		...(options.fallback || {})
	};
	// Handler for a `@name+[…]` block form that reaches the INLINE pass — i.e. one
	// that was NOT at a line start (a line-start one is claimed by the block pass
	// first), so it is necessarily misplaced. A host can warn + mark via
	// options.misplaced(name, format); the default just emits a visible HTML marker.
	const misplaced = options.misplaced || ((name) => `<span class="jmd-error">[@${name}+ must start its own line]</span>`);

	return {
		name: 'atInline',
		level: 'inline',
		// Restrictive: only an @ NOT preceded by a word char (so `user@host` /
		// `me@x.com` stay prose and we don't starve marked's email autolinker by
		// splitting a valid address). Inline starts may otherwise match anywhere —
		// inline code spans are claimed before text is cut, so this is safe.
		// The optional `.`/`<` override sigil is allowed after the @ (see below).
		start(src) { return src.match(/(?<!\w)@[.<]?[A-Za-z][\w-]*/)?.index; },
		tokenizer(src, tokens) {
			// Backstop for the start() gate: when ANOTHER extension (e.g. the email
			// autolinker) breaks the text at a glued `@`, our tokenizer is still tried
			// there with the preceding char already sliced off. Read it from the
			// previous token's raw instead — reject an @ glued to a word char.
			const prev = tokens && tokens[tokens.length - 1];
			if (prev && typeof prev.raw === 'string' && /\w$/.test(prev.raw)) return;
			// A `@name+[…]`/`@name+{…}` here is a misplaced block form (see above);
			// the optional `.`/`<…>` override sigil is tolerated on the name.
			const bad = /^@(?:\.|<)?([A-Za-z][\w-]*)>?\+(\[[^\]]*\])?(\{[^}]*\})?/.exec(src);
			if (bad && (bad[2] !== undefined || bad[3] !== undefined)) {
				return { type: 'atInline', raw: bad[0], misplaced: bad[1] };
			}
			// Optional override sigil, parity with @begin(.name)/@begin(<name>):
			// `@.name[…]` forces a class (<span class="name">), `@<name>[…]` forces a
			// custom element (<name>). The sigil only affects the generic fallback —
			// a registered handler owns its own output.
			const m = /^@(\.|<)?([A-Za-z][\w-]*)>?(?:\[([^\]]*)\])?(?:\{([^}]*)\})?/.exec(src);
			if (!m) return;
			const sigil = m[1], name = m[2], text = m[3] ?? '', attrsRaw = m[4];
			const hasBracket = m[3] !== undefined || m[4] !== undefined;
			// A bracket form takes any name (generic fallback); a BARE @name is a
			// directive only if explicitly registered (so prose @-words aren't eaten).
			// A sigil form always needs a bracket for its content, so a bare `@.foo`
			// in prose is left alone.
			if (!hasBracket && (sigil || !registry.has(name))) return;
			const override = sigil === '.' ? 'class' : sigil === '<' ? 'element' : undefined;
			let attrs;
			if (attrsRaw !== undefined) { try { attrs = attributesParser(attrsRaw); } catch { attrs = undefined; } }
			const mode = (registry.get(name) || {}).mode || 'markdown';
			return {
				type: 'atInline', raw: m[0], name, text, attrs, override, mode,
				tokens: mode === 'verbatim' ? [] : this.lexer.inlineTokens(text)
			};
		},
		renderer(token) {
			if (token.misplaced !== undefined) return misplaced(token.misplaced, getFormat());
			return renderAtToken(this, token, getFormat, fallback);
		}
	};
}

export function createAtBlock(options = {}) {
	const getFormat = options.getFormat || (() => 'html');
	const policy = options.blockElements || 'hyphenated';
	const resolvePolicy = typeof policy === 'function' ? policy : () => policy;
	const fallback = {
		// Block: the bracket content is the body; no separate [label], so no data-label.
		html: (ctx) => renderGenericHTML(ctx.name, ctx.attrs, undefined, ctx.inner, ctx.override, resolvePolicy()),
		...(options.fallback || {})
	};

	return {
		name: 'atBlock',
		level: 'block',
		// Only ever report a line start its tokenizer can match (the anti-shredding
		// rule): an `@name+[` / `@name+{` at the beginning of a line.
		start(src) {
			const m = src.match(/(?:^|\n)[ \t]*@[.<]?[A-Za-z][\w-]*>?\+[\[{]/);
			if (!m) return undefined;
			return m.index + (src[m.index] === '\n' ? 1 : 0);
		},
		tokenizer(src) {
			// Optional `.`/`<…>` override sigil, parity with @begin(.name)/@begin(<name>):
			// `@.name+[…]` forces <div class="name">, `@<name>+[…]` forces a <name> element.
			const m = /^[ \t]*@(\.|<)?([A-Za-z][\w-]*)>?\+(?:\[([^\]]*)\])?(?:\{([^}]*)\})?[ \t]*(?:\n|$)/.exec(src);
			if (!m) return;
			const sigil = m[1], name = m[2], text = m[3] ?? '', attrsRaw = m[4];
			const override = sigil === '.' ? 'class' : sigil === '<' ? 'element' : undefined;
			let attrs;
			if (attrsRaw !== undefined) { try { attrs = attributesParser(attrsRaw); } catch { attrs = undefined; } }
			const mode = (registry.get(name) || {}).mode || 'markdown';
			return {
				type: 'atBlock', raw: m[0], name, text, attrs, override, mode,
				tokens: mode === 'verbatim' ? [] : this.lexer.inlineTokens(text)
			};
		},
		renderer(token) { return renderAtToken(this, token, getFormat, fallback); }
	};
}

export default createBeginEnd;
