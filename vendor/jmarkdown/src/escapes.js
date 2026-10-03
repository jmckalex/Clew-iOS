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

export const escapedCharacters = {
	name: 'escape',
	renderer(token) {
		if (global.isLatex) return escapeTexText(token.text);
		if (token.text === '$') return '<span class="escaped">$</span>';
		return false;
	},
};
