/*
	Obsidian links and embeds — OFF by default (the owner, 2026-10-05: "teach it,
	Clew switches it on"). On through processFile's `obsidianLinks` option —
	`true`, or an object carrying the host's resolvers — the CLI's
	`--obsidian-links`, or `Obsidian links: true` in a header or config. Off, the
	extension claims nothing and cuts no text, so every document reads as before.

	  [[Note]]  [[Note|alias]]  [[Note#Heading]]  [[Note#^block]]  [[#Heading]]
	      print as their text: the alias, else the note's name with its heading
	      as Obsidian shows it ("Note > Heading"; a block id is not shown). In
	      HTML that is a link only when the host's resolveLink gives an href; in
	      a book, a link to a chapter is a chapter link in both outputs
	      (book.js). Otherwise it is text.
	  ![[x.png]]  ![[x.png|300]]  ![[x.png|300x200]]  ![[x.png|alt|300]]
	      an image, as a Markdown image is (<img> / \includegraphics), its width
	      (and height) honoured as @image honours pixels: 300 → 225bp in print.
	      The name goes through the host's resolveEmbed, else stays as written —
	      relative to the file, as a Markdown image's path is.
	  ![[Note]]   (a note, or any embed that is not an image)
	      not transcluded: printed as its text, and warned by name.

	The host's resolvers (processFile's `obsidianLinks: { resolveLink,
	resolveEmbed }`) each take the name as written and return a string, or
	nothing to decline:
	  resolveLink(name, { heading, block, target })  → an href
	  resolveEmbed(name, { file })                    → a path or URL
	`file` is the ABSOLUTE path of the file the embed is written in: the note,
	or in a book the chapter (null for stdin). A relative path returned is
	relative to that file, and is then handled exactly as a Markdown image's
	path written there: rebased onto the master's folder in a book (book.js),
	then onto each page's folder in a split book (book-pages.js) or the .tex's
	folder in a book's LaTeX (latex-graphics.js texPath). A host that returns
	relative paths keeps its own absolute paths out of the files it exports.

	Code spans and blocks and maths are never seen: their tokenizers claim them
	first. `\[[` is literal. A `[[x.md]]` alone on its line is still a file
	inclusion while `File inclusion` is on, since that splice runs before
	parsing; Clew turns it off.
*/

import { configManager } from './config-manager.js';
import { addWarning } from './warnings.js';
import { escapeTexText } from './latex-escape.js';
import { latexGraphic } from './latex-graphics.js';
import { currentLexChapter } from './book.js';
import path from 'path';

// The build's processFile option: undefined when it gave none.
let hostOption;

/** Set by processFile at the start of every build. */
export function setObsidianLinks(option) { hostOption = option; }

function enabled() {
	if (hostOption !== undefined && hostOption !== null) return hostOption !== false;
	const value = configManager.getMeta('Obsidian links');
	if (value === true) return true;
	return (Array.isArray(value) ? value.join(' ') : String(value ?? '')).trim().toLowerCase() === 'true';
}

const resolver = (name) => (hostOption && typeof hostOption[name] === 'function' ? hostOption[name] : null);

const WIKI = /^(!?)\[\[([^[\]\n|]*?)(?:\|([^[\]\n]*))?\]\]/;
const IMAGE = /\.(?:png|jpe?g|gif|bmp|svg|webp|avif)$/i;

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;');

// `name#Heading#Sub` or `name#^block`, read apart.
function readTarget(target) {
	const parts = target.replace(/\\$/, '').split('#');
	const name = parts[0].trim();
	const rest = parts.slice(1).map((p) => p.trim()).filter(Boolean);
	const block = rest.length && rest[rest.length - 1].startsWith('^') ? rest.pop().slice(1) : null;
	return { name, headings: rest, block };
}

// What a link prints: the alias, else the note's name (no `.md`) and its headings.
function linkText({ name, headings, block }, alias) {
	if (alias != null && alias.trim()) return alias.trim();
	const shown = [name.replace(/\.md$/i, ''), ...headings].filter(Boolean);
	if (shown.length) return shown.join(' > ');
	return block ? `^${block}` : '';
}

// An embed's `|…` parts: `300` or `300x200` a size, anything else its alt text.
function embedOptions(alias, name) {
	let width = null;
	let height = null;
	let alt = null;
	for (const part of (alias ?? '').split('|')) {
		const size = /^\s*(\d+)\s*(?:x\s*(\d+)\s*)?$/.exec(part);
		if (size) { width = Number(size[1]); height = size[2] ? Number(size[2]) : null; }
		else if (part.trim() && alt === null) alt = part.trim();
	}
	return { width, height, alt: alt ?? name.split('/').pop() };
}

// The file an embed is written in, for the host's resolveEmbed: the chapter
// being lexed in a book, else the note itself — absolute, or null on stdin.
function embedFile() {
	const chapter = currentLexChapter();
	if (chapter) return chapter.abs;
	const note = global.current_file;
	return note && note !== '<stdin>' ? path.resolve(note) : null;
}

// Screen pixels in print, as media.js reads them: 96 to the inch, so 3/4 bp.
const bp = (px) => `${Math.round(px * 75) / 100}bp`;

export const obsidianLinks = {
	name: 'obsidianLink',
	level: 'inline',
	start(src) {
		if (!enabled()) return;
		const m = /!?\[\[[^[\]\n]+\]\]/.exec(src);
		return m ? m.index : undefined;
	},
	tokenizer(src) {
		if (!enabled()) return;
		const m = WIKI.exec(src);
		if (!m || !m[2].trim()) return;
		const target = readTarget(m[2]);
		const alias = m[3] ?? null;
		if (m[1] && IMAGE.test(target.name)) {
			const { width, height, alt } = embedOptions(alias, target.name);
			const href = resolver('resolveEmbed')?.(target.name, { file: embedFile() }) || target.name;
			return { type: 'obsidianEmbed', raw: m[0], href: String(href), alt, width, height };
		}
		const text = linkText(target, m[1] ? null : alias);
		if (m[1]) {
			addWarning(`obsidian: ${m[0]} — only images can be embedded, so this prints as its text`);
		}
		const href = m[1] ? null : resolver('resolveLink')?.(target.name, { heading: target.headings.join('#') || null, block: target.block, target: m[2] });
		return {
			type: 'obsidianLink',
			raw: m[0],
			name: target.name,
			text,
			href: href ? String(href) : null,
			// The text as a token of its own, for a chapter link (book.js) to render.
			tokens: [{ type: 'obsidianText', raw: text, text }],
		};
	},
	renderer(token) {
		if (global.isLatex) return escapeTexText(token.text);
		if (token.href) return `<a class="internal-link" data-href="${escapeAttr(token.name)}" href="${escapeAttr(token.href)}">${escapeHtml(token.text)}</a>`;
		return escapeHtml(token.text);
	},
};

// A link's text, escaped for the output it lands in.
export const obsidianText = {
	name: 'obsidianText',
	renderer(token) {
		return global.isLatex ? escapeTexText(token.text) : escapeHtml(token.text);
	},
};

export const obsidianEmbed = {
	name: 'obsidianEmbed',
	renderer(token) {
		if (global.isLatex) {
			const size = token.width
				? `[width=${bp(token.width)}${token.height ? `,height=${bp(token.height)}` : ''}]`
				: '[width=\\textwidth]';
			return latexGraphic({ src: token.href, alt: token.alt, what: 'image', options: () => size });
		}
		// As marked writes a Markdown image, with the size Obsidian gives it.
		const src = encodeURI(token.href).replace(/%25/g, '%');
		const size = (token.width ? ` width="${token.width}"` : '') + (token.height ? ` height="${token.height}"` : '');
		return `<img src="${escapeAttr(src)}" alt="${escapeAttr(token.alt)}"${size}>`;
	},
};
