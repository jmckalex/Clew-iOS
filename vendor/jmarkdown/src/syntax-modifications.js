import { requirePackage } from './preamble.js';

/*
	/italics/ — with flanking rules, so that a slash inside a word, a path or a
	URL never opens or closes italics (`and/or`, `1/2/3`, `/usr/local/bin/`,
	`~/notes/`, `http://a/b/c/`), while `/a phrase/`, `(/word/)`, `/word/.` and
	`"/quoted/"` still do. The rule, in full:

	  - the OPENING `/` is not preceded by a letter, a digit, or any of
	    `:` `/` `.` `~` — the characters that join URL and path components;
	  - the content is one or more characters, none of them `/` `.` `?` `!`,
	    except that the last may be `.` `?` or `!` (unchanged);
	  - the CLOSING `/` is not followed by a letter, a digit or `/`.

	"Letter" and "digit" are Unicode (\p{L}, \p{N}). Nothing before the opening
	`/` — the start of a paragraph, link text, table cell or footnote — counts as
	a boundary, so it may open there. ITALICS below is the whole rule as one
	pattern.

	start() reports only a `/` where ITALICS matches, never one the tokenizer
	would then decline. That is what keeps URLs whole: marked cuts the text token
	at the smallest start() index, and reporting the `/` of `http:/` cut it there
	— before GFM's url tokenizer could see `http://` — which is how
	`http://a/b/c/` lost its link and came out as `http:/<em>a</em>b<em>c</em>`.
	The tokenizer reads the preceding character from the previous token (its
	second argument), since marked hands it `src` from the `/` on; that also
	backstops a cut made by another extension's start() just before a `/`.
*/
const ITALICS = /(?<![\p{L}\p{N}:\/.~])\/([^\/.?!]+[.?!]?)\/(?![\p{L}\p{N}\/])/u;
// The same, anchored at the opening `/`. Its lookbehind can't see past the
// start of `src`, so the tokenizer checks the preceding character itself,
// against NO_ITALICS_AFTER (ITALICS's lookbehind class).
const ITALICS_AT_START = /^\/([^\/.?!]+[.?!]?)\/(?![\p{L}\p{N}\/])/u;
const NO_ITALICS_AFTER = /[\p{L}\p{N}:\/.~]$/u;

export const italics = {
					name: 'italics',
					level: 'inline',
					start(src) {
						const index = src.search(ITALICS);
						return index === -1 ? undefined : index;
					},
					tokenizer(src, tokens) {
						const prev = tokens?.at(-1)?.raw;
						if (typeof prev === 'string' && NO_ITALICS_AFTER.test(prev)) return;
						const match = ITALICS_AT_START.exec(src);
						if (match) {
							const token = {
								type: 'italics',
								raw: match[0],
								text: match[1],
								tokens: []
							};
							this.lexer.inline(token.text, token.tokens);
							return token;
						}
					},
					renderer(token) {
						const content = this.parser.parseInline(token.tokens);
						if (global.isLatex) return `\\emph{${content}}`;
						return `<em>${content}</em>`;
					}
				};

export const strong = {
				name: 'strong',
				level: 'inline',
				start(src) { return src.match(/\*/)?.index },
				tokenizer(src) {
					const rule = /^\*([^\*]+)\*/;
					const match = rule.exec(src);
					if (match) {
						const token = {
							type: 'strong',
							raw: match[0],
							text: match[1],
							tokens: []
						};
						this.lexer.inline(token.text, token.tokens);
						return token;
					}
				},
				renderer(token) {
					const content = this.parser.parseInline(token.tokens);
					if (global.isLatex) return `\\textbf{${content}}`;
					return `<strong>${content}</strong>`;
				}
			};

export const highlight = {
	name: 'highlight',
	level: 'inline',
	start(src) { return src.match(/==/)?.index },
	tokenizer(src) {
		const rule = /^==([^=]+)==/;
		const match = rule.exec(src);
		if (match) {
			const token = {
				type: 'highlight',
				raw: match[0],
				text: match[1],
				tokens: []
			};
			this.lexer.inline(token.text, token.tokens);
			return token;
		}
	},
	renderer(token) {
		const content = this.parser.parseInline(token.tokens);
		if (global.isLatex) {
			// \hl is from soul; it needs a colour package loaded first.
			requirePackage('xcolor');
			requirePackage('soul');
			return `\\hl{${content}}`;
		}
		return `<span class='highlight'>${content}</span>`;
	}
};

export const intense = {
	name: 'intense',
	level: 'inline',
	start(src) { return src.match(/\*\*/)?.index },
	tokenizer(src) {
		const rule = /^\*\*([^*]+)\*\*/;
		const match = rule.exec(src);
		if (match) {
			const token = {
				type: 'intense',
				raw: match[0],
				text: match[1],
				tokens: []
			};
			this.lexer.inline(token.text, token.tokens);
			return token;
		}
	},
	renderer(token) {
		const content = this.parser.parseInline(token.tokens);
		if (global.isLatex) return `\\textbf{\\emph{${content}}}`;
		return `<span class='intense'>${content}</span>`;
	}
};

export const underline = {
				name: 'underline',
				level: 'inline',
				start(src) { return src.match(/__/)?.index },
				tokenizer(src) {
					const rule = /^__([^_]+)__/;
					const match = rule.exec(src);
					if (match) {
						const token = {
							type: 'underline',
							raw: match[0],
							text: match[1],
							tokens: []
						};
						this.lexer.inline(token.text, token.tokens);
						return token;
					}
				},
				renderer(token) {
					const content = this.parser.parseInline(token.tokens);
					if (global.isLatex) return `\\underline{${content}}`;
					return `<span class='underline'>${content}</span>`;
				}
			};

export const subscript = {
				name: 'subscript',
				level: 'inline',
				start(src) { return src.match(/_/)?.index },
				tokenizer(src) {
					const rule = /^_([a-zA-Z0-9]|\{[^}]*\})/;
					const match = rule.exec(src);
					if (match) {
						const token = {
							type: 'subscript',
							raw: match[0],
							text: match[1],
							tokens: []
						};
						this.lexer.inline(token.text, token.tokens);
						return token;
					}
				},
				renderer(token) {
					let contents = this.parser.parseInline(token.tokens).replace(/[{}]/g, '');
					if (global.isLatex) return `\\textsubscript{${contents}}`;
					return `<sub>${contents}</sub>`;
				}
			};		

export const superscript = {
				name: 'superscript',
				level: 'inline',
				start(src) { return src.match(/\^/)?.index },
				tokenizer(src) {
					const rule = /^\^([a-zA-Z0-9]|\{[^}]*\})/;
					const match = rule.exec(src);
					if (match) {
						const token = {
							type: 'superscript',
							raw: match[0],
							text: match[1],
							tokens: []
						};
						this.lexer.inline(token.text, token.tokens);
						return token;
					}
				},
				renderer(token) {
					let contents = this.parser.parseInline(token.tokens).replace(/[{}]/g, '');
					if (global.isLatex) return `\\textsuperscript{${contents}}`;
					return `<sup>${contents}</sup>`;
				}
			};		