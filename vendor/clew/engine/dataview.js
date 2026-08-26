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
// WHAT IS SUPPORTED was decided by measuring five vaults, not by working down
// the reference page:
//
//   TABLE / TABLE WITHOUT ID / LIST / TASK, with AS aliases
//   FROM  "folder", #tag, [[link]], outgoing([[link]]), and/or, ! and - negation
//   WHERE, SORT (multi-key), GROUP BY (real semantics: `key` and `rows`),
//   FLATTEN (incl. the `FLATTEN list(expr) AS name` LET idiom), LIMIT —
//   applied as a PIPELINE in written order, the way Dataview applies them
//   lambdas `(x) => …`, and the function table in dv-functions.js
//   the file.* namespace and `this`
//
// FLATTEN earned its place when a fifth measured vault used it in real
// queries (always alongside lambdas and filter(), which is why those came
// with it); before that, all 92 occurrences were in the vault that exists to
// TEACH Dataview.
//
// What is NOT supported is REFUSED, by name, in the rendered note. A query
// that silently dropped a clause would show numbers that are wrong, which is
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
		from: null, where: [], sort: [], groupBy: null, flatten: [], limit: null,
		// Dataview applies data commands IN WRITTEN ORDER — `WHERE … FLATTEN …
		// GROUP BY … FLATTEN rows …` is a pipeline, and a FLATTEN before a
		// WHERE means the WHERE sees the flattened rows. `steps` keeps that
		// order; the flat fields above stay for the renderers and refusals.
		steps: [],
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
			case 'WHERE':
				if (body) { query.where.push(body); query.steps.push({ kind: 'where', source: body }); }
				break;
			case 'SORT': {
				const keys = [];
				for (const part of splitTopLevel(body)) {
					const m = /^([\s\S]+?)(?:\s+(ASC|DESC|ASCENDING|DESCENDING))?\s*$/i.exec(part);
					keys.push({ source: m[1].trim(), desc: /^desc/i.test(m[2] ?? '') });
				}
				query.sort.push(...keys);
				query.steps.push({ kind: 'sort', keys });
				break;
			}
			case 'GROUP BY':
				query.groupBy = parseColumn(body);
				query.steps.push({ kind: 'group', column: query.groupBy });
				break;
			case 'FLATTEN': {
				const column = parseColumn(body);
				query.flatten.push(column);
				query.steps.push({ kind: 'flatten', column });
				break;
			}
			case 'LIMIT':
				query.limit = Number(body.trim()) || null;
				query.steps.push({ kind: 'limit', n: query.limit });
				break;
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
	[/^\s*CALENDAR\b/i, 'CALENDAR queries'],
	[/\bfile\.(lists|day|starred|frontmatter)\b/i, 'file.lists / file.day'],
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
	// TASK rows are tasks, not pages; expanding them with FLATTEN has its own
	// semantics Clew has not implemented, so it is refused rather than guessed.
	if (query?.type === 'TASK' && query.flatten?.length) found.push('FLATTEN in TASK queries');
	return [...new Set(found)];
}

// ---- running ----------------------------------------------------------------

// Dataview's list() CONSTRUCTS a list from its arguments — `list(x)` where x
// is already a list gives a one-element list holding it, which is precisely
// what makes `FLATTEN list(expr) AS name` the idiom for a per-row LET. Bases'
// list() NORMALIZES (list-or-scalar → list) instead, and kepano's filters
// depend on that; the two dialects genuinely differ here, so the shared
// function table keeps the Bases meaning and DQL contexts override it.
const dataviewList = (args) => args;
const DQL_FUNCTIONS = { ...FUNCTIONS, list: dataviewList, array: dataviewList };

function contextFor(page, self, extra = {}) {
	return {
		functions: DQL_FUNCTIONS,
		linkKey,
		isLinkish,
		makeLink,
		resolve(name) {
			if (name === 'this') return self ? { file: fileFields(self), ...self.fields } : undefined;
			if (name in extra) return extra[name];
			if (!page) return undefined;
			if (name === 'file') return fileFields(page);
			if (name === 'note') return page.fields;
			return pageValue(page, name);
		},
	};
}

// ---- the row pipeline --------------------------------------------------------
// A row is { page, extra }: the page (null once GROUP BY has replaced pages
// with groups) plus every binding a FLATTEN or GROUP BY introduced. `extra`
// resolves BEFORE the page's own fields so `FLATTEN x AS x` shadows the list
// with the element, exactly as Dataview's own binding order does.

const rowContext = (row, self) => contextFor(row.page, self, row.extra);

/** A row as a VALUE — what `rows` holds after GROUP BY, so `rows.file.name`
 *  and `rows.<binding>` both spread the way Dataview's do. */
function rowValue(row) {
	return row.page
		? { file: fileFields(row.page), ...row.page.fields, ...row.extra }
		: { ...row.extra };
}

const cache = new Map();
const compile = (source) => {
	if (!cache.has(source)) cache.set(source, parseExpression(source));
	return cache.get(source);
};

/**
 * Run a query's data commands, in written order, over { page, extra } rows.
 * Pure given the page list. TASK queries skip GROUP BY here — their grouping
 * is display grouping over tasks, handled by the renderer as before.
 */
export function runQuery(query, pages, self) {
	const inSource = parseSource(query.from);
	let rows = pages.filter(inSource).map((page) => ({ page, extra: {} }));
	// No SORT clause → name order, applied up front so a LIMIT slices the
	// alphabetically-first rows, exactly as it did before the pipeline.
	if (!query.sort.length) rows = [...rows].sort((a, b) => a.page.name.localeCompare(b.page.name));
	const steps = query.type === 'TASK'
		? query.steps.filter((s) => s.kind !== 'group') : query.steps;

	for (const step of steps) {
		if (step.kind === 'where') {
			const tree = compile(step.source);
			rows = rows.filter((row) => truthyRow(evaluate(tree, rowContext(row, self))));
		} else if (step.kind === 'flatten') {
			// `FLATTEN expr AS name`: one row per element of a list value, the
			// element bound to the name; a non-list value binds as-is (with
			// `list(expr)` wrapping, that is Dataview's LET); an empty list
			// drops the row, as Dataview does.
			const tree = compile(step.column.source);
			const name = step.column.alias
				?? (/^[A-Za-z_][\w-]*$/.test(step.column.source) ? step.column.source : null);
			const next = [];
			for (const row of rows) {
				const value = evaluate(tree, rowContext(row, self));
				for (const item of Array.isArray(value) ? value : [value]) {
					next.push({ page: row.page, extra: name ? { ...row.extra, [name]: item } : row.extra });
				}
			}
			rows = next;
		} else if (step.kind === 'group') {
			// Real GROUP BY: one row per group, exposing `key` and `rows` —
			// which is what makes `rows.file.name` and `FLATTEN rows AS R` work.
			const tree = compile(step.column.source);
			const groups = new Map();
			for (const row of rows) {
				const key = evaluate(tree, rowContext(row, self));
				const id = display(key) || '—';
				if (!groups.has(id)) groups.set(id, { key, members: [] });
				groups.get(id).members.push(row);
			}
			rows = [...groups.entries()]
				.sort((a, b) => a[0].localeCompare(b[0]))
				.map(([, group]) => ({
					page: null,
					extra: {
						key: group.key,
						...(step.column.alias ? { [step.column.alias]: group.key } : {}),
						rows: group.members.map(rowValue),
					},
				}));
		} else if (step.kind === 'sort') {
			for (const key of [...step.keys].reverse()) {
				const tree = compile(key.source);
				rows = rows.map((row, i) => ({ row, i })).sort((x, y) => {
					const a = sortKey(evaluate(tree, rowContext(x.row, self)));
					const b = sortKey(evaluate(tree, rowContext(y.row, self)));
					if (a === b) return x.i - y.i;                   // stable
					if (a === null) return 1;
					if (b === null) return -1;
					const order = a < b ? -1 : 1;
					return key.desc ? -order : order;
				}).map((entry) => entry.row);
			}
		} else if (step.kind === 'limit' && step.n) {
			rows = rows.slice(0, step.n);
		}
	}
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

/** A row's identity cell: the page link, or (after GROUP BY) the group key. */
const rowIdHtml = (row) => (row.page
	? internalLink(row.page.path, row.page.name)
	: cellHtml(row.extra.key));

function renderTable(query, rows, self) {
	const grouped = rows.some((row) => !row.page);
	const headers = [
		...(query.withoutId ? [] : [grouped ? 'Group' : 'File']),
		...query.columns.map((c) => c.alias ?? c.source),
	];
	const body = rows.map((row) => {
		const cells = query.columns.map((column) => {
			const value = evaluate(compile(column.source), rowContext(row, self));
			const editable = row.page ? editableAttrs(row.page, column.source) : '';
			return `<td${editable}>${cellHtml(value)}</td>`;
		});
		const id = query.withoutId ? '' : `<td>${rowIdHtml(row)}</td>`;
		return `<tr>${id}${cells.join('')}</tr>`;
	}).join('\n');
	return `<table class="clew-query clew-dataview"><thead><tr>`
		+ headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')
		+ `</tr></thead><tbody>${body}</tbody></table>`;
}

function renderList(query, rows, self) {
	const items = rows.map((row) => {
		if (!query.listExpr) return `<li>${rowIdHtml(row)}</li>`;
		const value = evaluate(compile(query.listExpr), rowContext(row, self));
		return `<li>${rowIdHtml(row)}: ${cellHtml(value)}</li>`;
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

	// TASK grouping is DISPLAY grouping over the matching pages' tasks (the
	// pipeline skipped its group step); TABLE and LIST get real GROUP BY
	// semantics from the pipeline — one row per group.
	if (query.type === 'TASK') {
		const taskPages = rows.map((row) => row.page);
		if (query.groupBy) {
			const tree = compile(query.groupBy.source);
			const groups = new Map();
			for (const page of taskPages) {
				const key = display(evaluate(tree, contextFor(page, self))) || '—';
				if (!groups.has(key)) groups.set(key, []);
				groups.get(key).push(page);
			}
			if (!groups.size) return `<div class="clew-query is-empty">No results.</div>\n`;
			return [...groups.keys()].sort().map((key) =>
				`<div class="clew-query-group">${escapeHtml(key)}</div>`
				+ renderTasks(query, groups.get(key), self)).join('\n') + '\n';
		}
		const html = renderTasks(query, taskPages, self);
		if (!html) return `<div class="clew-query is-empty">No results.</div>\n`;
		return html + '\n';
	}

	const html = query.type === 'TABLE'
		? renderTable(query, rows, self) : renderList(query, rows, self);
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
