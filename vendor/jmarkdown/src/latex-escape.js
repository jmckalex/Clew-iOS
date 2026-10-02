/*
	Shared LaTeX escaping.

	By JMarkdown's design, prose reaching the LaTeX renderer needs only `&` and
	`#` escaped. The other LaTeX specials are JMarkdown source-level syntax —
	`_` (subscript), `^` (superscript), `%` (comment), `$` (math) — so any that
	survive to render time are intentional (author-escaped, or inside math which
	is passed through verbatim and validated by MathJax on the HTML side). Over-
	escaping them here would corrupt that source model and break round-tripping.

	Verbatim contexts (code) do NOT use this — minted takes its content literally;
	see the codespan/code renderers, which pick a delimiter instead of escaping.

	Text that is NOT markdown — a callout type's label from its definition, code
	that minted cannot take in a heading — uses escapeTexText instead, which
	escapes everything.
*/

// Escape the two characters that appear in ordinary prose and must be escaped
// for LaTeX: `&` (alignment) and `#` (parameter). Everything else is left as-is.
export function escapeLatexText(text) {
	if (text == null) return '';
	return String(text).replace(/&/g, '\\&').replace(/#/g, '\\#');
}

/**
 * Plain text for TeX — every special character escaped. For text that is NOT
 * markdown, where the prose rules above (which leave `_ % $` alone) do not
 * apply. `< > |` too: without T1 encoding they print as ¡ ¿ —.
 */
export function escapeTexText(text) {
	return String(text ?? '').replace(/[\\{}$&#^_%~<>|]/g, (c) => ({
		'\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '$': '\\$', '&': '\\&',
		'#': '\\#', '^': '\\^{}', '_': '\\_', '%': '\\%', '~': '\\~{}',
		'<': '\\textless{}', '>': '\\textgreater{}', '|': '\\textbar{}',
	})[c]);
}
