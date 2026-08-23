/*
	Back-of-book index — `@index[entry]` marks + `@index` placement.

	The architecture is the standard JMarkdown split: LaTeX emits native
	commands and lets the engine do the work; HTML resolves everything itself
	in the post-processor.

	  - `@index[entry]` / `@index[entry]{name=authors}` — an invisible mark.
	    The bracket content is passed to LaTeX *verbatim* as `\index{entry}`
	    (`\index[authors]{entry}` for a named index), so the FULL makeindex
	    grammar is supported by construction:

	        recursion                    plain entry
	        recursion!tail calls         subentry ('!' nests, 3 levels in makeindex)
	        alpha@$\alpha$               sort key @ display form
	        Turing|see{computability}    cross-reference (also |seealso{…})
	        induction|(  …  induction|)  locator range
	        proof|textbf                 emphasised locator
	        Ah"!                         makeindex's "-escape for literal !,@,|,"

	    The mark is claimed RAW by a dedicated inline tokenizer (the same
	    pattern as the \cite tokenizer in citations.js), so $math$, \commands,
	    and the grammar characters survive marked untouched.

	  - `@index` / `@index{name=authors title="Author Index" intoc}` — where
	    an index prints. A dedicated block extension (the @bibliography
	    pattern: the directive framework needs trailing content, so a bare
	    marker would not tokenize). The mark and the placement share the name
	    `@index` and are told apart by the bracket: `@index[…]` marks, bare
	    `@index` at a line start places. LaTeX: requires imakeidx (which must
	    precede hyperref — requirePackage's insertion order guarantees that,
	    hyperref being forced last), registers `\makeindex[…]` in the preamble
	    and emits `\printindex[…]`; the author's latexmk run drives makeindex
	    itself. HTML: emits a placeholder div that buildIndexes() replaces.

	HTML semantics mirror makeindex: entries letter-grouped (Symbols first),
	sorted case-insensitively by sort key, subentries nested. The "page
	number" is the enclosing section number ("§2.3", linked to the exact mark)
	when `Headings: numeric` is on, falling back to per-entry occurrence
	ordinals otherwise. Duplicate locators collapse like repeated page
	numbers; |textbf / |textit style the locator; see/seealso render as
	italic cross-references, hyperlinked to their target entry when it exists.

	Build warnings (warnings.js): marks with no matching @index placement
	(checked after the parse, both formats — call checkIndexPlacements() from
	processFile), a see/seealso target that doesn't exist, an unbalanced
	range, and entries deeper than makeindex's 3-level limit.
*/

import attributesParser from 'attributes-parser';
import { requirePackage, addPreamble } from './preamble.js';
import { addWarning } from './warnings.js';

function escapeAttr(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// Escape only what breaks HTML text nodes; $…$ is left intact so MathJax can
// typeset math in index entries (e.g. alpha@$\alpha$) on the web too.
function escapeText(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

// ---------------------------------------------------------------------------
// Per-run state: which index names carry marks / have a placement. Reset from
// processFile (like resetWarnings); checked after the parse pass.
// ---------------------------------------------------------------------------
let markCounts = new Map();      // index name ('' = default) -> mark count
let placedNames = new Set();     // index names with an @index placement

export function resetIndexing() {
	markCounts = new Map();
	placedNames = new Set();
}

// Marks whose index never prints are silently lost in BOTH outputs (LaTeX's
// \index without \makeindex is a no-op by design), so say so. Call once,
// after marked.parse().
export function checkIndexPlacements() {
	for (const [name, count] of markCounts) {
		if (placedNames.has(name)) continue;
		const where = name ? `@index{name=${name}}` : '@index';
		const which = name ? ` for index '${name}'` : '';
		addWarning(`${count} index mark${count === 1 ? '' : 's'}${which} but no ${where} placement — the index will not appear`);
	}
}

// ---------------------------------------------------------------------------
// Inline extension: @index[entry]{attrs}  (legacy alias :index[…])
// ---------------------------------------------------------------------------

// The modern `@index[…]` spelling and the legacy `:index[…]` one. Longest-first
// is irrelevant here (neither is a prefix of the other), but keep them in one
// place so start() and tokenizer() can never disagree about what they accept.
const MARK_PREFIXES = ['@index[', ':index['];

export const indexMark = {
	name: 'indexMark',
	level: 'inline',
	start(src) {
		let best = -1;
		for (const p of MARK_PREFIXES) {
			const i = src.indexOf(p);
			if (i >= 0 && (best < 0 || i < best)) best = i;
		}
		return best < 0 ? undefined : best;
	},
	tokenizer(src) {
		// NOTE: indexMark deliberately does NOT apply atInline's "an @ glued to a
		// word char is never a directive" rule. A mark is attached to the word it
		// indexes — `recursion@index[recursion]` — so gluing is the primary idiom
		// here, exactly as it was for `:index[…]`. The rule exists to protect
		// email addresses from the GENERIC `@name` tokenizer; the risk does not
		// carry over, because this tokenizer only ever claims the literal 7-char
		// prefix `@index[` (and marked claims code spans before text is cut, so
		// documentation examples are safe).
		const prefix = MARK_PREFIXES.find(p => src.startsWith(p));
		if (!prefix) return undefined;
		// Balanced-bracket scan so display forms like [$f[x]$] survive; an
		// entry is single-line (a newline before the close means this isn't
		// a mark, so the text is left for other tokenizers).
		const open = prefix.length;
		let depth = 1;
		let i = open;
		for (; i < src.length; i++) {
			const c = src[i];
			if (c === '\n') return undefined;
			if (c === '[') depth++;
			else if (c === ']') { depth--; if (depth === 0) break; }
		}
		if (depth !== 0) return undefined;
		const entry = src.slice(open, i);
		let raw = src.slice(0, i + 1);

		// Optional {attrs} — only `name` is meaningful (the imakeidx index).
		let indexName = '';
		const after = src.slice(i + 1);
		const am = /^\{([^}\n]*)\}/.exec(after);
		if (am) {
			raw += am[0];
			try {
				const attrs = attributesParser(am[1]) || {};
				if (attrs.name != null) indexName = String(attrs.name).trim();
			} catch { /* malformed attrs: treat as no attrs */ }
		}
		return { type: 'indexMark', raw, entry, indexName };
	},
	renderer(token) {
		markCounts.set(token.indexName, (markCounts.get(token.indexName) || 0) + 1);
		if (global.isLatex) {
			const name = token.indexName ? `[${token.indexName}]` : '';
			return `\\index${name}{${token.entry}}`;
		}
		// Invisible anchor; buildIndexes assigns ids and collects these in
		// document order during the post-pass.
		const name = token.indexName ? ` data-index-name="${escapeAttr(token.indexName)}"` : '';
		return `<span class="index-mark" data-entry="${escapeAttr(token.entry)}"${name}></span>`;
	}
};

// ---------------------------------------------------------------------------
// Block extension: @index{name=… title="…" intoc}  (legacy alias ::Index)
// ---------------------------------------------------------------------------

function parseIndexAttrs(raw) {
	const result = { indexName: '', title: '', intoc: false };
	if (!raw) return result;
	const inside = raw.trim().replace(/^\{/, '').replace(/\}$/, '');
	let attrs = {};
	try {
		attrs = attributesParser(inside) || {};
	} catch {
		attrs = {};
	}
	if (attrs.name != null) result.indexName = String(attrs.name).trim();
	if (attrs.title != null) result.title = String(attrs.title).trim();
	if ('intoc' in attrs) {
		const v = String(attrs.intoc).trim().toLowerCase();
		result.intoc = v === '' || v === 'true' || v === 'intoc';
	}
	return result;
}

export const indexPlacement = {
	name: 'indexPlacement',
	level: 'block',
	// `@index` and `@index[…]` differ only by the bracket, so the placement must
	// refuse the bracket form or it would swallow an index MARK that happens to
	// begin a line. The tokenizer already can't match one (`[` satisfies neither
	// the optional `{attrs}` nor the line end), so the (?!\[) in start() is what
	// keeps the two in step — a block start() that reports a position its own
	// tokenizer can't claim shreds the paragraph (see CLAUDE.md).
	start(src) {
		const m = src.match(/(?:^|\n)(?:@index\b(?!\[)|::Index\b)/);
		return m ? (m.index + (m[0].startsWith('\n') ? 1 : 0)) : undefined;
	},
	tokenizer(src) {
		const match = /^(?:@index|::Index)[ \t]*(\{[^}\n]*\})?[ \t]*(?:\n|$)/.exec(src);
		if (!match) return undefined;
		return { type: 'indexPlacement', raw: match[0], ...parseIndexAttrs(match[1]) };
	},
	renderer(token) {
		placedNames.add(token.indexName);
		if (global.isLatex) {
			requirePackage('imakeidx');
			const opts = [];
			if (token.indexName) opts.push(`name=${token.indexName}`);
			if (token.title) opts.push(`title={${token.title}}`);
			if (token.intoc) opts.push('intoc');
			addPreamble(opts.length ? `\\makeindex[${opts.join(', ')}]` : '\\makeindex');
			return `\\printindex${token.indexName ? `[${token.indexName}]` : ''}\n\n`;
		}
		const name = token.indexName ? ` data-index-name="${escapeAttr(token.indexName)}"` : '';
		const title = token.title ? ` data-title="${escapeAttr(token.title)}"` : '';
		return `<div class="jmd-index"${name}${title}></div>\n`;
	}
};

// ---------------------------------------------------------------------------
// The makeindex entry grammar, shared semantics for the HTML side.
// ---------------------------------------------------------------------------

// Split on an unescaped separator; makeindex's `"` quotes the NEXT character.
function splitUnescaped(s, sep) {
	const parts = [];
	let cur = '';
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === '"' && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
		if (c === sep) { parts.push(cur); cur = ''; continue; }
		cur += c;
	}
	parts.push(cur);
	return parts;
}

// Remove the "-escapes, yielding the literal text.
function unquote(s) {
	return s.replace(/"(.)/g, '$1');
}

// Parse one raw entry into levels + encap.
//   levels: [{ key, sort, display }]  (key = raw level text, the merge identity)
//   encap:  rangeOpen / rangeClose / see / seealso / format
function parseEntry(raw) {
	const pipe = splitUnescaped(raw, '|');
	const body = pipe[0];
	let encap = pipe.length > 1 ? pipe.slice(1).join('|') : '';

	let rangeOpen = false, rangeClose = false, see = null, seealso = null, format = '';
	if (encap.startsWith('(')) { rangeOpen = true; encap = encap.slice(1); }
	else if (encap.startsWith(')')) { rangeClose = true; encap = encap.slice(1); }
	const seeMatch = /^(see|seealso)\{(.*)\}$/.exec(encap);
	if (seeMatch) {
		if (seeMatch[1] === 'see') see = seeMatch[2];
		else seealso = seeMatch[2];
	} else if (encap) {
		format = encap;        // e.g. textbf, textit — applied to the locator
	}

	const levels = splitUnescaped(body, '!').map(levelRaw => {
		const at = splitUnescaped(levelRaw, '@');
		const sortRaw = at[0];
		const displayRaw = at.length > 1 ? at.slice(1).join('@') : sortRaw;
		return {
			key: levelRaw.trim(),
			sort: unquote(sortRaw).trim(),
			display: unquote(displayRaw).trim()
		};
	});
	if (levels.length > 3) {
		addWarning(`index entry '${raw}' has ${levels.length} levels — makeindex supports at most 3, so the LaTeX index will reject it`);
	}
	return { levels, rangeOpen, rangeClose, see, seealso, format };
}

// ---------------------------------------------------------------------------
// HTML post-pass: collect the marks, build each placed index, replace the
// placeholders. Called from postProcessHTML AFTER heading numbering, so the
// section-number locators can be read off the header-label spans.
// ---------------------------------------------------------------------------

function slugify(s) {
	return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// One node per distinct entry path. Identity is the raw level text, so
// `alpha@$\alpha$` and `alpha` are distinct entries — same as makeindex.
function makeNode(level) {
	return { sort: level.sort, display: level.display, locators: [], sees: [], seealsos: [], openRanges: [], children: new Map() };
}

export function buildIndexes($) {
	const placeholders = $('div.jmd-index');

	// Marks in document order, each tagged with the current section number
	// (the text of the nearest preceding numbered heading's label span).
	const marksByIndex = new Map();   // index name -> [{entry, anchor, section}]
	let section = '';
	let counter = 0;
	$('h1,h2,h3,h4,h5,h6,span.index-mark').each((i, el) => {
		const $el = $(el);
		if (el.tagName === 'span') {
			counter++;
			const anchor = `idx-${counter}`;
			$el.attr('id', anchor);
			const name = $el.attr('data-index-name') || '';
			if (!marksByIndex.has(name)) marksByIndex.set(name, []);
			marksByIndex.get(name).push({ entry: $el.attr('data-entry') || '', anchor, section });
		} else {
			const label = $el.find('span.header-label').first().text().trim();
			if (label) section = label.replace(/\.$/, '');
		}
	});

	if (placeholders.length === 0) return;

	placeholders.each((i, el) => {
		const $ph = $(el);
		const name = $ph.attr('data-index-name') || '';
		const title = $ph.attr('data-title') || 'Index';
		const marks = marksByIndex.get(name) || [];
		$ph.replaceWith(renderIndex(name, title, marks));
	});
}

// Build the entry tree for one index from its marks, then render it.
function renderIndex(name, title, marks) {
	const roots = new Map();   // level-1 key -> node

	for (const mark of marks) {
		const parsed = parseEntry(mark.entry);
		// Walk / create the path.
		let map = roots;
		let node = null;
		for (const level of parsed.levels) {
			if (!map.has(level.key)) map.set(level.key, makeNode(level));
			node = map.get(level.key);
			map = node.children;
		}
		if (!node) continue;   // empty entry (':index[]') — nothing to record

		if (parsed.see != null) { node.sees.push(parsed.see); continue; }
		if (parsed.seealso != null) { node.seealsos.push(parsed.seealso); continue; }

		if (parsed.rangeOpen) {
			node.openRanges.push({ from: mark, format: parsed.format });
			continue;
		}
		if (parsed.rangeClose) {
			const open = node.openRanges.shift();
			if (!open) {
				addWarning(`index range close '${mark.entry}' has no matching '|(' open — treating it as a plain locator`);
				node.locators.push({ from: mark, to: null, format: parsed.format });
			} else {
				node.locators.push({ from: open.from, to: mark, format: open.format || parsed.format });
			}
			continue;
		}
		node.locators.push({ from: mark, to: null, format: parsed.format });
	}

	// Any range never closed → warn, degrade to a plain locator.
	const flushOpenRanges = (node, path) => {
		for (const open of node.openRanges) {
			addWarning(`index range '${path}|(' was never closed with '${path}|)' — treating it as a plain locator`);
			node.locators.push({ from: open.from, to: null, format: open.format });
		}
		node.openRanges = [];
		for (const child of node.children.values()) flushOpenRanges(child, `${path}!${child.display}`);
	};
	for (const node of roots.values()) flushOpenRanges(node, node.display);

	// Locator text: section number when available ("§2.3"), else the
	// occurrence ordinal within this entry — the HTML stand-in for a page
	// number. Duplicates (same entry, same section, same format) collapse,
	// like makeindex collapses repeated page numbers.
	const renderLocators = (node) => {
		const out = [];
		const seen = new Set();
		let ordinal = 0;
		for (const loc of node.locators) {
			ordinal++;
			const a = (mark) => mark.section ? `§${mark.section}` : String(ordinal);
			let text = loc.to ? `${a(loc.from)}–${a(loc.to)}` : a(loc.from);
			const dedup = `${text}|${loc.format}`;
			if (seen.has(dedup)) continue;
			seen.add(dedup);
			let link = `<a href="#${loc.from.anchor}">${escapeText(text)}</a>`;
			if (loc.format === 'textbf' || loc.format === 'bfseries') link = `<strong>${link}</strong>`;
			else if (loc.format === 'textit' || loc.format === 'emph' || loc.format === 'itshape') link = `<em>${link}</em>`;
			out.push(link);
		}
		return out;
	};

	// A see/seealso target is written the way makeindex prints it — the
	// DISPLAY form ("$\alpha$-conversion", "recursion!tail calls") — but we
	// also accept the full sort@display key. Each !-level is matched against
	// the node's raw key, display, or sort, case-insensitively.
	const entryId = (path) => `index-entry-${name ? slugify(name) + '-' : ''}${path.map(p => slugify(p.display)).join('--')}`;
	const parseSeeTarget = (target) => splitUnescaped(target, '!').map(part => {
		const at = splitUnescaped(part, '@');
		return {
			key: part.trim(),
			sort: unquote(at[0]).trim(),
			display: unquote(at.length > 1 ? at.slice(1).join('@') : at[0]).trim()
		};
	});
	const resolveSee = (wanted) => {
		let map = roots;
		const path = [];
		for (const part of wanted) {
			let found = null;
			for (const node of map.values()) {
				if (node.key === part.key
					|| node.display.toLowerCase() === part.display.toLowerCase()
					|| node.sort.toLowerCase() === part.sort.toLowerCase()) { found = node; break; }
			}
			if (!found) return null;
			path.push(found);
			map = found.children;
		}
		return entryId(path);
	};

	const renderSees = (node, path) => {
		const parts = [];
		const one = (target, word) => {
			const wanted = parseSeeTarget(target);
			const id = resolveSee(wanted);
			if (!id) addWarning(`index cross-reference '${path}|${word === 'see' ? 'see' : 'seealso'}{${target}}' points at an entry that doesn't exist`);
			const text = escapeText(wanted.map(p => p.display).join(', '));
			return `<span class="index-see"><em>${word}</em> ${id ? `<a href="#${id}">${text}</a>` : text}</span>`;
		};
		for (const t of node.sees) parts.push(one(t, 'see'));
		for (const t of node.seealsos) parts.push(one(t, 'see also'));
		return parts;
	};

	// Sorted children of a map: case-insensitive by sort key.
	const sorted = (map) => [...map.values()].sort((a, b) =>
		a.sort.toLowerCase().localeCompare(b.sort.toLowerCase(), 'en'));

	const renderNode = (node, path) => {
		const fullPath = path.concat([node]);
		const pieces = [...renderLocators(node), ...renderSees(node, fullPath.map(p => p.display).join('!'))];
		const tail = pieces.length ? `<span class="index-locators">, ${pieces.join(', ')}</span>` : '';
		let html = `<li id="${entryId(fullPath)}"><span class="index-entry-text">${escapeText(node.display)}</span>${tail}`;
		if (node.children.size) {
			html += `\n<ul class="index-subentries">\n${sorted(node.children).map(c => renderNode(c, fullPath)).join('\n')}\n</ul>`;
		}
		return html + '</li>';
	};

	// Letter groups over the top level: Symbols first, then A–Z.
	const groups = new Map();
	for (const node of sorted(roots)) {
		const first = node.sort.charAt(0);
		const letter = /[a-z]/i.test(first) ? first.toUpperCase() : 'Symbols';
		if (!groups.has(letter)) groups.set(letter, []);
		groups.get(letter).push(node);
	}
	const order = [...groups.keys()].sort((a, b) => {
		if (a === 'Symbols') return -1;
		if (b === 'Symbols') return 1;
		return a.localeCompare(b);
	});

	const body = order.map(letter => {
		const items = groups.get(letter).map(n => renderNode(n, [])).join('\n');
		return `<div class="index-group">\n<p class="index-group-letter">${letter}</p>\n<ul class="index-entries">\n${items}\n</ul>\n</div>`;
	}).join('\n');

	const id = name ? `index-${slugify(name)}` : 'index';
	return `<nav class="index" aria-label="${escapeAttr(title)}">\n<h2 class="index-title" id="${id}">${escapeText(title)}</h2>\n${body}\n</nav>`;
}
