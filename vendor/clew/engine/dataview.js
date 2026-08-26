// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// ```dataview — Obsidian's Dataview Query Language, for opening other people's
// vaults. Clew has its own ```query fence and is not replacing it; the point is
// that a vault arriving from Obsidian contains literal DQL, and rewriting
// someone's queries is not an option.
//
// WHAT IS SUPPORTED was decided by measuring four vaults (~480 notes), not by
// working down the reference page:
//
//   TABLE / TABLE WITHOUT ID / LIST / TASK, with AS aliases
//   FROM  "folder", #tag, [[link]], outgoing([[link]]), and/or, ! and - negation
//   WHERE, SORT (multi-key), GROUP BY, LIMIT
//   the file.* namespace, `this`, and the function table in dv-functions.js
//
// That subset covered 100% of the DQL in three real vaults (25/25 queries) and
// 43% of the vault that exists to TEACH Dataview — the difference being
// FLATTEN, `GROUP BY … rows`, file.day/file.lists and CALENDAR, which are
// syllabus rather than usage.
//
// What is NOT supported is REFUSED, by name, in the rendered note. A query
// that silently drops a FLATTEN would show numbers that are wrong, which is
// worse than showing nothing: see `unsupportedIn`.
import {
	display, evaluate, parseExpression, isDate, isDuration,
} from './dv-expr.js';
import { FUNCTIONS, KNOWN_FUNCTIONS, valueHtml } from './dv-functions.js';
import {
	scanPages, currentPage, pageValue, fileFields, linkKey, isLinkish, makeLink, isLink, resolvePath,
} from './vault-model.js';
import { jsEnabled, renderDataviewJs } from './dataview-js.js';

const NOTE_FILE = /\.(md|jmd)$/i;

const escapeHtml = (s) => String(s)
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- parsing the query ------------------------------------------------------

const KEYWORDS = ['TABLE', 'LIST', 'TASK', 'CALENDAR', 'FROM', 'WHERE',
	'SORT', 'GROUP BY', 'FLATTEN', 'LIMIT'];
const TYPES = new Set(['TABLE', 'LIST', 'TASK', 'CALENDAR']);

/**
 * Split a query into clauses.
 *
 * DQL does not care about line breaks — `LIST FROM "Inbox"` is one line and
 * four of bramses' queries are written that way — so this scans for keywords
 * rather than splitting on '\n'.
 *
 * The catch is that a clause keyword is only a keyword in the right place:
 * `WHERE limit > 5` is a comparison against a field called `limit`, not a LIMIT
 * clause. Dataview's own parser knows this because it is in expression state;
 * the cheap equivalent is that a MID-LINE keyword only splits while the current
 * clause is the query type or FROM, both of which take sources rather than
 * expressions. Everywhere else a clause must open its own line.
 */
export function splitClauses(source) {
	const text = source.replace(/\r/g, '');
	const marks = [];
	let depth = 0;
	let quote = null;
	let atLineStart = true;
	let currentKeyword = null;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '\n') { atLineStart = true; continue; }
		if (quote) { if (ch === quote && text[i - 1] !== '\\') quote = null; continue; }
		if (ch === '"' || ch === "'") { quote = ch; atLineStart = false; continue; }
		if (text.startsWith('[[', i)) { i++; atLineStart = false; continue; }
		if ('([{'.includes(ch)) { depth++; atLineStart = false; continue; }
		if (')]}'.includes(ch)) { depth--; atLineStart = false; continue; }
		if (/\s/.test(ch)) continue;

		const lineStart = atLineStart;
		atLineStart = false;
		if (depth > 0) continue;
		if (i > 0 && /[\w-]/.test(text[i - 1])) continue;   // must open a word

		const midLineAllowed = currentKeyword === null || TYPES.has(currentKeyword) || currentKeyword === 'FROM';
		if (!lineStart && !midLineAllowed) continue;

		for (const keyword of KEYWORDS) {
			const match = new RegExp(`^${keyword.replace(' ', '\\s+')}\\b`, 'i').exec(text.slice(i));
			if (!match) continue;
			marks.push({ at: i, length: match[0].length, keyword });
			currentKeyword = keyword;
			i += match[0].length - 1;
			break;
		}
	}

	if (!marks.length) {
		// A bare expression with no keyword at all is an implicit LIST.
		return text.trim() ? [{ keyword: 'LIST', body: text.trim() }] : [];
	}
	return marks.map((mark, n) => ({
		keyword: mark.keyword,
		body: text.slice(mark.at + mark.length, marks[n + 1]?.at ?? text.length).trim(),
	}));
}

/** Split on commas that are not inside brackets, parens or quotes. */
export function splitTopLevel(text, separator = ',') {
	const parts = [];
	let depth = 0;
	let quote = null;
	let buffer = '';
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			buffer += ch;
			if (ch === quote && text[i - 1] !== '\\') quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; buffer += ch; continue; }
		if ('([{'.includes(ch)) depth++;
		if (')]}'.includes(ch)) depth--;
		if (ch === separator && depth === 0) { parts.push(buffer); buffer = ''; continue; }
		buffer += ch;
	}
	if (buffer.trim()) parts.push(buffer);
	return parts.map((p) => p.trim()).filter(Boolean);
}

/** `expr AS "Name"` → {source, alias}. */
function parseColumn(text) {
	const match = /^([\s\S]+?)\s+AS\s+("([^"]*)"|'([^']*)'|[A-Za-z_][\w-]*)\s*$/i.exec(text);
	if (!match) return { source: text.trim(), alias: null };
	return { source: match[1].trim(), alias: match[3] ?? match[4] ?? match[2] };
}

export function parseQuery(source) {
	const query = {
		type: 'LIST', withoutId: false, columns: [], listExpr: null,
		from: null, where: [], sort: [], groupBy: null, limit: null,
	};
	for (const { keyword, body } of splitClauses(source)) {
		switch (keyword) {
			case 'TABLE': case 'LIST': case 'TASK': case 'CALENDAR': {
				query.type = keyword;
				let rest = body;
				if (keyword === 'TABLE' && /^WITHOUT\s+ID\b/i.test(rest)) {
					query.withoutId = true;
					rest = rest.replace(/^WITHOUT\s+ID\b/i, '').trim();
				}
				if (keyword === 'TABLE') {
					query.columns = splitTopLevel(rest).map(parseColumn);
				} else if (rest.trim()) {
					query.listExpr = parseColumn(rest).source;
				}
				break;
			}
			case 'FROM': query.from = body; break;
			case 'WHERE': if (body) query.where.push(body); break;
			case 'SORT':
				for (const part of splitTopLevel(body)) {
					const m = /^([\s\S]+?)(?:\s+(ASC|DESC|ASCENDING|DESCENDING))?\s*$/i.exec(part);
					query.sort.push({
						source: m[1].trim(),
						desc: /^desc/i.test(m[2] ?? ''),
					});
				}
				break;
			case 'GROUP BY': query.groupBy = parseColumn(body); break;
			case 'FLATTEN': query.flatten = body; break;
			case 'LIMIT': query.limit = Number(body.trim()) || null; break;
		}
	}
	return query;
}

// ---- FROM: a set expression over sources ------------------------------------

/**
 * `FROM "folder" or #tag and !"folder/sub"` → a predicate over pages.
 * Written as its own tiny parser because FROM is a language about SOURCES,
 * not about values — `#tag` is a set, not a comparison.
 */
export function parseSource(text) {
	if (!text || !text.trim()) return () => true;
	const tokens = text.match(/\[\[[^\]]*\]\]|"[^"]*"|'[^']*'|[()]|-(?=["#[])|!|\bAND\b|\bOR\b|[#@\w./\\-]+/gi) ?? [];
	let pos = 0;
	const peek = () => tokens[pos];
	const isOp = (word) => (peek() ?? '').toUpperCase() === word;

	const source = () => {
		let left = term();
		for (;;) {
			if (isOp('AND')) { pos++; const right = term(); const l = left; left = (p) => l(p) && right(p); continue; }
			if (isOp('OR')) { pos++; const right = term(); const l = left; left = (p) => l(p) || right(p); continue; }
			return left;
		}
	};
	const term = () => {
		if (peek() === '!' || peek() === '-') { pos++; const inner = term(); return (p) => !inner(p); }
		return atom();
	};
	const atom = () => {
		const token = tokens[pos++];
		if (token === undefined) return () => true;
		if (token === '(') { const inner = source(); if (peek() === ')') pos++; return inner; }
		if (token.startsWith('[[')) {
			// Pages that link TO this note.
			const target = resolvePath(token.slice(2, -2).split('|')[0].split('#')[0]);
			return (p) => p.outlinks.some((l) => linkKey(l) === linkKey(makeLink(target ?? '')));
		}
		if (token.startsWith('#')) {
			const tag = token.toLowerCase();
			return (p) => p.tags.some((t) => t.toLowerCase() === tag || t.toLowerCase().startsWith(tag + '/'));
		}
		const folder = token.replace(/^["']|["']$/g, '').replace(/\/$/, '');
		if (folder === '') return () => true;
		const lower = folder.toLowerCase();
		return (p) => {
			const path = p.path.toLowerCase();
			return path === lower || path === `${lower}.md` || path.startsWith(lower + '/');
		};
	};

	// `outgoing([[X]])` — pages X links to. Handled here because the tokenizer
	// above splits it into an identifier and a link.
	const outgoing = /outgoing\(\s*\[\[([^\]]*)\]\]\s*\)/i.exec(text);
	if (outgoing) {
		const from = resolvePath(outgoing[1].split('|')[0].split('#')[0]);
		const page = from ? scanPages().byPath.get(from) : null;
		const targets = new Set((page?.outlinks ?? []).map((l) => linkKey(l)));
		return (p) => targets.has(linkKey(makeLink(p.path)));
	}
	return source();
}

// ---- honest refusal ---------------------------------------------------------

const OUT_OF_SUBSET = [
	[/(^|\n)\s*FLATTEN\b/i, 'FLATTEN'],
	[/^\s*CALENDAR\b/i, 'CALENDAR queries'],
	[/\brows\b/i, 'GROUP BY … rows aggregation'],
	[/\bfile\.(lists|day|starred|frontmatter)\b/i, 'file.lists / file.day'],
	[/=>/, 'lambda functions'],
];

/** What in this query Clew does not implement — named, so the note can say so. */
export function unsupportedIn(source, query) {
	const found = [];
	for (const [pattern, label] of OUT_OF_SUBSET) if (pattern.test(source)) found.push(label);
	const KEYWORDS = new Set(['table', 'list', 'task', 'from', 'where', 'sort', 'group',
		'by', 'flatten', 'limit', 'as', 'without', 'id', 'and', 'or', 'not', 'asc', 'desc', 'outgoing']);
	for (const [, name] of source.matchAll(/\b([a-z][a-zA-Z0-9_]*)\s*\(/g)) {
		if (KEYWORDS.has(name.toLowerCase())) continue;
		if (!KNOWN_FUNCTIONS.has(name.toLowerCase())) found.push(`the function ${name}()`);
	}
	if (query?.type === 'CALENDAR') found.push('CALENDAR queries');
	return [...new Set(found)];
}

// ---- running ----------------------------------------------------------------

function contextFor(page, self, extra = {}) {
	return {
		functions: FUNCTIONS,
		linkKey,
		isLinkish,
		makeLink,
		resolve(name) {
			if (name === 'this') return self ? { file: fileFields(self), ...self.fields } : undefined;
			if (name === 'file') return fileFields(page);
			if (name === 'note') return page.fields;
			if (name in extra) return extra[name];
			return pageValue(page, name);
		},
	};
}

const cache = new Map();
const compile = (source) => {
	if (!cache.has(source)) cache.set(source, parseExpression(source));
	return cache.get(source);
};

/** Filter, sort and limit pages for a parsed query. Pure given the page list. */
export function runQuery(query, pages, self) {
	const inSource = parseSource(query.from);
	let rows = pages.filter((page) => {
		if (!inSource(page)) return false;
		for (const clause of query.where) {
			const value = evaluate(compile(clause), contextFor(page, self));
			if (!truthyRow(value)) return false;
		}
		return true;
	});

	for (const key of [...query.sort].reverse()) {
		const tree = compile(key.source);
		rows = rows.map((page, i) => ({ page, i })).sort((x, y) => {
			const a = sortKey(evaluate(tree, contextFor(x.page, self)));
			const b = sortKey(evaluate(tree, contextFor(y.page, self)));
			if (a === b) return x.i - y.i;                       // stable
			if (a === null) return 1;
			if (b === null) return -1;
			const order = a < b ? -1 : 1;
			return key.desc ? -order : order;
		}).map((entry) => entry.page);
	}
	if (!query.sort.length) rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
	if (query.limit) rows = rows.slice(0, query.limit);
	return rows;
}

const truthyRow = (v) => !(v === undefined || v === null || v === false || v === '' || (Array.isArray(v) && v.length === 0));

function sortKey(value) {
	if (value === undefined || value === null) return null;
	if (isDate(value)) return value.getTime();
	if (isDuration(value)) return value.ms;
	if (typeof value === 'number' || typeof value === 'boolean') return Number(value);
	if (isLink(value)) return String(value.display ?? value.path).toLowerCase();
	return String(display(value)).toLowerCase();
}

// ---- rendering ---------------------------------------------------------------

const internalLink = (target, text) =>
	`<a class="internal-link" href="#" data-href="${escapeHtml(String(target).replace(NOTE_FILE, ''))}">${escapeHtml(text)}</a>`;

export const cellHtml = valueHtml;

const notice = (title, lines) =>
	`<div class="clew-query is-unsupported"><div class="clew-query-title">${escapeHtml(title)}</div>`
	+ lines.map((l) => `<div class="clew-query-note">${l}</div>`).join('') + '</div>\n';

/**
 * A cell is editable when its column is a BARE FIELD NAME that the note really
 * stores — Clew's writable-database behaviour, extended to Dataview's tables.
 * An expression column is not editable, because there is nowhere to write to.
 */
function editableAttrs(page, columnSource) {
	if (!/^[A-Za-z][\w -]*$/.test(columnSource)) return '';
	const source = page.sources?.[columnSource];
	if (!source) return '';
	return ` class="clew-q-cell" data-edit-path="${escapeHtml(page.path)}"`
		+ ` data-edit-field="${escapeHtml(columnSource)}" data-edit-source="${escapeHtml(source)}"`;
}

function renderTable(query, rows, self) {
	const headers = [
		...(query.withoutId ? [] : ['File']),
		...query.columns.map((c) => c.alias ?? c.source),
	];
	const body = rows.map((page) => {
		const cells = query.columns.map((column) => {
			const value = evaluate(compile(column.source), contextFor(page, self));
			return `<td${editableAttrs(page, column.source)}>${cellHtml(value)}</td>`;
		});
		const id = query.withoutId ? '' : `<td>${internalLink(page.path, page.name)}</td>`;
		return `<tr>${id}${cells.join('')}</tr>`;
	}).join('\n');
	return `<table class="clew-query clew-dataview"><thead><tr>`
		+ headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')
		+ `</tr></thead><tbody>${body}</tbody></table>`;
}

function renderList(query, rows, self) {
	const items = rows.map((page) => {
		if (!query.listExpr) return `<li>${internalLink(page.path, page.name)}</li>`;
		const value = evaluate(compile(query.listExpr), contextFor(page, self));
		return `<li>${internalLink(page.path, page.name)}: ${cellHtml(value)}</li>`;
	});
	return `<ul class="clew-query clew-dataview">\n${items.join('\n')}\n</ul>`;
}

function renderTasks(query, rows, self) {
	const parts = ['<div class="clew-tasks clew-dataview">'];
	let shown = 0;
	for (const page of rows) {
		const tasks = page.tasks.filter((task) => {
			for (const clause of query.where) {
				const value = evaluate(compile(clause), taskContext(page, task, self));
				if (!truthyRow(value)) return false;
			}
			return true;
		});
		if (!tasks.length) continue;
		parts.push(`<div class="clew-tasks-note">${internalLink(page.path, page.name)}</div>`);
		parts.push('<ul class="clew-tasks-list">');
		for (const task of tasks) {
			if (query.limit && shown >= query.limit) break;
			shown++;
			// Same write-back contract as ```tasks: the preview client routes a
			// click by data-task-path/-line back to the source note.
			parts.push(`<li data-task-path="${escapeHtml(page.path)}" data-task-line="${task.line}">`
				+ `<input type="checkbox" disabled${task.done ? ' checked' : ''}> ${escapeHtml(task.text)}</li>`);
		}
		parts.push('</ul>');
	}
	parts.push('</div>');
	return shown ? parts.join('\n') : '';
}

function taskContext(page, task, self) {
	const base = contextFor(page, self);
	return {
		...base,
		resolve(name) {
			if (name === 'text') return task.text;
			if (name === 'completed' || name === 'checked') return task.done;
			if (name === 'line') return task.line;
			return base.resolve(name);
		},
	};
}

/** Render a DQL query to HTML. Exported whole so tests can drive it. */
export function renderQuery(source) {
	const query = parseQuery(source);
	const refusals = unsupportedIn(source, query);
	if (refusals.length) {
		return notice('This Dataview query uses features Clew does not implement', [
			escapeHtml(refusals.join(', ')) + '.',
			'The rest of the query is not guessed at, because a partial answer '
			+ 'would look like a complete one.',
		]);
	}

	// Dataview indexes Markdown only; the model also carries attachments,
	// because Bases queries those on purpose.
	const pages = scanPages().pages.filter((p) => p.isNote);
	const self = currentPage();
	const rows = runQuery(query, pages.filter((p) => p !== self || query.from), self);

	const render = (subset) => {
		if (query.type === 'TABLE') return renderTable(query, subset, self);
		if (query.type === 'TASK') return renderTasks(query, subset, self);
		return renderList(query, subset, self);
	};

	if (query.groupBy) {
		const tree = compile(query.groupBy.source);
		const groups = new Map();
		for (const page of rows) {
			const key = display(evaluate(tree, contextFor(page, self))) || '—';
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(page);
		}
		if (!groups.size) return `<div class="clew-query is-empty">No results.</div>\n`;
		return [...groups.keys()].sort().map((key) =>
			`<div class="clew-query-group">${escapeHtml(key)}</div>` + render(groups.get(key))).join('\n') + '\n';
	}

	const html = render(rows);
	if (!rows.length || !html) return `<div class="clew-query is-empty">No results.</div>\n`;
	return html + '\n';
}

// ---- the fences --------------------------------------------------------------

export const dataviewFence = {
	name: 'dataviewFence',
	level: 'block',
	start(src) { return src.match(/^```dataview\b/m)?.index; },
	tokenizer(src) {
		const match = /^```dataview[ \t]*\n([\s\S]*?)\n```[ \t]*(?:\n+|$)/.exec(src);
		if (!match) return;
		return { type: 'dataviewFence', raw: match[0], text: match[1] };
	},
	renderer(token) {
		if (global.isLatex) return '';
		return renderQuery(token.text);
	},
};

/**
 * ```dataviewjs is refused rather than shimmed.
 *
 * It is arbitrary JavaScript with `dv.app` — the whole application object — in
 * scope, so a partial implementation is not a smaller version of the feature,
 * it is a different one with the same name. Measuring said the same thing from
 * the other direction: 130 occurrences in the vault that teaches Dataview, and
 * zero across three real vaults. Clew's own programmable tier (jmarkdown
 * script blocks with the `vault` global) is what the message points at.
 */
export const dataviewJsFence = {
	name: 'dataviewJsFence',
	level: 'block',
	start(src) { return src.match(/^```dataviewjs\b/m)?.index; },
	tokenizer(src) {
		const match = /^```dataviewjs[ \t]*\n([\s\S]*?)\n```[ \t]*(?:\n+|$)/.exec(src);
		if (!match) return;
		return { type: 'dataviewJsFence', raw: match[0], text: match[1] };
	},
	renderer(token) {
		if (global.isLatex) return '';
		if (jsEnabled()) return renderDataviewJs(token.text);
		return notice('dataviewjs is not run in this vault', [
			'These blocks are JavaScript, so unlike a query there is no way to '
			+ 'tell in advance what one will do. Clew can run them — turn on '
			+ '<strong>Run dataviewjs blocks</strong> in this vault\'s settings — '
			+ 'but not by default in a vault you have just opened.',
			'Clew\'s own equivalent is a jmarkdown script block using the '
			+ '<code>vault</code> global; see the manual.',
		]) + `<pre class="clew-query-source"><code>${escapeHtml(token.text)}</code></pre>\n`;
	},
};

/**
 * Inline queries: `= this.file.name`. The rule requires the `=` to open the
 * code span, so an ordinary span like `` `= 5` `` in prose about arithmetic is
 * the only false positive, and Obsidian has exactly the same one.
 *
 * `$=` (inline JavaScript) is deliberately left alone: it renders as the code
 * span it is, which is honest, rather than being claimed and refused.
 */
export const dataviewInline = {
	name: 'dataviewInline',
	level: 'inline',
	start(src) { return src.match(/`=\s/)?.index; },
	tokenizer(src) {
		const match = /^`=\s+([^`\n]+)`/.exec(src);
		if (!match) return;
		return { type: 'dataviewInline', raw: match[0], expr: match[1].trim() };
	},
	renderer(token) {
		const self = currentPage();
		if (!self) return escapeHtml(token.expr);
		const value = evaluate(compile(token.expr), contextFor(self, self));
		if (global.isLatex) return display(value);
		return `<span class="clew-inline-query">${cellHtml(value)}</span>`;
	},
};

export default [dataviewFence, dataviewJsFence, dataviewInline];
