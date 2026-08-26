/*
	Pandoc-style citations — [@key] and @key — as a second front end onto the
	existing \cite machinery.

	Nothing here resolves a citation. The tokenizer TRANSLATES pandoc syntax into
	the equivalent natbib command and hands it to renderCiteCommand() in
	citations.js, so all three back-ends serve both syntaxes unchanged: native
	natbib in LaTeX output, the compile-time CSL pass, and the runtime Biblify
	client. The two notations may be mixed freely in one document.

	    @key                     \citet{key}
	    @key [p. 33]             \citet[p. 33]{key}
	    -@key                    \citeyear{key}            (author suppressed)
	    [@key]                   \citep{key}
	    [@key, p. 33]            \citep[p. 33]{key}
	    [see @key, p. 33]        \citep[see][p. 33]{key}
	    [-@key]                  \citeyearpar{key}
	    [@a; @b]                 \citep{a,b}
	    [see @a; @b, p. 33]      \citep[see][p. 33]{a,b}
	    @{key with oddities}     braced key, either form

	OPT-IN, via `Pandoc citations: true`. Off by default because @ is JMarkdown's
	directive sigil: with this on, a bare @word in prose that isn't a registered
	directive becomes a citation, which is a real change to how an existing
	document reads. (The config is read lazily at tokenize time — registration
	happens before the metadata header is parsed.)

	WHAT DOESN'T TRANSLATE. natbib gives a citation group ONE prenote and ONE
	postnote, while pandoc gives every item its own. A group whose notes don't fit
	that shape — `[see @a, p. 1; also @b, p. 2]` — is left in the source verbatim
	with a build warning, rather than silently dropping a locator. The same goes
	for mixing a suppressed-author item into a group. Both are rare; both are
	visible when they happen.

	DISAMBIGUATION. Directives always win: the @-directive extensions are
	registered later and so are offered the text first, and this tokenizer
	additionally declines any name in the block-environment registry. An @ glued
	to a word character (an email address) or preceded by a backslash is declined,
	the same guards the directive tokenizer uses.
*/

import { configManager } from './config-manager.js';
import { getBlockEnvironment } from './begin-end-core.js';
import { renderCiteCommand } from './citations.js';
import { addWarning } from './warnings.js';

// A citation key: begins with a letter, digit or underscore, and may contain
// internal punctuation — pandoc's rule, which is what lets Blevins:2017 and
// doe-2020/v2 work. Trailing punctuation is trimmed back off below, so a key at
// the end of a sentence doesn't swallow the full stop.
const KEY_BODY = /^[A-Za-z0-9_][A-Za-z0-9_:.#$%&+?<>~/-]*/;
const TRAILING_PUNCT = /[:.#$%&+?<>~/-]+$/;

// Names that are JMarkdown syntax rather than plausible citation keys.
const RESERVED = new Set(['begin', 'end']);

const enabled = () => Boolean(configManager.get('Pandoc citations', false));

// Read a key at position i (after the @). Returns { key, length } or null.
function readKey(src, i) {
	if (src[i] === '{') {
		const close = src.indexOf('}', i + 1);
		if (close < 0) return null;
		const key = src.slice(i + 1, close).trim();
		return key ? { key, length: close - i + 1 } : null;
	}
	const m = KEY_BODY.exec(src.slice(i));
	if (!m) return null;
	const key = m[0].replace(TRAILING_PUNCT, '');
	return key ? { key, length: key.length } : null;
}

// A key that names a directive belongs to the directive, not to a citation.
function isDirectiveName(key) {
	return RESERVED.has(key) || getBlockEnvironment(key) !== undefined;
}

// `[…]` with balanced nesting, so a locator may itself contain brackets.
function readBracketed(src) {
	if (src[0] !== '[') return null;
	let depth = 0;
	for (let i = 0; i < src.length; i++) {
		if (src[i] === '\\') { i++; continue; }
		if (src[i] === '[') depth++;
		else if (src[i] === ']') {
			depth--;
			if (depth === 0) return { inner: src.slice(1, i), length: i + 1 };
		}
		else if (src[i] === '\n' && src[i + 1] === '\n') return null;
	}
	return null;
}

// Split a citation group on top-level semicolons.
function splitItems(text) {
	const items = [];
	let current = '', depth = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '\\') { current += ch + (text[i + 1] || ''); i++; continue; }
		if (ch === '[') depth++;
		if (ch === ']') depth--;
		if (ch === ';' && depth === 0) { items.push(current); current = ''; continue; }
		current += ch;
	}
	items.push(current);
	return items;
}

// One item of a group: an optional prefix, the key, an optional suffix.
// Returns null when the item holds no citation at all.
function parseItem(text) {
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== '@') continue;
		if (i > 0 && /[\w\\]/.test(text[i - 1])) continue;       // email / escaped
		const read = readKey(text, i + 1);
		if (!read || isDirectiveName(read.key)) continue;

		let prefix = text.slice(0, i);
		const suppressed = /-\s*$/.test(prefix);
		if (suppressed) prefix = prefix.replace(/-\s*$/, '');
		// `[@key, p. 33]` — the comma introduces the locator, it isn't part of it.
		const suffix = text.slice(i + 1 + read.length).replace(/^\s*,\s*/, '');
		return { key: read.key, prefix: prefix.trim(), suffix: suffix.trim(), suppressed };
	}
	return null;
}

// natbib takes the postnote alone as one optional argument, and prenote +
// postnote as two — so a prefix with no suffix still needs an empty second.
function optionals(prefix, suffix) {
	if (prefix && suffix) return `[${prefix}][${suffix}]`;
	if (prefix) return `[${prefix}][]`;
	if (suffix) return `[${suffix}]`;
	return '';
}

// The whole group as one natbib command, or null when its shape has no natbib
// equivalent (see "WHAT DOESN'T TRANSLATE" above).
function groupCommand(items) {
	if (items.length === 1) {
		const { key, prefix, suffix, suppressed } = items[0];
		const command = suppressed ? 'citeyearpar' : 'citep';
		return `\\${command}${optionals(prefix, suffix)}{${key}}`;
	}
	if (items.some(item => item.suppressed)) return null;
	// Only the first item may carry a prefix and only the last a suffix; that is
	// exactly the shape natbib's single prenote/postnote pair can express.
	const misplaced = items.some((item, i) =>
		(item.prefix && i !== 0) || (item.suffix && i !== items.length - 1));
	if (misplaced) return null;
	const keys = items.map(item => item.key).join(',');
	return `\\citep${optionals(items[0].prefix, items[items.length - 1].suffix)}{${keys}}`;
}

export const pandocCitations = {
	name: 'pandocCitation',
	level: 'inline',
	start(src) {
		if (!enabled()) return undefined;
		const m = src.match(/(?<![\w\\])(?:-?@[A-Za-z0-9_{]|\[[^\]\n]*@)/);
		return m ? m.index : undefined;
	},
	tokenizer(src, tokens) {
		if (!enabled()) return;

		// Backstop for start(): another extension may have cut the text at the
		// character we rely on, so read it from the previous token instead.
		const prev = tokens && tokens[tokens.length - 1];
		const prevRaw = prev && typeof prev.raw === 'string' ? prev.raw : '';
		if (/[\w\\]$/.test(prevRaw)) return;

		/* --- [ … ] : the parenthetical form ---------------------------------- */
		if (src[0] === '[') {
			const bracketed = readBracketed(src);
			if (!bracketed) return;
			// `[text](url)` and `[text][ref]` are links; leave them to marked.
			const after = src[bracketed.length];
			if (after === '(' || after === '[') return;

			const items = splitItems(bracketed.inner).map(parseItem);
			if (items.length === 0 || items.some(item => item === null)) return;

			const command = groupCommand(items);
			if (command === null) {
				const literal = src.slice(0, bracketed.length);
				addWarning(`Pandoc citation ${literal} mixes per-item locators (or a suppressed author) in a group, which has no \\cite equivalent — left as written`);
				// Claim it anyway, as literal text: returning nothing would let the
				// in-text form below pick the keys out of it one by one, which is
				// the opposite of leaving it as written.
				return { type: 'pandocCitation', raw: literal, literal, tokens: [] };
			}
			return { type: 'pandocCitation', raw: src.slice(0, bracketed.length), command, tokens: [] };
		}

		/* --- @key / -@key : the in-text form --------------------------------- */
		const suppressed = src[0] === '-';
		const at = suppressed ? 1 : 0;
		if (src[at] !== '@') return;
		const read = readKey(src, at + 1);
		if (!read || isDirectiveName(read.key)) return;

		let raw = src.slice(0, at + 1 + read.length);
		let suffix = '';
		// A bracket right after the key is its locator — unless it is a link.
		const rest = src.slice(raw.length);
		const locator = /^[ \t]*\[([^\]\n]*)\]/.exec(rest);
		if (locator && !/^[([]/.test(rest.slice(locator[0].length))) {
			suffix = locator[1].trim();
			raw += locator[0];
		}

		const command = suppressed ? 'citeyear' : 'citet';
		return {
			type: 'pandocCitation',
			raw,
			command: `\\${command}${suffix ? `[${suffix}]` : ''}{${read.key}}`,
			tokens: []
		};
	},
	renderer(token) {
		if (token.literal !== undefined) {
			return global.isLatex
				? token.literal
				: token.literal.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		}
		return renderCiteCommand(token.command);
	}
};

export default pandocCitations;
