/*
	colon-to-at.js — rewrite JMarkdown's colon directives in the @ forms.

	The colon syntax (`:name[…]{…}`, `::name[…]{…}`, `:::name … :::`) is being
	retired (the owner, 2026-10-10). This module is the converter: text in, text
	plus a list of what changed out. It has NO imports, so a host's browser
	bundle (Clew) can use it as it stands, and it never runs the engine.

		import { convert } from './colon-to-at.js';   // or convertColonDirectives
		const { text, changes } = convert(source);

	It reads the colon syntax exactly as the engine does (extended-directives.js
	and the handlers registered on it), and writes for each directive the @ form
	that renders the same:

		:name[text]{attrs}        → @name[text]{attrs}
		::name[text]{attrs}       → @name+[text]{attrs}
		:::name[label]{attrs} …   → @begin(name)[label]{attrs} … @end(name)

	— with these differences, each reported in `changes`:

	* A name with no handler of its own renders, in the colon syntax, as an HTML
	  element of that name (`:::note` → `<note>`). The @ forms render such a name
	  as `div.note`, so it is written with the element sigil, `@begin(<note>)` …
	  `@end(note)`, `@<note>[…]`, which keeps `<note>` (the owner's choice). A
	  generic block `::name[text]` becomes `@begin(<name>)` with the text as its
	  body: the colon form wraps the text in a paragraph, and so does that. Such a
	  container's [label], which the colon form dropped, is kept: @begin writes it
	  as data-label="…" (`changes-output`). `same` describes the HTML. In LaTeX
	  the colon form wrote such a name's HTML tags into the .tex as they stood
	  (`<note>`); the @ form writes \begin{note}…\end{note}, defined as a no-op
	  until the document defines it — except for a name that is already a TeX
	  command (box, section, …), which cannot be a LaTeX environment at all.
	  `:span[…]` likewise prints its text in LaTeX, not a <span> tag.
	* A name the @ forms know but the colon forms do not (theorem, figure,
	  equation, proof, table, …) rendered as a bare, unnumbered element. It is
	  written as the real environment, which numbers it (the owner's choice), and
	  reported as `changes-output`.
	* What the converter cannot write faithfully is left exactly as it stands and
	  reported as `needs-you`, with the reason.

	Each change: { line, kind, name, from, to, why, generic }. `generic` is true
	where the name had no handler of its own (it rendered as an element of that
	name). A host that loads colon directives of its own can pass those names
	back as `customDirectives` and convert again. `kind` is
	  'same'            the @ form renders as the colon form did;
	  'changes-output'  converted, and the output differs (`why` says how);
	  'needs-you'       not converted (`why` says why): a person decides;
	  'kept'            left as written because its line was in `keep`;
	  'prose'           a colon in prose that the colon syntax read as a directive
	                    (`a:b` rendered `a<b></b>`); the text is not changed, and once
	                    the colon syntax is gone it prints as written.
	Lines are 1-based, in the source as given.

	Left alone: the metadata header, fenced code, inline code, maths ($…$, $$…$$,
	\(…\), \[…\]), HTML comments, the inline comment (`%` to the end of the line,
	or the header's `Inline comment` marker — in a document that has a header,
	as the engine installs it only then), <script>/<style> blocks, raw HTML tags, URLs,
	link destinations, and the bodies of verbatim environments (TeX, TiKZ,
	mermaid, Mathematica, game, metapost, tabbing). A second run changes nothing.

	Options:
	  headerStyle: 'fenced'   only a `---`-fenced header counts (Clew's setting).
	  keep: [line, …]         directives whose opening line is listed are left as
	                          written ('kept'); a kept container's body is still
	                          converted. A host converts some blocks and not
	                          others by calling again with the rest kept.
	  customDirectives: […]   names a host loads as colon directives of its own
	                          (the `Directives` config key); needs-you, as a document's
	                          `Load directives:` names are.
*/

// The colon directives with a handler of their own, by level; the twin of each
// is the same name in the @ form. Containers: most are registered for `:::`
// only; MULTI ones (and a document's Optionals) at every count, 3 to 8.
const SPECIAL_INLINE = new Set(['today', 'label', 'ref', 'cref', 'Cref', 'TeX', 'HTML', 'print', 'web', 'target', 'span']);
const SPECIAL_BLOCK = new Set(['title', 'subtitle', 'author', 'institution', 'date']);
const SPECIAL_CONTAINER = new Set(['TeX', 'HTML', 'print', 'web', 'abstract', 'feedback', 'title-box',
	'markdown-demo', 'Mathematica', 'mermaid', 'game', 'TiKZ', 'source', 'comment']);
const MULTI_CONTAINER = new Set(['markdown-demo', 'source', 'comment']);

// A bare inline name (no bracket) that is a directive.
const BARE_INLINE = new Set(['today']);

// Names the @ registry knows (begin-end-core.js registerBlockEnvironment). A
// generic colon directive with one of these names is not a respelling: its @
// form reaches that handler, and the element sigil cannot stop it.
const AT_KNOWN = new Set(['abstract', 'author', 'cref', 'Cref', 'date', 'equation', 'feedback', 'figure',
	'game', 'HTML', 'image', 'institution', 'label', 'listing', 'markdown-demo', 'Mathematica', 'mermaid',
	'metapost', 'print', 'proof', 'ref', 'source', 'span', 'subfigure', 'subtitle', 'table', 'target', 'TeX',
	'TiKZ', 'title', 'title-box', 'today', 'video', 'web', 'theorem', 'lemma', 'corollary', 'proposition',
	'definition', 'example', 'remark', 'comment', 'tabbing']);

// Bodies kept verbatim: neither the colon nor the @ form reads them as markdown.
// (Not `game`: its strategy labels and its row/column/caption lines are read
// as Markdown, so a directive there is converted.)
const VERBATIM = new Set(['TeX', 'TiKZ', 'mermaid', 'Mathematica', 'metapost', 'tabbing']);

// The HTML container elements a block @ form renders as themselves
// (begin-end-core.js BLOCK_CONTAINER_ELEMENTS, less div: there `div` means the
// class case). Kept in step by tests/colon-to-at.
const HTML_CONTAINERS = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'dialog',
	'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'hgroup', 'main', 'nav', 'search',
	'section', 'summary']);

// HTML void elements: the colon syntax writes `<img … />`; the @ forms would
// write an open and a close tag.
const VOID = new Set(['area', 'base', 'basefont', 'bgsound', 'br', 'col', 'command', 'embed', 'frame',
	'hr', 'image', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// The engine's patterns (extended-directives.js getDirectivePattern).
const INLINE_RE = /^:((?:[a-zA-Z][\w-]*|[\{].*?(?:\n.*?)*[\}]+|[\[].*?(?:\n.*?)*[\]])+)/;
const BLOCK_RE = /^::((?:[a-zA-Z][\w-]*|[\{\[].*?(?:\n.*?)*[\}\]])+)/;

export function convertColonDirectives(source, options = {}) {
	const changes = [];
	const text = String(source ?? '').replace(/\r\n/g, '\n');
	const { header, body } = splitHeader(text, options.headerStyle);
	const ctx = {
		changes,
		optionals: new Set(),
		loaded: new Set(options.customDirectives || []),
		keep: new Set(options.keep || []),
		// The inline comment exists only in a document WITH a metadata header:
		// metadata-header.js installs it (default `%`) while reading one. Without
		// a header `%` is ordinary text, and a directive after it was read.
		comment: header ? '%' : null,
		loadsAll: false
	};
	readHeader(header, ctx);
	const headerLines = header ? header.split('\n').length - 1 : 0;
	const out = header + convertBlocks(body.split('\n'), 1 + headerLines, ctx).join('\n');
	changes.sort((a, b) => a.line - b.line);
	return { text: out, changes };
}

/* --- The metadata header (metadata-header.js processYAMLheader) ------------ */

function splitHeader(text, headerStyle) {
	const opener = text.match(/^---[ \t]*\n/);
	const stripped = opener ? text.slice(opener[0].length) : text;
	if (!/^[-a-zA-Z0-9 ]+:/.test(stripped) || (headerStyle === 'fenced' && !opener)) {
		return { header: '', body: text };
	}
	const term = stripped.match(/\n^---.*$/m);
	if (!term) return { header: text, body: '' };
	const end = (opener ? opener[0].length : 0) + term.index + term[0].length;
	// The header keeps its terminator line and the newline after it.
	const cut = text[end] === '\n' ? end + 1 : end;
	return { header: text.slice(0, cut), body: text.slice(cut) };
}

// Optionals become directives of their own; Load directives' names are the
// document's own colon directives, which no converter can port.
function readHeader(header, ctx) {
	for (const line of header.split('\n')) {
		const m = line.match(/^([-a-zA-Z0-9 ]+):\s*(.*)$/);
		if (!m) continue;
		const key = m[1].trim().toLowerCase();
		if (key === 'optionals') {
			// As metadata-header.js parseOptionalString reads it: names split on
			// whitespace, each with an optional `[true]`/`[false]`.
			for (const item of m[2].trim().split(/\s+/)) {
				const name = item.replace(/\[.*\]$/, '');
				if (name) ctx.optionals.add(name);
			}
		}
		if (key === 'block elements') ctx.ownPolicy = true;
		// The inline comment marker (metadata-header.js): `Inline comment: ## true`.
		if (key.startsWith('inline comment') && m[2].trim()) ctx.comment = m[2].trim().split(/\s+/)[0];
		if (key === 'load directives') {
			const from = m[2].match(/^(.*?)\s+from\s+/);
			if (from) from[1].split(',').map(s => s.trim()).filter(Boolean).forEach(n => ctx.loaded.add(n));
			else ctx.loadsAll = true;
		}
	}
}

/* --- Block level ------------------------------------------------------------ */

function splitPrefix(line) {
	const m = line.match(/^((?:[ \t]*>)*[ \t]*)/);
	return { prefix: m[1], rest: line.slice(m[1].length) };
}

// Convert a run of lines; `first` is the source line number of lines[0].
function convertBlocks(lines, first, ctx) {
	const out = [];
	let buf = [], bufStart = 0;
	const flush = () => {
		if (buf.length) out.push(...convertInline(buf.join('\n'), first + bufStart, ctx).split('\n'));
		buf = [];
	};
	const keep = (from, to) => { flush(); for (let k = from; k <= to; k++) out.push(lines[k]); };

	for (let i = 0; i < lines.length;) {
		const { prefix, rest } = splitPrefix(lines[i]);
		let m;

		// Fenced code: verbatim to its closing fence (or the end).
		if ((m = rest.match(/^(`{3,}|~{3,})/))) {
			const fence = m[1];
			let j = i + 1;
			while (j < lines.length && !new RegExp(`^${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(splitPrefix(lines[j]).rest)) j++;
			keep(i, Math.min(j, lines.length - 1));
			i = j + 1;
			continue;
		}
		// A multi-line HTML comment, <script> or <style> block, or display maths.
		const close = blockCloser(rest);
		if (close) {
			let j = i;
			if (!close.test(rest.slice(close.skip || 0))) {
				j = i + 1;
				while (j < lines.length && !close.test(lines[j])) j++;
			}
			keep(i, Math.min(j, lines.length - 1));
			i = j + 1;
			continue;
		}
		// An @begin of a verbatim environment: its body is not markdown.
		if ((m = rest.match(/^@begin\(\s*[.<]?\s*([A-Za-z][\w-]*)\s*>?\s*\)/)) && VERBATIM.has(m[1])) {
			const j = findAtEnd(lines, i, m[1]);
			keep(i, j === -1 ? i : j);
			i = (j === -1 ? i : j) + 1;
			continue;
		}
		// Legacy placement aliases.
		if ((m = rest.match(/^::(Bibliography|Index)\b([ \t]*)(\{[^}\n]*\})?([ \t]*)$/)) && !ctx.keep.has(first + i)) {
			flush();
			const to = `${prefix}@${m[1].toLowerCase()}${m[2]}${m[3] || ''}${m[4]}`;
			out.push(to);
			record(ctx, first + i, 'same', m[1], lines[i].trim(), to.trim());
			i++;
			continue;
		}
		// A colon container.
		if ((m = rest.match(/^(:{3,})/))) {
			const done = convertContainer(lines, i, prefix, rest, m[1].length, first, ctx);
			if (done) { flush(); out.push(...done.lines); i = done.next; continue; }
		}
		// A colon block directive.
		if (/^::(?!:)/.test(rest)) {
			const done = convertBlockDirective(lines, i, prefix, rest, first, ctx);
			if (done) { flush(); out.push(...done.lines); i = done.next; continue; }
		}
		if (!buf.length) bufStart = i;
		buf.push(lines[i]);
		i++;
	}
	flush();
	return out;
}

// What closes a multi-line verbatim block that starts on this line, if any.
function blockCloser(rest) {
	if (/^<!--/.test(rest)) return { test: (s) => /-->/.test(s), skip: 4 };
	const tag = rest.match(/^<(script|style)\b/i);
	if (tag) return { test: (s) => new RegExp(`</${tag[1]}\\s*>`, 'i').test(s), skip: 1 };
	if (/^\$\$/.test(rest)) return { test: (s) => /\$\$/.test(s), skip: 2 };
	if (/^\\\[/.test(rest)) return { test: (s) => /\\\]/.test(s), skip: 2 };
	return null;
}

// The line of the @end(name) matching the @begin(name) on line i, or -1.
function findAtEnd(lines, i, name) {
	const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const begin = new RegExp(`^@begin\\(\\s*[.<]?\\s*${n}\\s*>?\\s*\\)`);
	const end = new RegExp(`^@end\\(\\s*[.<]?\\s*${n}\\s*>?\\s*\\)[ \\t]*$`);
	let depth = 0;
	for (let j = i + 1; j < lines.length; j++) {
		const r = splitPrefix(lines[j]).rest;
		if (begin.test(r)) depth++;
		else if (end.test(r)) { if (depth === 0) return j; depth--; }
	}
	return -1;
}

// The header of a colon directive, lexed as extended-directives.js's moo lexer
// does: spaces, names (the LAST one counts), {attrs}, [text]; the rest is body.
function lexHeader(s) {
	let p = 0, attrs, text;
	const names = [];
	while (p < s.length) {
		const r = s.slice(p);
		let m;
		if ((m = r.match(/^[\t\v\f﻿ ]+/))) { p += m[0].length; continue; }
		if ((m = r.match(/^[a-zA-Z][\w-]*/))) { names.push(m[0]); p += m[0].length; continue; }
		if ((m = r.match(/^\{[\s\S]*?\}/))) { attrs = m[0].slice(1, -1).replace(/\s*\n\s*/g, ' '); p += m[0].length; continue; }
		if ((m = r.match(/^\[[\s\S]*?\]/))) { text = m[0].slice(1, -1); p += m[0].length; continue; }
		break;
	}
	return { names, attrs, text, rest: s.slice(p) };
}

function isSpecialContainer(name, count, ctx) {
	if (ctx.optionals.has(name) || MULTI_CONTAINER.has(name)) return true;
	return count === 3 && SPECIAL_CONTAINER.has(name);
}

// How a colon name is written in the @ forms, and what kind of change it is.
// `block` is true for a container or a block directive, false for an inline one.
function classify(name, special, ctx, block) {
	if (ctx.loaded.has(name)) return { kind: 'needs-you', note: `\`${name}\` is a directive the document loads itself (Load directives): port it to Load environments first` };
	if (special) return { kind: 'same', at: name };
	if (ctx.loadsAll) return { kind: 'needs-you', note: `the document's Load directives may define \`${name}\`: port them to Load environments first` };
	if (AT_KNOWN.has(name)) return { kind: 'changes-output', at: name, note: `rendered as a bare <${name}> element; @begin(${name}) is the real environment (numbered, where it numbers)` };
	if (name === 'div') return { kind: 'changes-output', at: 'div', generic: true, note: 'every @ spelling of a <div> gives it class="div"' };
	if (VOID.has(name)) return { kind: 'changes-output', at: `<${name}>`, generic: true, note: `<${name}> is written with a closing tag in the @ forms` };
	// Under the default `Block elements: hyphenated`, a hyphenated name, and
	// (blocks only) an HTML container name, render as the element already: no
	// sigil needed. A document that sets its own policy keeps the sigil.
	const element = name.includes('-') || (block && HTML_CONTAINERS.has(name.toLowerCase()));
	return { kind: 'same', at: element && !ctx.ownPolicy ? name : `<${name}>`, generic: true };
}

function convertContainer(lines, i, prefix, rest, count, first, ctx) {
	const colons = ':'.repeat(count);
	const line = first + i;
	if (count > 8) return leave(ctx, line, '', rest, 'more than eight colons: never a directive');
	// The engine's `^:::([\s\S]*?)\n:::` closes at the FIRST later line that
	// starts with as many colons — whatever else is on it, fences included.
	let j = i + 1;
	while (j < lines.length && !splitPrefix(lines[j]).rest.startsWith(colons)) j++;
	if (j >= lines.length) return leave(ctx, line, '', rest, 'no closing line: the colon syntax read it as text');

	// The header is lexed over the whole content, as the engine's is: a {…} or
	// […] may run on over lines. `h` is the line the body starts after.
	const content = [rest.slice(count), ...lines.slice(i + 1, j).map(l => splitPrefix(l).rest)].join('\n');
	const head = lexHeader(content);
	const h = i + (content.length - head.rest.length > 0 ? (content.slice(0, content.length - head.rest.length).match(/\n/g) || []).length : 0);
	head.rest = head.rest.split('\n')[0];
	const name = head.names.at(-1);
	const closeRest = splitPrefix(lines[j]).rest.slice(count);
	// What is left alone keeps its lines as they stand, its body converted.
	const keepWhole = (nm, why, kind = 'needs-you') => {
		record(ctx, line, kind, nm, rest.trim(), undefined, why);
		return { lines: [...lines.slice(i, h + 1), ...convertBlocks(lines.slice(h + 1, j), first + h + 1, ctx), lines[j]], next: j + 1 };
	};
	if (ctx.keep.has(line)) return keepWhole(name || '', 'kept as written (keep)', 'kept');
	// A <div> with a class is @begin(.class) too: `:::div{.a .b}` → <div class="a b">.
	if (!name || (name === 'div' && head.names.length === 1 && /^\s*\.[A-Za-z]/.test(head.attrs || '') && head.text === undefined)) {
		// A nameless container is a <div>. With a class it is @begin(.class):
		// `::::{.no-colon}` → `<div class="no-colon">`, the class first as before.
		const cls = (head.attrs || '').match(/^\s*\.([A-Za-z][\w-]*)(?=\s|$)/);
		if (!cls || /^:/.test(closeRest) || closeRest.trim() || head.rest.trim()) {
			return keepWhole('', 'no name: renders as a bare <div>, which the @ forms cannot write');
		}
		const others = head.attrs.slice(cls[0].length).trim();
		const open = `${prefix}@begin(.${cls[1]})${others ? `{${others}}` : ''}`;
		const body = convertBlocks(lines.slice(h + 1, j), first + h + 1, ctx);
		record(ctx, line, 'same', cls[1], `${prefix}${rest}`.trim(), open.trim());
		return { lines: [open, ...body, `${splitPrefix(lines[j]).prefix}@end(${cls[1]})`], next: j + 1 };
	}
	if (head.names.length > 1) return keepWhole(name, `more than one name on the opening line (the colon syntax uses the last, \`${name}\`)`);
	if (/^[\[{]/.test(head.rest.trim())) return keepWhole(name, 'an unclosed [ or { in its header');
	if (/^:/.test(closeRest)) return keepWhole(name, `its closing line has more than ${count} colons`);
	if (closeRest.trim()) return keepWhole(name, `text after the closing ${colons}`);

	const cls = classify(name, isSpecialContainer(name, count, ctx), ctx, true);
	if (cls.kind === 'needs-you') return keepWhole(name, cls.note);

	// The generic colon container ignores its [label]; @begin keeps it, as a
	// data-label attribute. The author's text is kept, and the change said. A
	// label that ran on over lines is joined: @begin's opener is one line.
	let note = cls.note;
	let kind = cls.kind;
	const label = head.text === undefined ? undefined : head.text.replace(/\s*\n\s*/g, ' ');
	const text = innerText(label, name, line, ctx);
	if (text !== undefined && cls.at.startsWith('<') && kind === 'same') {
		kind = 'changes-output';
		note = `[${text}] is kept, as data-label="${text}" on the element; the colon form dropped it`;
	}
	const open = `${prefix}@begin(${cls.at})${text !== undefined ? `[${text}]` : ''}${head.attrs !== undefined ? `{${head.attrs}}` : ''}`;
	const closeLine = `${splitPrefix(lines[j]).prefix}@end(${name})`;

	// Text after the header on its last line opens the body.
	const trailing = head.rest.trim() ? [prefix + head.rest.trimStart()] : [];
	let body = lines.slice(h + 1, j);
	if (VERBATIM.has(name) && cls.at === name) {
		const indents = body.filter(l => l.trim()).map(l => splitPrefix(l).prefix.replace(/>/g, '').length - prefix.replace(/>/g, '').length);
		if (indents.length && Math.min(...indents) > 0) {
			kind = 'changes-output';
			note = 'the body is indented, and @begin removes common indentation from a verbatim body';
		}
	} else {
		const before = ctx.changes.length;
		body = convertBlocks(body, first + h + 1, ctx);
		if (name === 'markdown-demo' && ctx.changes.slice(before).some(c => c.to !== undefined)) {
			kind = 'changes-output';
			note = 'the demo shows its source, which is now in the @ forms';
		}
	}
	if (trailing.length) note = (note ? note + '; ' : '') + 'text after the opening line moved to a line of its own';
	if (indented(prefix)) { kind = 'changes-output'; note = (note ? note + '; ' : '') + INDENTED; }
	record(ctx, line, kind, name, `${prefix}${rest}`.trim(), open.trim(), note, cls.generic);
	return { lines: [open, ...trailing, ...body, closeLine], next: j + 1 };
}

function convertBlockDirective(lines, i, prefix, rest, first, ctx) {
	const line = first + i;
	// The pattern may run on over lines (a [text] with a newline in it).
	const stripped = [rest, ...lines.slice(i + 1).map(l => splitPrefix(l).rest)].join('\n');
	const m = stripped.match(BLOCK_RE);
	if (!m) return null;
	const spanned = (m[0].match(/\n/g) || []).length;
	// What follows the directive on its (last) line.
	const tail = stripped.slice(m[0].length).split('\n')[0];

	const head = lexHeader(m[1]);
	const name = head.names.at(-1);
	if (ctx.keep.has(line)) {
		record(ctx, line, 'kept', name || '', rest, undefined, 'kept as written (keep)');
		return { lines: lines.slice(i, i + spanned + 1), next: i + spanned + 1 };
	}
	if (!name || (name === 'div' && head.names.length === 1 && /^\s*\.[A-Za-z]/.test(head.attrs || ''))) {
		// A nameless block is a <div> round its text. With a class it is
		// @begin(.class) round the same text: `::[Contents]{.toc}`.
		const cls = (head.attrs || '').match(/^\s*\.([A-Za-z][\w-]*)(?=\s|$)/);
		if (!cls || tail.trim()) return leave(ctx, line, '', rest, 'no name: renders as a bare <div>, which the @ forms cannot write', i + spanned);
		const others = head.attrs.slice(cls[0].length).trim();
		const body = innerText(head.text, '', line, ctx) ?? '';
		const out = [`${prefix}@begin(.${cls[1]})${others ? `{${others}}` : ''}`, ...body.split('\n').map(l => prefix + l), `${prefix}@end(${cls[1]})`];
		record(ctx, line, 'same', cls[1], rest, out.map(l => l.trim()).join('\n'));
		return { lines: out, next: i + spanned + 1 };
	}
	if (head.names.length > 1) return leave(ctx, line, name, rest, `more than one name (the colon syntax uses the last, \`${name}\`)`, i + spanned);
	if (tail.trim()) return leave(ctx, line, name, rest, 'text after the directive on its line', i + spanned);

	const special = SPECIAL_BLOCK.has(name);
	const cls = classify(name, special, ctx, true);
	if (cls.kind === 'needs-you') return leave(ctx, line, name, rest, cls.note, i + spanned);

	const text = innerText(head.text, name, line, ctx) ?? '';
	const attrs = head.attrs !== undefined ? `{${head.attrs}}` : '';
	let out;
	if (special || AT_KNOWN.has(name)) {
		// `@name+` needs a bracket to be seen at all: `[]` when there is none.
		const bracket = head.text !== undefined || head.attrs === undefined ? `[${text}]` : '';
		out = [`${prefix}@${cls.at}+${bracket}${attrs}`];
	} else {
		// A generic block renders `<name>` around its text as a paragraph: the
		// same as an @begin(<name>) whose body is that text.
		out = [`${prefix}@begin(${cls.at})${attrs}`, ...text.split('\n').map(l => prefix + l), `${prefix}@end(${name})`];
	}
	const from = [rest, ...lines.slice(i + 1, i + spanned + 1).map(l => splitPrefix(l).rest)].join('\n');
	const ind = indented(prefix);
	record(ctx, line, ind ? 'changes-output' : cls.kind, name, from, out.map(l => l.trim()).join('\n'),
		ind ? (cls.note ? cls.note + '; ' : '') + INDENTED : cls.note, cls.generic);
	return { lines: out, next: i + spanned + 1 };
}

// A directive's [text] is itself inline markdown (`::date[:today]`), so its
// own colon directives are converted too — except where the text is taken as
// it stands: raw TeX, and the keys of labels, references and targets.
const LITERAL_TEXT = new Set(['TeX', 'label', 'ref', 'cref', 'Cref', 'target']);
function innerText(text, name, line, ctx) {
	if (text === undefined || LITERAL_TEXT.has(name)) return text;
	return convertInline(text, line, ctx);
}

// An indented colon line (in a list item, say) was a directive only at its
// item's own indentation: deeper, the colon syntax printed it as text. @begin
// and @name+ are read at any indentation, so such a block now renders.
const INDENTED = 'indented: the colon syntax read it only at its list item\'s own indentation (deeper, it printed as text); the @ form is read at any';
function indented(prefix) {
	return /^[ \t]/.test(prefix.replace(/^(?:[ \t]{0,3}>[ \t]?)+/, ''));
}

function leave(ctx, line, name, from, note, lastIndex) {
	record(ctx, line, 'needs-you', name, from.trim(), undefined, note);
	return null;
}

function record(ctx, line, kind, name, from, to, note, generic) {
	const change = { line, kind, name, from };
	if (to !== undefined) change.to = to;
	if (note) change.why = note;
	if (generic) change.generic = true;
	ctx.changes.push(change);
}

/* --- Inline level ----------------------------------------------------------- */

// Convert the inline colon directives in a run of ordinary lines. Code spans,
// maths, comments, tags, URLs and link destinations are copied as they stand.
function convertInline(s, firstLine, ctx) {
	let out = '';
	let i = 0;
	const lineAt = (k) => firstLine + (s.slice(0, k).match(/\n/g) || []).length;
	const copyTo = (end) => { out += s.slice(i, end); i = end; };

	while (i < s.length) {
		const c = s[i];
		const r = s.slice(i);
		let m;
		if (c === '`') {
			const run = r.match(/^`+/)[0];
			const end = findCodeEnd(s, i + run.length, run.length);
			copyTo(end === -1 ? i + run.length : end);
			continue;
		}
		// Keys are not prose: `@ref[fig:x]`, `\ref{fig:x}`, `\cite[p. 3]{a:b}`, and
		// an attribute block after a name or bracket, `@begin(eq){id=eq:mu}`.
		if (c === '{' && /[)\]]/.test(s[i - 1] || '') && (m = r.match(/^\{[^}\n]*\}/))) { copyTo(i + m[0].length); continue; }
		if ((m = r.match(/^@(?:label|ref|cref|Cref|target|index|TeX)\[[^\]]*\]/))) { copyTo(i + m[0].length); continue; }
		if ((m = r.match(/^\\[A-Za-z]+\*?(?:\[[^\]\n]*\])*\{[^}\n]*\}/))) { copyTo(i + m[0].length); continue; }
		if (c === '\\') {
			if (r[1] === '(' || r[1] === '[') {
				const end = s.indexOf(r[1] === '(' ? '\\)' : '\\]', i + 2);
				copyTo(end === -1 ? i + 2 : end + 2);
			} else copyTo(Math.min(i + 2, s.length));
			continue;
		}
		if (c === '$') {
			const d = r.startsWith('$$') ? '$$' : '$';
			const end = s.indexOf(d, i + d.length);
			copyTo(end === -1 ? i + d.length : end + d.length);
			continue;
		}
		// The inline comment (`%` unless the header says otherwise) runs to the end
		// of its line, and nothing in it is rendered: no directive is read there.
		if (ctx.comment && r.startsWith(ctx.comment)) {
			const end = s.indexOf('\n', i);
			copyTo(end === -1 ? s.length : end);
			continue;
		}
		if (r.startsWith('<!--')) {
			const end = s.indexOf('-->', i + 4);
			copyTo(end === -1 ? s.length : end + 3);
			continue;
		}
		if (c === '<' && (m = r.match(/^<\/?[A-Za-z][^<>]*>|^<[a-zA-Z][\w+.-]*:[^\s<>]*>/))) { copyTo(i + m[0].length); continue; }
		if (c === ']' && r[1] === '(') {
			const end = s.indexOf(')', i + 2);
			copyTo(end === -1 ? i + 2 : end + 1);
			continue;
		}
		if ((m = r.match(/^(?:[a-zA-Z][\w+.-]*:\/\/|mailto:|www\.)[^\s<>()]*/)) && !/\w/.test(s[i - 1] || '')) {
			copyTo(i + m[0].length);
			continue;
		}
		if (c === ':') {
			const done = convertInlineDirective(s, i, lineAt(i), ctx);
			if (done) { out += done.text; i = done.end; continue; }
		}
		// A word: copied whole, so a URL scheme glued to it is seen from its start.
		if ((m = r.match(/^[A-Za-z0-9_]+/))) {
			if ((m = r.match(/^[a-zA-Z][\w+.-]*:\/\/[^\s<>()]*/))) { copyTo(i + m[0].length); continue; }
			copyTo(i + r.match(/^[A-Za-z0-9_]+/)[0].length);
			continue;
		}
		copyTo(i + 1);
	}
	return out;
}

// The end of a code span opened by `n` backticks at `from`: the index after a
// closing run of exactly `n`, or -1.
function findCodeEnd(s, from, n) {
	const re = /`+/g;
	re.lastIndex = from;
	let m;
	while ((m = re.exec(s))) if (m[0].length === n) return m.index + n;
	return -1;
}

function convertInlineDirective(s, i, line, ctx) {
	const prev = s[i - 1] || '';
	// `:index[…]` is not a colon directive: indexing.js claims the literal prefix
	// `:index[` or `@index[` alike, glued to its word or not, so the prefix is all
	// that changes.
	// A directive on a `keep` line is left as written, and said.
	const kept = (name, raw) => { record(ctx, line, 'kept', name, raw, undefined, 'kept as written (keep)'); return null; };
	if (s.startsWith(':index[', i) && prev !== ':') {
		if (ctx.keep.has(line)) return kept('index', ':index[');
		record(ctx, line, 'same', 'index', ':index[', '@index[');
		return { text: '@index[', end: i + ':index['.length };
	}
	const m = s.slice(i).match(INLINE_RE);
	if (!m) return null;
	if (prev === ':') return null;            // `::` mid-line: a description list's
	const head = lexHeader(m[1]);
	const name = head.names.at(-1);
	const bracket = head.text !== undefined || head.attrs !== undefined;
	const raw = m[0];

	if (!bracket) {
		// `:heart:` and `:fa-…:` are emoji; other bare names render as an empty
		// element (`a:b` → a<b></b>) — prose, reported, never rewritten.
		if (s[i + raw.length] === ':' || /^fa-/.test(name || '')) return null;
		if (name && BARE_INLINE.has(name) && !/\w/.test(prev)) {
			if (ctx.keep.has(line)) return kept(name, raw);
			record(ctx, line, 'same', name, raw, `@${name}`);
			return { text: `@${name}`, end: i + raw.length };
		}
		if (name && head.names.length === 1) record(ctx, line, 'prose', name, raw, undefined, `renders as an empty <${name}> element today; prints as written once the colon syntax is gone`);
		return null;
	}
	// No name (`Note:[x]`, Meta Bind's `date:{due}`): a bare <span> today, and
	// almost always prose, not a directive anyone meant.
	if (!name) { record(ctx, line, 'prose', '', raw, undefined, 'renders as a bare <span> today; prints as written once the colon syntax is gone'); return null; }
	if (/\w/.test(prev)) {
		record(ctx, line, 'needs-you', name, raw, undefined, 'glued to the word before it, where an @ is never a directive: reword it (or add a space) by hand');
		return null;
	}
	if (head.names.length > 1) { record(ctx, line, 'needs-you', name, raw, undefined, `more than one name (the colon syntax uses the last, \`${name}\`)`); return null; }

	// `:target{…}` with no [text] names no target: the colon form printed it as
	// written (sources-and-targets.js), where @target{…} would render an empty
	// target. Left as it stands; it prints the same once the syntax is gone.
	if (name === 'target' && head.text === undefined) {
		record(ctx, line, 'prose', name, raw, undefined, 'a :target with no [text] printed as written; it still will');
		return null;
	}
	const cls = classify(name, SPECIAL_INLINE.has(name), ctx, false);
	if (cls.kind === 'needs-you') { record(ctx, line, 'needs-you', name, raw, undefined, cls.note); return null; }
	if (ctx.keep.has(line)) return kept(name, raw);
	const inner = innerText(head.text, name, line, ctx);
	const to = `@${cls.at}${inner !== undefined ? `[${inner}]` : ''}${head.attrs !== undefined ? `{${head.attrs}}` : ''}`;
	record(ctx, line, cls.kind, name, raw, to, cls.note, cls.generic);
	return { text: to, end: i + raw.length };
}

// The short name Clew uses.
export const convert = convertColonDirectives;
