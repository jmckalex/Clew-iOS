/*
	A backslash-escaped character — `\$`, `\_`, `\{`, `\\` — is one the author
	wants PRINTED. marked hands it over as an `escape` token holding the bare
	character, and both renderers used to write it bare:

	  - in LaTeX, `\$5` reached the .tex as `$5`, which starts maths, `\_` as a
	    subscript outside maths, `\%` as a comment that ate the rest of the line,
	    `\{` as a group — so the author had no way to write those characters
	    that a LaTeX export would print. Now every TeX special is escaped
	    (escapeTexText), which is exactly what the backslash asked for;
	  - in HTML, `\$5 and \$10` became "$5 and $10" in the page, and MathJax —
	    whose inline delimiter is `$` — typeset the "5 and " between them. A `$`
	    the author escaped is now wrapped in a span, which MathJax will not read
	    a delimiter across (only `<br>` and comments may sit inside its maths).

	Every other escaped character renders as marked has it. A renderer-only
	extension keyed on the token type, so marked's own `escape` tokenizer is
	untouched; registered in index.js on both instances.
*/

import { escapeTexText } from './latex-escape.js';
import { registerExtension } from './utils.js';

export const escapedCharacters = {
	name: 'escape',
	renderer(token) {
		if (global.isLatex) return escapeTexText(token.text);
		if (token.text === '$') return '<span class="escaped">$</span>';
		return false;
	},
};

/*
	An image's alt text is written into an attribute, and marked (v16) writes
	it UNESCAPED: `![a "quoted" word](x.png)` gave alt="a "quoted" word" —
	the attribute ended at the second quote and the rest became attributes of
	their own (`![a" onerror="…](x.png)` an event handler). The alt is escaped
	here, once, and marked's own renderer does the rest (src cleaning, title,
	which it already escapes). HTML only: in LaTeX this declines, and the LaTeX
	renderer's image() runs as before. Registered here, on both instances,
	since index.js imports this module.
*/
const escapeAttribute = (s) => String(s)
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
	.replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const imageAltText = {
	name: 'image',
	renderer(token) {
		if (global.isLatex) return false;
		const alt = token.tokens ? this.parser.parseInline(token.tokens, this.parser.textRenderer) : token.text;
		return this.parser.renderer.image({ ...token, tokens: null, text: escapeAttribute(alt) });
	},
};

registerExtension(imageAltText);
