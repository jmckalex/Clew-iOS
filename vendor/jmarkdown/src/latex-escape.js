/*
	Shared LaTeX escaping.

	By JMarkdown's design, prose reaching the LaTeX renderer needs only `&` and
	`#` escaped. The other LaTeX specials are JMarkdown source-level syntax —
	`_` (subscript), `^` (superscript), `%` (comment), `$` (math) — so any that
	survive to render time are intentional (inside math, which is passed through
	verbatim and validated by MathJax on the HTML side). Over-escaping them here
	would corrupt that source model and break round-tripping. A character the
	author ESCAPED (`\$`, `\_`) arrives as marked's `escape` token, not as text,
	and gets escapeTexText (escapes.js).

	Verbatim contexts (code) do NOT use this — minted takes its content literally;
	see the codespan/code renderers, which pick a delimiter instead of escaping.

	Text that is NOT markdown — a callout type's label from its definition, code
	that minted cannot take in a heading — uses escapeTexText instead, which
	escapes everything.

	An HTML entity in prose (`&mdash;`, `&hellip;`, `&eacute;`) is a character
	the browser shows; it reached the .tex as `\&mdash;` and printed as typed.
	escapeLatexText now writes the character instead (the owner, 2026-10-20),
	for the entities in PROSE_ENTITIES alone, so prose that merely looks like
	one (`Q&A;`) and every other entity print as they always did. A URL is not
	prose: \href's target uses escapeLatexUrl, which leaves entities alone.
*/

/*
	The entities escapeLatexText writes as their characters, and how: each one
	prints, with no error and no missing glyph, under pdfLaTeX in T1 (a full
	document's) and in OT1 (a --fragment in a plain document), under LuaLaTeX
	with fontspec, and under LuaLaTeX given a pdfLaTeX document (T1, with or
	without lmodern) — in prose, a heading, a footnote, a caption, \title and
	the PDF's Title. That last setup is why punctuation and signs are LaTeX's
	text commands (`\textendash{}`) and not the Unicode character: LuaLaTeX
	sets a character from T1's 8-bit font by its code point, so `–` printed
	nothing and `×` printed Œ. Latin-1's letters are themselves, since T1 has
	them at their Latin-1 code points (but `ß` and `ÿ`, which it does not).
	Left off: `&quot;` `&sbquo;` `&bdquo;` `&laquo;` `&raquo;` `&lsaquo;`
	`&rsaquo;` `&ETH;` `&eth;` `&THORN;` `&thorn;` (T1 only), `&minus;`
	`&prime;` `&Prime;` (not set up for pdfLaTeX).

	A character TeX reads as syntax is written as the command that prints it,
	and so is one whose meaning is spacing: `&nbsp;` is `\nobreakspace{}` (a tie
	without the `~`, which a bare address's text would then turn into a tilde),
	`&shy;` TeX's own soft hyphen `\-`, `&apos;` the straight quote HTML shows.
	No value holds `%`, `_` or `~`, which a bare address's text rewrites
	(latex-renderer.js). Names are case-sensitive, as in HTML, and need their `;`.
*/
export const PROSE_ENTITIES = Object.freeze({
	// TeX's syntax, spacing and quotes
	amp: '\\&', lt: '\\textless{}', gt: '\\textgreater{}', num: '\\#',
	sol: '/', ast: '*', apos: '\\textquotesingle{}',
	nbsp: '\\nobreakspace{}', shy: '\\-', thinsp: '\\,',
	// punctuation and signs
	ndash: '\\textendash{}', mdash: '\\textemdash{}', hellip: '\\textellipsis{}',
	lsquo: '\\textquoteleft{}', rsquo: '\\textquoteright{}',
	ldquo: '\\textquotedblleft{}', rdquo: '\\textquotedblright{}',
	bull: '\\textbullet{}', middot: '\\textperiodcentered{}',
	dagger: '\\textdagger{}', Dagger: '\\textdaggerdbl{}', permil: '\\textperthousand{}',
	sect: '\\textsection{}', para: '\\textparagraph{}', copy: '\\textcopyright{}',
	reg: '\\textregistered{}', trade: '\\texttrademark{}', deg: '\\textdegree{}',
	plusmn: '\\textpm{}', times: '\\texttimes{}', divide: '\\textdiv{}',
	frac12: '\\textonehalf{}', frac14: '\\textonequarter{}', frac34: '\\textthreequarters{}',
	sup1: '\\textonesuperior{}', sup2: '\\texttwosuperior{}', sup3: '\\textthreesuperior{}',
	micro: '\\textmu{}', euro: '\\texteuro{}', pound: '\\textsterling{}', cent: '\\textcent{}',
	yen: '\\textyen{}', curren: '\\textcurrency{}', brvbar: '\\textbrokenbar{}', not: '\\textlnot{}',
	ordf: '\\textordfeminine{}', ordm: '\\textordmasculine{}',
	iexcl: '\\textexclamdown{}', iquest: '\\textquestiondown{}',
	larr: '\\textleftarrow{}', rarr: '\\textrightarrow{}', uarr: '\\textuparrow{}', darr: '\\textdownarrow{}',
	// letters: Latin-1's as themselves; the rest as LaTeX writes them
	Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: '\\AA{}', AElig: '\\AE{}',
	Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í',
	Icirc: 'Î', Iuml: 'Ï', Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ',
	Ouml: 'Ö', Oslash: '\\O{}', Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý',
	szlig: '\\ss{}', agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: '\\aa{}',
	aelig: '\\ae{}', ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì',
	iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô',
	otilde: 'õ', ouml: 'ö', oslash: '\\o{}', ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü',
	yacute: 'ý', yuml: '\\"y', OElig: '\\OE{}', oelig: '\\oe{}', Scaron: '\\v{S}', scaron: '\\v{s}', Yuml: '\\"Y',
});

// Escape the two characters that appear in ordinary prose and must be escaped
// for LaTeX: `&` (alignment) and `#` (parameter), and write a listed entity as
// its character. Everything else is left as-is. One pass, so a character an
// entity gives is never escaped again (`&amp;mdash;` prints `&mdash;`, as the
// browser shows it).
export function escapeLatexText(text) {
	if (text == null) return '';
	return String(text).replace(/&(?:([A-Za-z][A-Za-z0-9]*);)?|#/g, (match, name) => {
		if (match === '#') return '\\#';
		if (name && Object.hasOwn(PROSE_ENTITIES, name)) return PROSE_ENTITIES[name];
		return '\\&' + match.slice(1);
	});
}

// `&` and `#` alone, as escapeLatexText escaped them before it read entities:
// for \href's target, a URL, where an entity's character is not what the
// browser would follow.
export function escapeLatexUrl(text) {
	if (text == null) return '';
	return String(text).replace(/&/g, '\\&').replace(/#/g, '\\#');
}

/*
	A `%` no backslash escapes, written `\%`: for what jmarkdown writes into a
	macro's argument — \title, \author, \date, hyperref's pdftitle and
	pdfauthor. There TeX reads a raw `%` as a comment, which swallows the
	argument's closing brace, and the build stops ("Paragraph ended before
	\title was complete", "File ended while scanning use of \kvsetkeys"). A
	`%` reaches these as text: a header's value is not markdown, so jmarkdown's
	inline comment never reads it, and in the body that comment is installed
	only in a document with a header (metadata-header.js) — where it is, it has
	taken the `%` and the rest of the line before anything renders. Either way
	the HTML shows the `%`. An author's `\%` is left as it is; `\\%` (a line
	break, then a percent) gets its `%` escaped.
*/
export function escapeArgumentPercent(text) {
	return String(text ?? '').replace(/(?<!\\)((?:\\\\)*)%/g, '$1\\%');
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
