/*
	Book mode — phase 1 of docs/dev/book-mode-engine.md (option A): an ordered
	list of chapter files built as ONE document, so numbering, cross-
	references, the contents, the References and the Index run across the
	whole book in both outputs, with what a book needs on top.

	A build is a book when its chapters are named:
	  - by a host, through processFile's `chapters` option (Clew reads its
	    master note's `chapters:` list and passes the paths); or
	  - in the master's body, one `@chapter+(path)` line per chapter, in order.
	    Text between them (matter markers, an epigraph) stays where it is, in
	    the book's flow but in no chapter.
	Neither: not a book, and nothing here runs — a single document renders as
	it always has.

	The master's header is the book's configuration. Each chapter is read,
	and:
	  - its front matter is stripped (it used to be rendered as content). Its
	    whitelisted keys (§7 of the note: Bibliography, Packages, LaTeX
	    preamble, Lang, Math macros) are kept for that chapter; any other
	    ENGINE key is warned, naming the chapter. Keys that are the chapter's
	    own data (title, status, aliases, tags, and anything the engine does
	    not know) are left alone;
	  - its title follows the rule: the first `#` heading; failing that its
	    front-matter `title`; failing that its file name — inserted as the
	    chapter's `#` heading. Text before the first `#` heading, and a second
	    `#` heading (each starts a chapter), are warned;
	  - its own [[file]] inclusions resolve against ITS folder.

	The chapters are then joined into one stream between marker lines, and
	the parse is a single marked.parse, with three hooks that only act on a
	stream carrying markers:
	  - provideLexer lexes each chapter ON ITS OWN (BookLexer). marked-
	    footnote keys its notes by label per lexer, so a `[^1]` in two chapters
	    no longer collides (the second chapter used to get the first's note),
	    and each chapter's notes form their own list at its end. Its state —
	    a flag, a running counter, one reused token — is reset between
	    chapters (resetFootnoteState);
	  - a walkTokens hook carries the chapter context: warnings get their
	    place, and an image or link path relative to the chapter is rebased
	    onto the master's folder (G10 — it used to keep pointing at the
	    master's folder); a link to another chapter's file becomes a link to
	    that chapter;
	  - provideParser renders one top-level block at a time, so a warning
	    raised while rendering knows its chapter and line.
	Each chapter renders inside `<section class="jmd-chapter" id="jmd-chapter-N"
	data-chapter data-file>` in HTML (the post-processor and the split read
	it); in LaTeX its `#` heading is the \chapter.

	Warnings in a book name `chapter-file:line` (warnings.js). The line is the
	chapter file's: the line map adds back the stripped front matter and
	takes away an inserted title.
*/

import fs from 'fs';
import path from 'path';
import { isDeepStrictEqual } from 'util';
import { marked } from 'marked';
import { configManager, DEFAULT_CONFIG } from './config-manager.js';
import { addWarning, setWarningLocation, getWarningLocation } from './warnings.js';
import processFileInclusions from './file-inclusion.js';
import { requirePackage } from './preamble.js';

/* --- the current build's book ----------------------------------------------------- */

let book = null;

/** The current build's book plan, or null when the build is not a book. */
export function getBook() { return book; }

/**
 * Whether theorem-like counters number within the chapter (Theorem 2.1): a
 * book numbering per chapter, the default. Outside a book, false — the
 * declarations stay exactly what they were.
 */
export function numberWithinChapter() { return !!book && book.numbering === 'per chapter'; }

// `Numbering:` (the master's header) or processFile's `numbering` option:
// 'per chapter' (the default — Figure 2.3, as LaTeX's book class does, theorems
// too) or 'continuous' (Figure 17).
function numberingPolicy(value) {
	const raw = Array.isArray(value) ? value.join(' ') : value;
	const policy = parseNumbering(raw);
	if (policy) return policy;
	addWarning(`book: \`Numbering: ${String(raw).trim()}\` is neither "per chapter" nor "continuous" — numbering per chapter`);
	return 'per chapter';
}

// `HTML layout:` (the master's header) or processFile's `htmlLayout` option:
// 'single' (one page, the default) or 'split' (book-pages.js; 'pages' too, the
// plan's first name for it).
function layoutPolicy(value) {
	const raw = Array.isArray(value) ? value.join(' ') : value;
	if (raw == null || String(raw).trim() === '') return 'single';
	const v = norm(raw);
	if (v === 'split' || v === 'pages') return 'split';
	if (v === 'single') return 'single';
	addWarning(`book: \`HTML layout: ${String(raw).trim()}\` is neither "single" nor "split" — one page`);
	return 'single';
}

/** 'split' when a book is to be written as pages (book-pages.js), else 'single'. */
export function bookLayout() { return book ? book.layout : 'single'; }

// A `Numbering` value read, or null when it is neither policy. Unset is the default.
function parseNumbering(raw) {
	if (raw == null || String(raw).trim() === '') return 'per chapter';
	const v = norm(raw);
	if (v === 'continuous') return 'continuous';
	if (v === 'per chapter' || v === 'chapter' || v === 'by chapter') return 'per chapter';
	return null;
}

// A setting of the master's, however its key is written. A header's keys are
// merged as written, so `numbering:` (as YAML and Clew write keys) lands under
// its own spelling where the engine reads `Numbering`; a book's own keys are
// matched as loosely as a chapter's whitelist. Single files are untouched.
function masterSetting(name) {
	const exact = configManager.get(name);
	if (exact != null) return exact;
	const key = Object.keys(configManager.config || {}).find((k) => norm(k) === norm(name));
	return key === undefined ? undefined : configManager.config[key];
}

export function resetBook() { book = null; lexChapter = null; }

const START = (n) => `<!-- jmd:chapter ${n} -->`;
const END = '<!-- jmd:end-chapter -->';
const MARKERS = /^<!-- jmd:(chapter \d+|end-chapter) -->$/m;
const MARKERS_SPLIT = /^<!-- jmd:(chapter \d+|end-chapter) -->$/gm;

/**
 * Whether `text` holds a chapter boundary — for a pass over the assembled
 * stream that must not carry state from one chapter into the next
 * (inline-footnotes.js's ambient groups and multi-paragraph notes).
 */
export function hasChapterMarker(text) { return MARKERS.test(text); }

/**
 * Where a chapter's inline `[fn: …]` notes are listed: the HTML renderer puts
 * this placeholder just before a chapter's `</section>`, and
 * inline-footnotes.js's fillEndnotes replaces it with that chapter's list (or
 * nothing). The `@endnotes` / `@bibliography` placeholder pattern.
 */
export const chapterNotesPlaceholder = (n) => `<div class="jmd-chapter-notes" data-chapter="${n}"></div>`;
export const CHAPTER_NOTES = /<div class="jmd-chapter-notes" data-chapter="(\d+)"><\/div>/g;

/* --- a chapter's header ------------------------------------------------------------- */

const norm = (key) => String(key).trim().toLowerCase().replace(/[\s_-]+/g, ' ');

// What a chapter may set for itself (the owner's whitelist, §7).
const WHITELIST = new Map([
	['bibliography', 'bibliography'],
	['packages', 'packages'],
	['latex preamble', 'preamble'],
	['lang', 'lang'],
	['language', 'lang'],
	['math macros', 'mathMacros'],
]);
// The chapter's own data — never a setting, never warned.
const CHAPTER_DATA = new Set(['title', 'status', 'aliases', 'tags', 'cssclasses', 'cssclass']);
// Keys the engine reads from a header beyond its config defaults.
const HEADER_KEYS = [
	'Author', 'Date', 'Bibliography style', 'Bibliography mode', 'Resolve citations',
	'Citation tooltips', 'Minimal bibliography', 'LaTeX bib style', 'Biblify activate',
	'Biblify defer', 'Headings', 'Numbering', 'Load extensions', 'Load directives',
	'Load javascript', 'Load environments', 'Optionals', 'Inline comment', 'Custom element',
	'Smart typography', 'Pandoc citations', 'Block elements', 'Silence warnings',
	'Document class', 'Class options', 'Heading base', 'Chapters', 'Book', 'HTML layout',
];
// Built on first use, not at load: theorems.js and numbered-environments.js
// import this module from inside config-manager's own import graph, so
// DEFAULT_CONFIG is not yet initialised while this module loads.
let engineKeys = null;
// A key in the engine's own spelling (`resolve citations` → `Resolve
// citations`), or null when the engine has no such key.
const engineKey = (key) => {
	engineKeys ??= new Map([...Object.keys(DEFAULT_CONFIG), ...HEADER_KEYS].map((k) => [norm(k), k]));
	if (engineKeys.has(norm(key))) return engineKeys.get(norm(key));
	return /^extension\b/i.test(String(key).trim()) ? String(key).trim() : null;
};
const isEngineKey = (key) => engineKey(key) !== null;

/**
 * Whether a chapter's `key: value` is what the book already uses — the
 * master's setting, else the engine's default — so a chapter that only
 * repeats it (for its own reading view, say) is not warned. Read as the engine
 * reads it: mergeMetadata itself merges the key, in its engine spelling, into
 * a copy of the book's configuration, so `True` and `true` agree exactly where
 * the engine reads them alike, and nothing is applied. A key the copy gains
 * (one the book leaves unset) must equal the value the engine reads in its
 * place: a header's `Document_class` overrides DEFAULT_CONFIG's spaced
 * `Document class` (configManager.getMeta).
 */
function sameAsBook(key, value) {
	const canonical = engineKey(key);
	if (norm(canonical) === 'numbering') return parseNumbering(value) === book.numbering;
	const before = configManager.config;
	let after;
	try {
		const trial = Object.create(configManager);
		trial.config = structuredClone(before);
		trial.loaded = true;
		trial.mergeMetadata({ [canonical]: [value] });
		after = trial.config;
	} catch {
		return false;
	}
	for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (isDeepStrictEqual(before[k], after[k])) continue;
		if (k in before) return false;
		const twin = Object.keys(before).find((b) => norm(b) === norm(k));
		const word = (v) => norm(Array.isArray(v) ? v.join(' ') : String(v));
		if (twin === undefined || word(after[k]) !== word(before[twin])) return false;
	}
	return true;
}

/**
 * A chapter's leading header — a `---`-fenced block, or JMarkdown's bare
 * `Key: value` lines up to a `---` rule — as { data, body, lines }: `data`
 * maps each key (as written) to its value lines joined, `lines` is how many
 * lines it took. The same detection as the master's (processYAMLheader),
 * without merging anything into the configuration.
 */
export function splitChapterHeader(text) {
	const opener = text.match(/^---[ \t]*\r?\n/);
	const rest = opener ? text.slice(opener[0].length) : text;
	const fencedOnly = configManager.get('Header style') === 'fenced';
	if (!/^[-a-zA-Z0-9 ]+:/.test(rest) || (fencedOnly && !opener)) return { data: {}, body: text, lines: 0 };
	const term = rest.match(/\n^---.*$/m);
	const head = term ? rest.slice(0, term.index) : rest;
	const body = term ? rest.slice(term.index + term[0].length).replace(/^\r?\n/, '') : '';
	const data = {};
	let key = null;
	for (const line of head.split('\n')) {
		const m = line.match(/^([-a-zA-Z0-9 ]+):\s*(.*)$/);
		if (m) {
			key = m[1].trim();
			data[key] = m[2].trim() ? [m[2]] : [];
		} else if (key && line.trim()) {
			data[key].push(line);
		}
	}
	for (const k of Object.keys(data)) data[k] = data[k].join('\n');
	// The opening fence, the header's own lines, and the closing rule: the
	// body's first line is the file's next one.
	const lines = (opener ? 1 : 0) + head.split('\n').length + (term ? 1 : 0);
	return { data, body, lines };
}

const unquote = (v) => String(v).trim().replace(/^(["'])(.*)\1$/, '$2');

// The whitelisted keys a chapter sets, by setting name; every other engine key
// warned, naming the chapter.
function chapterSettings(data, name) {
	const settings = {};
	for (const [key, value] of Object.entries(data)) {
		const n = norm(key);
		if (WHITELIST.has(n)) settings[WHITELIST.get(n)] = value;
		else if (!CHAPTER_DATA.has(n) && isEngineKey(key) && !sameAsBook(key, value)) {
			addWarning(`book: this chapter sets \`${key}\` — a book takes that from its master, so it is not applied`);
		}
	}
	return settings;
}

/* --- a chapter's title ----------------------------------------------------------------- */

// Level-1 ATX headings outside fenced code and display maths, and the index
// of the first line of real content.
function scanHeadings(lines) {
	const h1 = [];
	let firstContent = -1;
	let fence = null;
	let math = false;
	lines.forEach((line, i) => {
		const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
		if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; return; }
		if (f) { fence = f[1]; if (firstContent < 0) firstContent = i; return; }
		if (math) { if (/\$\$/.test(line)) math = false; return; }
		if (/^\s*\$\$/.test(line) && !/\$\$.*\$\$/.test(line)) { math = true; if (firstContent < 0) firstContent = i; return; }
		if (/^ {0,3}#(?!#)\s+\S/.test(line)) h1.push(i);
		if (firstContent < 0 && line.trim() && !/^\s*<!--.*-->\s*$/.test(line)) firstContent = i;
	});
	return { h1, firstContent };
}

/* --- assembly --------------------------------------------------------------------------- */

const CHAPTER_LINE = /^[ \t]*@chapter\+\(([^)\n]+)\)[ \t]*$/;

// The `@chapter+(path)` lines of a master's body (outside fenced code), with
// the text around them: [{ text }, { chapter: path }, { text }, …].
function chapterLines(body) {
	const pieces = [];
	let text = [];
	let fence = null;
	for (const line of body.split('\n')) {
		const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
		if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; text.push(line); continue; }
		if (f) { fence = f[1]; text.push(line); continue; }
		const m = line.match(CHAPTER_LINE);
		if (m) {
			pieces.push({ text: text.join('\n') });
			text = [];
			pieces.push({ chapter: m[1].trim() });
		} else {
			text.push(line);
		}
	}
	pieces.push({ text: text.join('\n') });
	return pieces;
}

/**
 * Make the master's body (its header already read) a book, if it is one:
 * returns the assembled stream, or null for an ordinary document. `chapters`
 * is processFile's option (a host's list); otherwise the body's
 * `@chapter+(path)` lines name them.
 */
export function prepareBook(body, { chapters: hostChapters = null, masterDir, isLatex = false, numbering = null, htmlLayout = null } = {}) {
	book = null;
	const fromHost = Array.isArray(hostChapters) && hostChapters.length > 0;
	let pieces = chapterLines(body);
	const named = pieces.filter((p) => p.chapter);
	if (fromHost) {
		if (named.length) addWarning('book: the master\'s `@chapter+` lines are ignored — the chapters were given by the host');
		pieces = [{ text: pieces.filter((p) => p.text != null).map((p) => p.text).join('\n') },
			...hostChapters.map((c) => ({ chapter: String(c) }))];
	} else if (named.length === 0) {
		return null;
	}

	book = { masterDir, chapters: [], isLatex, numbering: numberingPolicy(numbering ?? masterSetting('Numbering')),
		lang: languageTag(configManager.get('Lang')) || 'en',
		layout: layoutPolicy(htmlLayout ?? masterSetting('HTML layout')) };
	// A book's # headings are its chapters: a master naming no class is a book.
	// Set before the chapters are read, which compare their own settings with it.
	if (configManager.get('Document_class') == null) configManager.set('Document class', 'book');
	const out = [];
	const backMatter = [];
	for (const piece of pieces) {
		if (piece.text != null) { out.push(takeBackMatter(piece.text, backMatter)); continue; }
		const chapter = readChapter(piece.chapter, book.chapters.length + 1, masterDir);
		if (!chapter) continue;
		chapter.macros = chapterMacros(chapter);
		chapter.lang = languageTag(chapter.settings.lang);
		book.chapters.push(chapter);
		out.push(`\n\n${START(chapter.index)}\n${chapter.text}\n\n${END}\n\n`);
	}
	// The References and the index follow the last chapter (the owner's D11).
	if (backMatter.length) out.push(`\n\n${backMatter.join('\n\n')}\n`);
	return out.join('\n');
}

// The master's @bibliography and @index placement lines (and their legacy
// spellings), outside code fences: a book's one References list and its
// index come after its last chapter, in the order written, however the
// chapters were given — host-given chapters put the master's whole text
// before chapter 1, and its closing @bibliography with it. Each line is
// taken out of `text` (left blank) and added to `into`.
const PLACEMENT = /^[ \t]{0,3}(?:@bibliography|::Bibliography|@index|::Index)[ \t]*(?:\{[^}\n]*\})?[ \t]*$/;

function takeBackMatter(text, into) {
	let fence = null;
	return text.split('\n').map((line) => {
		const opener = /^[ \t]*(`{3,}|~{3,})/.exec(line);
		if (opener) {
			if (!fence) fence = opener[1][0];
			else if (opener[1][0] === fence) fence = null;
			return line;
		}
		if (fence || !PLACEMENT.test(line)) return line;
		into.push(line.trim());
		return '';
	}).join('\n');
}

function readChapter(name, index, masterDir) {
	const abs = path.resolve(masterDir, name);
	let source;
	try { source = fs.readFileSync(abs, 'utf8'); } catch {
		addWarning(`book: chapter "${name}" cannot be read — it is left out`);
		return null;
	}
	const dir = path.dirname(abs);
	setWarningLocation({ file: name });
	const { data, body, lines: headerLines } = splitChapterHeader(source);
	const settings = chapterSettings(data, name);

	// The title rule.
	const bodyLines = body.split('\n');
	const { h1, firstContent } = scanHeadings(bodyLines);
	let text = body;
	let inserted = 0;
	let title;
	if (h1.length === 0) {
		const fromHeader = Object.entries(data).find(([k]) => norm(k) === 'title');
		title = fromHeader && unquote(fromHeader[1]) ? unquote(fromHeader[1]) : path.basename(name, path.extname(name));
		text = `# ${title}\n\n${body}`;
		inserted = 2;
	} else {
		title = bodyLines[h1[0]].replace(/^ {0,3}#\s+/, '').replace(/\s+#*\s*$/, '');
		if (firstContent >= 0 && firstContent < h1[0]) {
			setWarningLocation({ file: name, line: firstContent + 1 + headerLines });
			addWarning('book: text before this chapter\'s first # heading — in print it falls at the end of the previous chapter');
		}
		if (h1.length > 1) {
			setWarningLocation({ file: name, line: h1[1] + 1 + headerLines });
			addWarning(`book: ${h1.length} level-1 headings in this chapter; each starts a chapter`);
		}
	}
	setWarningLocation(null);

	// A chapter's own [[file]] inclusions are its own: against its folder.
	if (configManager.get('File inclusion') !== false) text = processFileInclusions(text, dir);

	return {
		index, name, abs, dir, title, settings, text,
		// Segment line k (1-based) is file line k + offset.
		offset: headerLines - inserted,
	};
}

/* --- per-chapter lexing ------------------------------------------------------------------- */

// marked-footnote's state is per extension instance — a flag that it has put
// its footnotes token in, a running reference counter, and one footnotes
// token it reuses. Between chapters: reset the flag (its walkTokens does),
// and the counter (its footnoteRef renderer does), so the next chapter starts
// clean and numbers its notes from 1.
function resetFootnoteState() {
	const walk = marked.defaults.walkTokens;
	if (walk) walk.call(marked, { type: 'space', raw: '' });
	const ref = marked.defaults.extensions?.renderers?.footnoteRef;
	if (ref) ref.call({ parser: null }, { id: '', label: '' });
}

// A chapter's (or master piece's) own footnotes token goes to its own end —
// a COPY, since marked-footnote reuses one token object and the next
// chapter's lexing empties it.
function settleFootnotes(tokens) {
	const first = tokens[0];
	if (!first || first.type !== 'footnotes') return;
	tokens[0] = { type: 'space', raw: '' };
	if (first.items && first.items.length) {
		// Generated, so it has no line of its own (lex() gave index 0's).
		const { _jmdLoc, ...copy } = first;
		tokens.push({ ...copy, rawItems: first.rawItems.slice(), items: first.items.slice() });
	}
	// marked hands a one-newline space token to the token before it, and this
	// one is marked-footnote's own, reused by every chapter: a chapter that
	// opens with a blank line left its newline in `raw`, and every later
	// chapter counted it — its lines one too many. Its raw is only the list's
	// heading text (the renderer trims it), so the newline goes.
	first.raw = String(first.raw).replace(/\s+$/, '');
}

// Every token array inside a top-level token, mapped to its line.
function mapArrays(value, line, map) {
	if (Array.isArray(value)) {
		map.set(value, line);
		for (const v of value) mapArrays(v, line, map);
	} else if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value)) {
			if (k !== 'raw' && k !== 'text' && (Array.isArray(v) || (v && typeof v === 'object'))) mapArrays(v, line, map);
		}
	}
}

// The chapter being lexed, for a tokenizer that needs its file (an Obsidian
// embed's, for the host's resolveEmbed); null in the master's own text.
let lexChapter = null;

/** The chapter whose text is being lexed, as a tokenizer runs; else null. */
export function currentLexChapter() { return lexChapter; }

class BookLexer extends marked.Lexer {
	constructor(options, chapter) {
		super(options);
		this.chapter = chapter;
	}

	// marked's own lex(), with the chapter's place set for each step: its
	// blocks (chapter only — a block tokenizer is not told where it is), then
	// each block's inline content at that block's line.
	lex(src) {
		src = src.replace(/\r\n|\r/g, '\n');
		lexChapter = this.chapter;
		const where = this.chapter ? { file: this.chapter.name } : null;
		setWarningLocation(where);
		this.blockTokens(src, this.tokens);
		const lineOf = new Map();
		if (this.chapter) {
			let line = 1;
			for (const token of this.tokens) {
				const at = line + this.chapter.offset;
				token._jmdLoc = { file: this.chapter.name, line: at };
				mapArrays(token, at, lineOf);
				line += (String(token.raw || '').match(/\n/g) || []).length;
			}
		}
		for (const item of this.inlineQueue) {
			if (this.chapter) setWarningLocation({ file: this.chapter.name, line: lineOf.get(item.tokens) });
			this.inlineTokens(item.src, item.tokens);
		}
		this.inlineQueue = [];
		setWarningLocation(null);
		lexChapter = null;
		return this.tokens;
	}
}

function lexBook(src, options) {
	const parts = src.split(MARKERS_SPLIT);
	const tokens = [];
	let chapter = null;
	parts.forEach((part, i) => {
		if (i % 2 === 1) {
			if (part.startsWith('chapter')) {
				chapter = book.chapters.find((c) => c.index === Number(part.slice(8))) || null;
				tokens.push({ type: 'jmdChapter', edge: 'start', chapter, raw: '' });
			} else {
				tokens.push({ type: 'jmdChapter', edge: 'end', chapter, raw: '' });
				chapter = null;
			}
			return;
		}
		if (!part.trim()) return;
		// The marker line's own newline is not the chapter's: drop it, so the
		// chapter's first line is line 1.
		if (chapter) part = part.replace(/^\n/, '');
		resetFootnoteState();
		const lexed = new BookLexer(options, chapter).lex(part);
		settleFootnotes(lexed);
		for (const t of lexed) tokens.push(t);
	});
	resetFootnoteState();
	tokens.links = {};
	return tokens;
}

/* --- the book's one preamble: the chapters' Packages and LaTeX preamble ------------------------------ */

// A chapter's list or lines as written in front matter, with YAML's dressing
// (`[…]`, `- `, quotes, a lone `|`) taken off.
function settingLines(value, split) {
	if (value == null) return [];
	return (Array.isArray(value) ? value : [value])
		.flatMap((v) => String(v).split(split))
		.map((line) => line.trim().replace(/^\[|\]$/g, '').trim().replace(/^-\s+/, '').replace(/^(["'])(.*)\1$/, '$2').trim())
		.filter((line) => line && line !== '|' && line !== '>');
}

// The command or environment a preamble line defines (`\R`, `environment
// proof`), when the line holds the whole definition: its braces balance. A
// definition over several lines is kept as written, unchecked.
function definedName(line) {
	let depth = 0;
	for (const c of line.replace(/\\[{}]/g, '')) {
		if (c === '{') depth++;
		else if (c === '}' && --depth < 0) return null;
	}
	if (depth !== 0) return null;
	const command = /^\\(?:(?:new|renew|provide)command|DeclareMathOperator|DeclareRobustCommand)\*?\s*\{?\s*(\\[A-Za-z@]+)/.exec(line)
		|| /^\\def\s*(\\[A-Za-z@]+)/.exec(line);
	if (command) return command[1];
	const env = /^\\(?:(?:new|renew)environment|newtheorem|declaretheorem)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/.exec(line);
	return env ? `environment ${env[1].trim()}` : null;
}

/**
 * What the chapters add to the book's one preamble: `packages` they name that
 * the master does not, and `preamble` lines it lacks, in book order. A line
 * already present goes in once. A chapter line that defines what the master
 * or an earlier chapter defines differently is left out and listed in
 * `clashes` ({ chapter, message }): LaTeX has one preamble, where a second
 * \newcommand of a name stops the build. Outside a book, nothing. Computed
 * once a build; latex-template.js warns the clashes, latex-lint.js counts the
 * rest as loaded.
 */
export function bookPreamble() {
	if (!book) return { packages: [], preamble: [], clashes: [] };
	if (book.preambleJoin) return book.preambleJoin;
	const meta = (key) => configManager.getMeta(key);
	const packages = [];
	const have = new Set(settingLines(meta('Packages'), /[,\n]/));
	const preamble = [];
	const master = settingLines(meta('LaTeX preamble'), '\n');
	const seen = new Set(master.map((line) => line.replace(/\s+/g, ' ')));
	const defined = new Map();
	for (const line of master) {
		const name = definedName(line);
		if (name && !defined.has(name)) defined.set(name, null);
	}
	const clashes = [];
	for (const chapter of book.chapters) {
		for (const name of settingLines(chapter.settings.packages, /[,\n]/)) {
			if (!have.has(name)) { have.add(name); packages.push(name); }
		}
		for (const line of settingLines(chapter.settings.preamble, '\n')) {
			const squashed = line.replace(/\s+/g, ' ');
			if (seen.has(squashed)) continue;
			const name = definedName(line);
			if (name && defined.has(name)) {
				const by = defined.get(name);
				const owner = by ? by.name : 'the master';
				clashes.push({ chapter, message: `book: this chapter's \`LaTeX preamble\` defines ${name} differently from ${owner} — a book has one preamble, so ${by ? `${by.name}'s` : "the master's"} is used` });
				continue;
			}
			if (name) defined.set(name, chapter);
			seen.add(squashed);
			preamble.push(line);
		}
	}
	book.preambleJoin = { packages, preamble, clashes };
	return book.preambleJoin;
}

/* --- languages --------------------------------------------------------------------------------- */

// A `Lang` value as a BCP 47 tag (`de`, `en-GB`), or null.
function languageTag(value) {
	return settingLines(value, /[,\n\s]/)[0] || null;
}

const sameLanguage = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * The language the walk is in: in a book, the chapter's own `Lang`, else the
 * master's; null outside a book. Smart typography's quotation marks follow it.
 */
export function currentLanguage() {
	if (!book) return null;
	return currentWalkChapter()?.lang || book.lang;
}

// BCP 47 → babel. The Cyrillic and Greek ones need a Unicode engine's fonts.
const BABEL = {
	en: 'english', 'en-us': 'american', 'en-gb': 'british', 'en-au': 'australian', 'en-ca': 'canadian',
	'en-nz': 'newzealand', de: 'ngerman', 'de-at': 'naustrian', 'de-ch': 'nswissgerman', fr: 'french',
	es: 'spanish', it: 'italian', pt: 'portuguese', 'pt-br': 'brazilian', nl: 'dutch', sv: 'swedish',
	da: 'danish', nb: 'norsk', no: 'norsk', nn: 'nynorsk', fi: 'finnish', is: 'icelandic', pl: 'polish',
	cs: 'czech', sk: 'slovak', hu: 'magyar', ro: 'romanian', hr: 'croatian', sl: 'slovenian', tr: 'turkish',
	ca: 'catalan', gl: 'galician', eu: 'basque', ga: 'irish', cy: 'welsh', et: 'estonian', lv: 'latvian',
	lt: 'lithuanian', la: 'latin', ru: 'russian', uk: 'ukrainian', el: 'greek',
};
const NEEDS_UNICODE = new Set(['russian', 'ukrainian', 'greek']);

/**
 * The book's babel, once a build, when its languages need one: the chapters'
 * that differ from the master's, then the master's last (babel's main
 * language). A book wholly in English loads none, as one document does not.
 * A tag babel does not know, or a Cyrillic or Greek one under pdfLaTeX, is
 * warned at its chapter and printed as the book's language. Each chapter's
 * own babel name is left on it (`chapter.babel`), for otherlanguage*.
 */
function bookBabel() {
	if (book.babel !== undefined) return book.babel;
	const engine = String(configManager.getMeta('LaTeX engine') ?? '').trim().toLowerCase();
	const unicode = engine === 'lualatex' || engine === 'xelatex';
	const was = getWarningLocation();
	const usable = (tag, chapter) => {
		setWarningLocation(chapter ? { file: chapter.name } : null);
		const t = tag.toLowerCase();
		const name = BABEL[t] ?? BABEL[t.split('-')[0]];
		const whose = chapter ? 'this chapter' : 'the book';
		if (!name) addWarning(`book: \`Lang: ${tag}\` is not a language babel knows — in print ${whose} is hyphenated as ${chapter ? "the book's" : 'English'}`);
		else if (NEEDS_UNICODE.has(name) && !unicode) addWarning(`book: babel's ${name} needs a Unicode engine (\`LaTeX engine: lualatex\`) — in print ${whose} is hyphenated as ${chapter ? "the book's" : 'English'}`);
		else return name;
		return null;
	};
	const main = usable(book.lang, null) || 'english';
	for (const chapter of book.chapters) {
		chapter.babel = chapter.lang && !sameLanguage(chapter.lang, book.lang) ? usable(chapter.lang, chapter) : null;
		if (chapter.babel === main) chapter.babel = null;
	}
	setWarningLocation(was);
	// The main language last; no chapter's is the main one (nulled above).
	const names = [...new Set([...book.chapters.map((c) => c.babel).filter(Boolean), main])];
	book.babel = names.length === 1 && main === 'english' ? null : names.join(',');
	return book.babel;
}

/* --- a chapter's math macros ------------------------------------------------------------------------ */

/**
 * A chapter's `Math macros`, less any line the master's already holds: they
 * are defined at the chapter's start (chapterToken). LaTeX and MathJax each
 * keep one set of macros for the whole book, so a chapter that defines a name
 * differently from the master or an earlier chapter is warned — its
 * definition carries on into the chapters after it (§6). Called as each
 * chapter is read, before the next.
 */
function chapterMacros(chapter) {
	const master = (configManager.get('Math macros') || []).map((line) => String(line).trim());
	const earlier = [...master.map((line) => ({ line, by: null })),
		...book.chapters.flatMap((c) => c.macros.map((line) => ({ line, by: c })))];
	const own = settingLines(chapter.settings.mathMacros, '\n').filter((line) => !master.includes(line));
	const was = getWarningLocation();
	setWarningLocation({ file: chapter.name });
	for (const line of own) {
		const name = definedName(line);
		const other = name && [...earlier].reverse().find((e) => definedName(e.line) === name);
		if (other && other.line !== line) {
			addWarning(`book: this chapter's \`Math macros\` define ${name} differently from ${other.by ? `${other.by.name}'s` : "the master's"} — a book has one set of macros, so the chapters after this one get this chapter's`);
		}
	}
	setWarningLocation(was);
	return own;
}

// A macro line as LaTeX defines it mid-document: whether or not the name
// exists yet (a \newcommand of a defined name stops the build), so \provide
// then \renew. MathJax takes the lines as written, redefining as it goes.
function latexMacro(line) {
	const m = /^\\(newcommand|renewcommand|providecommand|DeclareMathOperator)(\*?)\s*\{?\s*(\\[A-Za-z@]+)\s*\}?([\s\S]*)$/.exec(line);
	if (!m) return line;
	const [, command, star, name, rest] = m;
	if (command === 'DeclareMathOperator') return `\\providecommand{${name}}{}\\renewcommand{${name}}{\\operatorname${star}${rest.trim()}}`;
	return `\\providecommand{${name}}{}\\renewcommand${star}{${name}}${rest}`;
}

/** Every chapter's own macro lines, for the LaTeX-export lint. */
export function bookMathMacros() {
	return (book?.chapters || []).flatMap((chapter) => chapter.macros || []);
}

/** Warn, each at its chapter, what bookPreamble left out. */
export function warnPreambleClashes() {
	const was = getWarningLocation();
	for (const { chapter, message } of bookPreamble().clashes) {
		setWarningLocation({ file: chapter.name });
		addWarning(message);
	}
	setWarningLocation(was);
}

/* --- rendering --------------------------------------------------------------------------- */

const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// One top-level block at a time, with its place set; in HTML each block's
// first tag carries its chapter line (data-source-line), which the post-pass
// reads to place its own warnings, and a host can use to jump to the source.
let renderChapter = null;

/** The chapter being rendered, or null (outside a chapter, or not a book). */
export function currentRenderChapter() { return renderChapter; }

function parseBook(tokens, options) {
	let out = '';
	for (const token of tokens) {
		if (token._jmdLoc) setWarningLocation(token._jmdLoc);
		else if (token.type === 'jmdChapter') {
			renderChapter = token.edge === 'start' ? token.chapter : null;
			setWarningLocation(renderChapter ? { file: renderChapter.name } : null);
		}
		let html = marked.Parser.parse([token], options);
		if (token._jmdLoc && !book.isLatex && !/^\s*<[a-zA-Z][^>]*\bdata-source-line=/.test(html)) {
			html = html.replace(/^(\s*<[a-zA-Z][a-zA-Z0-9-]*)/, `$1 data-source-line="${token._jmdLoc.line}"`);
		}
		out += html;
	}
	renderChapter = null;
	setWarningLocation(null);
	return out;
}


// A link to another chapter. In HTML an ordinary link to the chapter's anchor;
// in LaTeX \hyperref to its label — an \href to `#…` goes nowhere in a PDF.
const chapterLink = {
	name: 'jmdChapterLink',
	renderer(token) {
		const inner = this.parser.parseInline(token.tokens || []);
		if (global.isLatex) return `\\hyperref[jmd-chapter-${token.chapterIndex}]{${inner}}`;
		return `<a href="${escapeAttr(token.href)}">${inner}</a>`;
	},
};

const chapterToken = {
	name: 'jmdChapter',
	renderer(token) {
		const c = token.chapter;
		if (!c) return '';
		const macros = c.macros || [];
		if (global.isLatex) {
			// The chapter's language, for hyphenation: otherlanguage*, whose star
			// leaves headings ("Chapter 3") in the book's language.
			const babel = bookBabel();
			if (token.edge === 'end') return c.babel ? '\\end{otherlanguage*}\n' : '';
			if (babel) requirePackage('babel', babel);
			const language = c.babel ? `\\begin{otherlanguage*}{${c.babel}}\n` : '';
			// Its macros (MathJax's vocabulary, as the master's have), then an
			// anchor at its start for links to it (jmdChapterLink).
			if (macros.length) { requirePackage('amsmath'); requirePackage('amssymb'); }
			const defined = macros.map((line) => `${latexMacro(line)}\n`).join('');
			requirePackage('hyperref');
			return `${defined}\\phantomsection\\label{jmd-chapter-${c.index}}\n${language}`;
		}
		if (token.edge === 'end') return `${chapterNotesPlaceholder(c.index)}\n</section>\n`;
		// The chapter's macros, hidden, before any of its maths (as index.js
		// puts the master's at the top of the body).
		const defined = macros.length
			? `<div class="math-macros" style="display:none">\\(\n${macros.map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('\n')}\n\\)</div>\n`
			: '';
		// Its own language, where it differs from the book's (<html lang>).
		const lang = c.lang && !sameLanguage(c.lang, book.lang) ? ` lang="${escapeAttr(c.lang)}"` : '';
		return `<section class="jmd-chapter" id="jmd-chapter-${c.index}" data-chapter="${c.index}" data-file="${escapeAttr(c.name)}"${lang}>\n${defined}`;
	},
};

/**
 * Footnote ids made unique per chapter (HTML). Each chapter is lexed on its
 * own, so its notes number from 1, and marked-footnote's `footnote-1` and
 * `footnote-label`, or a labelled inline note's `fn-<label>`, would repeat
 * from chapter to chapter. A note listed in its chapter, and referred to only
 * from there, gains a `ch<N>-` prefix with its references, and whatever points
 * at them there follows: refs, backrefs, aria-describedby, an author's own
 * `#footnote-1` link. A note an `@endnotes` placement lists elsewhere keeps its
 * ids, which that list's backrefs name. Called last by the post-processor,
 * which finds marked-footnote's heading (`#footnote-label`) and a note's list
 * item (`li#footnote-…`, `li#fn-…`) by their ids.
 */
export function scopeChapterFootnotes($) {
	const REFS = 'a[data-footnote-ref], sup.footnote-ref > a';
	const NOTES = 'section.footnotes > ol > li[id]';
	const chapterOf = (el) => $(el).closest('section.jmd-chapter').get(0) || null;
	// The notes listed in each chapter (null: outside every chapter).
	const listed = new Map();
	$(NOTES).each((i, el) => {
		const c = chapterOf(el);
		if (!listed.has(c)) listed.set(c, new Set());
		listed.get(c).add($(el).attr('id'));
	});
	// A reference resolves to its own chapter's note; one whose note is listed
	// elsewhere reaches out, and that note keeps its ids.
	const reachedFromOutside = new Set();
	$(REFS).each((i, el) => {
		const to = ($(el).attr('href') || '').slice(1);
		if (!listed.get(chapterOf(el))?.has(to)) reachedFromOutside.add(to);
	});
	$('section.jmd-chapter').each((i, section) => {
		const $section = $(section);
		const prefix = `ch${$section.attr('data-chapter')}-`;
		const ids = new Map();
		const scope = (el) => {
			const id = $(el).attr('id');
			if (!id) return;
			ids.set(id, prefix + id);
			$(el).attr('id', prefix + id);
		};
		const own = [...(listed.get(section) || [])].filter((id) => !reachedFromOutside.has(id));
		if (!own.length) return;
		$section.find(NOTES).each((j, el) => { if (own.includes($(el).attr('id'))) scope(el); });
		$section.find(REFS).each((j, el) => { if (own.includes(($(el).attr('href') || '').slice(1))) scope(el); });
		$section.find('section[data-footnotes] > h2[id]').each((j, el) => scope(el));
		$section.find('a[href^="#"]').each((j, el) => {
			const to = ids.get($(el).attr('href').slice(1));
			if (to) $(el).attr('href', `#${to}`);
		});
		$section.find('[aria-describedby]').each((j, el) => {
			const refs = $(el).attr('aria-describedby').split(/\s+/);
			$(el).attr('aria-describedby', refs.map((id) => ids.get(id) || id).join(' '));
		});
	});
}

/* --- a chapter's <style> --------------------------------------------------------------------------- */

// At-rules that hold no style rules, or are global by nature: they cannot be
// nested in a scope, and stay outside it.
const GLOBAL_AT_RULES = /^@(?:import|charset|namespace|font-face|(?:-[a-z]+-)?keyframes|page|property|counter-style|font-feature-values|font-palette-values)\b/i;

/**
 * A chapter's CSS confined to its section with CSS nesting: `h1 { … }` becomes
 * `#jmd-chapter-2 { h1 { … } }`, and a rule for the page itself (`body`,
 * `html`, `:root`) becomes one for the section (`&`). Global at-rules
 * (@font-face, @keyframes, @import, …) cannot nest and are kept outside it.
 */
export function scopeCss(css, scope) {
	const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
	const outside = [];
	const inside = [];
	let i = 0;
	while (i < source.length) {
		while (i < source.length && /\s/.test(source[i])) i++;
		if (i >= source.length) break;
		// The statement's end: a `;` before any block, or its block's closing brace.
		let j = i;
		let depth = 0;
		let quote = null;
		for (; j < source.length; j++) {
			const c = source[j];
			if (quote) { if (c === '\\') j++; else if (c === quote) quote = null; continue; }
			if (c === '"' || c === "'") quote = c;
			else if (c === '{') depth++;
			else if (c === '}') { if (--depth <= 0) { j++; break; } }
			else if (c === ';' && depth === 0) { j++; break; }
		}
		const statement = source.slice(i, j).trim();
		i = j;
		if (!statement) continue;
		if (statement.startsWith('@')) {
			(GLOBAL_AT_RULES.test(statement) || !statement.includes('{') ? outside : inside).push(statement);
			continue;
		}
		const brace = statement.indexOf('{');
		const selectors = statement.slice(0, brace).split(',')
			.map((selector) => selector.trim().replace(/^(?:html|body|:root)(?![\w-])/i, '&'))
			.join(', ');
		inside.push(`${selectors} ${statement.slice(brace)}`);
	}
	if (inside.length) outside.push(`${scope} {\n${inside.join('\n')}\n}`);
	return `\n${outside.join('\n')}\n`;
}

/**
 * Each chapter's `<style>` elements, scoped to its section (HTML), so one
 * chapter's CSS does not restyle the book: the post-processor then hoists
 * them into the head with every other. Called before that hoisting.
 */
export function scopeChapterStyles($) {
	$('section.jmd-chapter').each((i, section) => {
		const scope = `#${$(section).attr('id')}`;
		$(section).find('style').not('svg style').each((j, style) => {
			$(style).text(scopeCss($(style).text(), scope));
			// Its chapter's, for a split book's pages (book-pages.js).
			$(style).attr('data-jmd-chapter', $(section).attr('data-chapter'));
		});
	});
}

/* --- the walk: chapter context and paths ---------------------------------------------------- */

let walkChapter = null;
const SCHEME = /^[a-z][a-z0-9+.-]*:|^\/|^#|^\?/i;

// A path the chapter wrote relative to its own folder, made relative to the
// master's; a path to another chapter's file becomes that chapter's anchor.
function rebase(href, chapter) {
	if (!href || SCHEME.test(href)) return href;
	const m = /^([^#?]*)(.*)$/.exec(href);
	const target = path.resolve(chapter.dir, m[1]);
	const other = book.chapters.find((c) => c.abs === target);
	if (other) return { href: m[2] && m[2].startsWith('#') ? m[2] : `#jmd-chapter-${other.index}`, chapter: other };
	const rel = path.relative(book.masterDir, target).split(path.sep).join('/');
	return (rel || '.') + m[2];
}

function bookWalk(token) {
	if (!book) return;
	if (token.type === 'jmdChapter') {
		walkChapter = token.edge === 'start' ? token.chapter : null;
		setWarningLocation(walkChapter ? { file: walkChapter.name } : null);
		return;
	}
	if (token._jmdLoc) setWarningLocation(token._jmdLoc);
	// An Obsidian [[link]] to a chapter is a chapter link (obsidian-links.js),
	// from the master's own text too.
	if (token.type === 'obsidianLink' && token.name) {
		const other = chapterNamed(token.name);
		if (other) {
			token.type = 'jmdChapterLink';
			token.href = `#jmd-chapter-${other.index}`;
			token.chapterIndex = other.index;
			return;
		}
	}
	if (!walkChapter) return;
	if ((token.type === 'link' || token.type === 'image' || token.type === 'obsidianEmbed') && token.href) {
		const to = rebase(token.href, walkChapter);
		if (typeof to === 'string') token.href = to;
		else if (token.type === 'link') {
			token.type = 'jmdChapterLink';
			token.href = to.href;
			token.chapterIndex = to.chapter.index;
		}
	}
	if ((token.type === 'atInline' || token.type === 'atBlock') && (token.name === 'image' || token.name === 'video') && token.arg) {
		const to = rebase(token.arg.trim(), walkChapter);
		if (typeof to === 'string') token.arg = to;
	}
}

/**
 * Place the warnings a post-pass raises about an element — an unresolved
 * @ref, a duplicate label, a citation key no bibliography holds — at its
 * chapter and line: the chapter's file, and the nearest block parseBook
 * stamped. An element outside every chapter, or null, places nothing; not a
 * book, nothing at all.
 */
export function placeWarningsAt($, el) {
	if (!book) return;
	const $section = el ? $(el).closest('section.jmd-chapter') : null;
	if (!$section || !$section.length) { setWarningLocation(null); return; }
	const chapter = book.chapters.find((c) => c.index === Number($section.attr('data-chapter')));
	const line = Number($(el).closest('[data-source-line]').attr('data-source-line')) || null;
	setWarningLocation({ file: chapter ? chapter.name : $section.attr('data-file'), line });
}

// The chapter an Obsidian link names, as Obsidian matches a note: its file's
// path or name, without `.md`, in any case.
function chapterNamed(name) {
	const bare = (p) => String(p).replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase();
	const wanted = bare(name);
	return book.chapters.find((c) => {
		const own = bare(c.name);
		return own === wanted || own.endsWith(`/${wanted}`) || bare(path.basename(c.name)) === wanted;
	}) || null;
}

/** The chapter a walkTokens hook is in, as it runs (smart typography's quotes). */
export function currentWalkChapter() { return walkChapter; }

/**
 * Registered by index.js AFTER the walkTokens hooks whose warnings it places
 * (marked runs the last-registered hook first, so the place is set before
 * theirs run). Every hook declines when the build is not a book.
 */
export const bookExtension = {
	extensions: [chapterToken, chapterLink],
	walkTokens: bookWalk,
	hooks: {
		provideLexer() {
			if (!book || !this.block) return false;
			return (src, options) => (MARKERS.test(src) ? lexBook(src, options) : marked.Lexer.lex(src, options));
		},
		provideParser() {
			if (!book || !this.block) return false;
			return (tokens, options) => (tokens.some((t) => t.type === 'jmdChapter')
				? parseBook(tokens, options)
				: marked.Parser.parse(tokens, options));
		},
	},
};

/** For a test or a host: where the current warning location is. */
export { getWarningLocation };
