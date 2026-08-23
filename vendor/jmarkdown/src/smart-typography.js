/*
	Smart typography — an OPT-IN typographic educator.
	Metadata/config key: `Smart typography: true` (default off).

	Converts ASCII approximations in prose to their Unicode typographic forms:

	    "x"  'x'    →  “x” ‘x’      (context-sensitive opening/closing)
	    don't, '90s →  don’t, ’90s  (apostrophes)
	    --- --      →  — –          (em dash, en dash)
	    ...         →  …

	Applied to LEAF inline `text` tokens via a walkTokens hook, so everything
	the lexer already protects stays protected for free: code spans, fenced
	code, $…$/$$…$$ math, :::TeX bodies, verbatim @begin environments, raw
	HTML, link hrefs/titles — none of those produce inline text tokens.
	Backslash escapes (\" \' \- ...) become `escape` tokens, which are also
	untouched: that is the author's per-character opt-out.

	Output is raw Unicode (never HTML entities), so ONE implementation serves
	both formats: HTML passes it through verbatim; the LaTeX text renderer
	escapes only &/#, and the engine maps “”‘’–—… natively (utf8 is the
	default input encoding since LaTeX 2018; fontspec engines are native).
	Authors who already type curly quotes and real dashes by hand are
	unaffected — the educator only touches the ASCII forms.

	Known token-boundary limit: quote classification sees one text token at a
	time, so a quote hard against inline markup (e.g. "*word*") classifies on
	token-local context and can guess wrong. Rare in practice; backslash-escape
	the quote where it matters.

	The hook reads the config key LAZILY (at walk time, not registration
	time): extensions register before the metadata header is parsed, and the
	lazy read is what lets `Smart typography: true` in a document header work.
*/

import { configManager } from './config-manager.js';

// Order matters: ellipsis and dashes first (the quote rules treat a preceding
// dash as an opening context), em dash before en dash.
export function educate(text) {
	let s = text;
	s = s.replace(/\.{3}/g, '…');
	s = s.replace(/---/g, '—');
	s = s.replace(/--/g, '–');
	// Decade abbreviations: '90s → ’90s. Must run before the opening-quote
	// rule, which would read the preceding whitespace as “opening” context.
	s = s.replace(/'(?=\d\ds)/g, '’');
	// Opening quotes: at the start of the token, or after whitespace, an
	// opening bracket, or a dash. Everything left after these is closing
	// punctuation or an apostrophe.
	s = s.replace(/(^|[\s([{—–])"/g, '$1“');
	s = s.replace(/(^|[\s([{—–])'/g, '$1‘');
	s = s.replace(/"/g, '”');
	s = s.replace(/'/g, '’');
	return s;
}

// walkTokens hook (install on BOTH marked instances). Mutates only leaf
// inline `text` tokens — a block-level text token that has child tokens
// renders from the children, so its own .text never reaches the output.
export function smartTypography(token) {
	if (token.type !== 'text' || token.tokens) return;
	if (!configManager.get('Smart typography')) return;
	token.text = educate(token.text);
}
