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
*/

// Escape the two characters that appear in ordinary prose and must be escaped
// for LaTeX: `&` (alignment) and `#` (parameter). Everything else is left as-is.
export function escapeLatexText(text) {
	if (text == null) return '';
	return String(text).replace(/&/g, '\\&').replace(/#/g, '\\#');
}
