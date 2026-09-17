// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The expression language under both `​```dataview` and `.base` files: a lexer,
// a Pratt parser, and a tree-walking evaluator over a closed grammar.
//
// NOT `eval`, and not a sandbox around `eval` either. Queries arrive from
// other people's vaults, they run in the render worker with the vault's own
// filesystem access, and the whole point of translating a declarative query
// language is that it CANNOT do anything but select and format data. A parser
// is the only version of that promise which is actually true.
//
// The two dialects differ in surface only. Dataview writes `contains(a, b)`;
// Bases writes `a.contains(b)`. A method call desugars to a function call with
// the receiver as its first argument, so one function table serves both, and
// `file.name.contains("x")` and `contains(file.name, "x")` are the same tree.
//
// Values: JS primitives, arrays, Date, link objects (vault-model.js), and
// durations `{__dur, ms}`. Anything a query asks for that does not exist is
// `undefined`, never a throw — a broken clause hides a row, it does not blow
// up somebody's note.

// ---- lexer -----------------------------------------------------------------

const PUNCT = ['>=', '<=', '!=', '<>', '=>', '==', '&&', '||', '(', ')', '[', ']', ',',
	'.', '+', '-', '*', '/', '%', '>', '<', '=', '!'];
const WORD_OPS = new Set(['and', 'or', 'not']);

export function tokenize(src) {
	const tokens = [];
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		if (/\s/.test(ch)) { i++; continue; }

		// [[wikilink]] — a link literal, before the '[' list bracket.
		if (src.startsWith('[[', i)) {
			const end = src.indexOf(']]', i + 2);
			if (end !== -1) {
				tokens.push({ type: 'link', value: src.slice(i + 2, end) });
				i = end + 2;
				continue;
			}
		}
		if (ch === '"' || ch === "'") {
			let out = '';
			i++;
			while (i < src.length && src[i] !== ch) {
				if (src[i] === '\\' && (src[i + 1] === ch || src[i + 1] === '\\')) { out += src[i + 1]; i += 2; continue; }
				// Every other backslash is literal: `regexmatch("\w+", x)` must
				// reach the regex engine with its \w intact.
				out += src[i++];
			}
			i++;
			tokens.push({ type: 'string', value: out });
			continue;
		}
		if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
			const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i));
			tokens.push({ type: 'number', value: Number(m[0]) });
			i += m[0].length;
			continue;
		}
		if (/[A-Za-z_$]/.test(ch)) {
			const m = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(src.slice(i));
			const word = m[0];
			tokens.push(WORD_OPS.has(word.toLowerCase())
				? { type: 'punct', value: word.toLowerCase() === 'not' ? '!' : word.toLowerCase() }
				: { type: 'ident', value: word });
			i += m[0].length;
			continue;
		}
		const punct = PUNCT.find((p) => src.startsWith(p, i));
		if (punct) { tokens.push({ type: 'punct', value: punct }); i += punct.length; continue; }
		i++;   // an unknown character is skipped rather than fatal
	}
	tokens.push({ type: 'end', value: null });
	return tokens;
}

// ---- parser ----------------------------------------------------------------

const BINARY = [
	['or', '||'],
	['and', '&&'],
	['=', '==', '!=', '<>', '>=', '<=', '>', '<'],
	['+', '-'],
	['*', '/', '%'],
];

// `dur(84 days)` and `date(2024-01-01)` take bare word arguments that are not
// expressions. Their argument list is captured as raw text instead of parsed.
const RAW_ARG_FUNCTIONS = new Set(['dur', 'duration']);

class Parser {
	constructor(tokens, src) { this.tokens = tokens; this.src = src; this.pos = 0; }
	peek(n = 0) { return this.tokens[this.pos + n] ?? { type: 'end', value: null }; }
	next() { return this.tokens[this.pos++] ?? { type: 'end', value: null }; }
	eat(value) {
		if (this.peek().type === 'punct' && this.peek().value === value) { this.pos++; return true; }
		return false;
	}

	parse() {
		const node = this.expression(0);
		return node;
	}

	expression(level) {
		if (level >= BINARY.length) return this.unary();
		let left = this.expression(level + 1);
		for (;;) {
			const token = this.peek();
			if (token.type !== 'punct' || !BINARY[level].includes(token.value)) return left;
			this.pos++;
			const right = this.expression(level + 1);
			left = { kind: 'binary', op: token.value, left, right };
		}
	}

	unary() {
		const token = this.peek();
		if (token.type === 'punct' && (token.value === '!' || token.value === '-')) {
			this.pos++;
			return { kind: 'unary', op: token.value, operand: this.unary() };
		}
		return this.postfix(this.primary());
	}

	postfix(node) {
		for (;;) {
			if (this.eat('.')) {
				const name = this.next();
				if (name.type !== 'ident') return node;
				// `a.foo(...)` is `foo(a, ...)` — the whole reason one parser
				// covers both dialects.
				if (this.peek().type === 'punct' && this.peek().value === '(') {
					this.pos++;
					const args = this.arguments(name.value);
					node = { kind: 'call', name: name.value, args: [node, ...args] };
				} else {
					node = { kind: 'field', object: node, name: name.value };
				}
				continue;
			}
			if (this.eat('[')) {
				const index = this.expression(0);
				this.eat(']');
				node = { kind: 'index', object: node, index };
				continue;
			}
			return node;
		}
	}

	/** Argument list, assuming '(' is consumed. */
	arguments(fnName) {
		if (RAW_ARG_FUNCTIONS.has(fnName.toLowerCase())) {
			// Re-read the raw source between the parens: the tokens inside are
			// `84` and `days`, which is not an expression in any grammar.
			const start = this.pos;
			let depth = 1;
			const parts = [];
			while (this.peek().type !== 'end') {
				const token = this.next();
				if (token.type === 'punct' && token.value === '(') depth++;
				if (token.type === 'punct' && token.value === ')') { depth--; if (depth === 0) break; }
				parts.push(token);
			}
			void start;
			// `dur("84 days")` — a real string argument.
			if (parts.length === 1 && parts[0].type === 'string') {
				return [{ kind: 'literal', value: parts[0].value }];
			}
			// `dur(estimate)` — a field holding a duration.
			if (parts.length === 1 && parts[0].type === 'ident') {
				return [{ kind: 'ident', name: parts[0].value }];
			}
			// `dur(84 days)` — two tokens that are not an expression in any
			// grammar. Rejoining them is the whole point of the raw-argument
			// path; trying to parse them leaves the parser stranded mid-call.
			return [{ kind: 'literal', value: parts.map((p) => p.value).join(' ') }];
		}
		const args = [];
		if (this.eat(')')) return args;
		do { args.push(this.expression(0)); } while (this.eat(','));
		this.eat(')');
		return args;
	}

	primary() {
		const token = this.next();
		if (token.type === 'number' || token.type === 'string') {
			return { kind: 'literal', value: token.value };
		}
		if (token.type === 'link') {
			const [target, display] = token.value.split('|');
			return { kind: 'linkLiteral', target: target.trim(), display: display?.trim() ?? null };
		}
		if (token.type === 'ident') {
			if (this.peek().type === 'punct' && this.peek().value === '(') {
				this.pos++;
				return { kind: 'call', name: token.value, args: this.arguments(token.value) };
			}
			const lower = token.value.toLowerCase();
			if (lower === 'true') return { kind: 'literal', value: true };
			if (lower === 'false') return { kind: 'literal', value: false };
			if (lower === 'null') return { kind: 'literal', value: null };
			return { kind: 'ident', name: token.value };
		}
		if (token.type === 'punct') {
			if (token.value === '(') {
				// `(x) => expr` — a lambda, distinguished from a parenthesized
				// expression by lookahead: identifiers, ')', then '=>'.
				const lambda = this.lambda();
				if (lambda) return lambda;
				const inner = this.expression(0); this.eat(')'); return inner;
			}
			if (token.value === '[') {
				const items = [];
				if (!this.eat(']')) {
					do { items.push(this.expression(0)); } while (this.eat(','));
					this.eat(']');
				}
				return { kind: 'list', items };
			}
		}
		return { kind: 'literal', value: undefined };
	}

	/** Called with '(' consumed. Parses `ident, …) => body` or backtracks. */
	lambda() {
		const start = this.pos;
		const params = [];
		while (this.peek().type === 'ident') {
			params.push(this.next().value);
			if (!this.eat(',')) break;
		}
		if (this.eat(')') && this.eat('=>')) {
			return { kind: 'lambda', params, body: this.expression(0) };
		}
		this.pos = start;
		return null;
	}
}

/** Parse an expression to a tree. Never throws — a malformed tail is dropped. */
export function parseExpression(src) {
	try {
		return new Parser(tokenize(src), src).parse();
	} catch {
		return { kind: 'literal', value: undefined };
	}
}

// ---- values ----------------------------------------------------------------

export const makeDuration = (ms) => ({ __dur: true, ms });
export const isDuration = (v) => v !== null && typeof v === 'object' && v.__dur === true;
export const isDate = (v) => v instanceof Date && !Number.isNaN(v.getTime());

const DURATION_UNITS = {
	s: 1e3, sec: 1e3, secs: 1e3, second: 1e3, seconds: 1e3,
	m: 6e4, min: 6e4, mins: 6e4, minute: 6e4, minutes: 6e4,
	h: 36e5, hr: 36e5, hrs: 36e5, hour: 36e5, hours: 36e5,
	d: 864e5, day: 864e5, days: 864e5,
	w: 6048e5, week: 6048e5, weeks: 6048e5,
	mo: 2592e6, month: 2592e6, months: 2592e6,     // 30 days, as Dataview does
	y: 31536e6, yr: 31536e6, year: 31536e6, years: 31536e6,
};

/** '84 days', '2 weeks 3 days', '60d' → a duration; null if unreadable. */
export function parseDuration(text) {
	const src = String(text).trim().toLowerCase();
	if (!src) return null;
	let ms = 0;
	let matched = false;
	for (const [, n, unit] of src.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/g)) {
		const factor = DURATION_UNITS[unit];
		if (factor === undefined) continue;
		ms += Number(n) * factor;
		matched = true;
	}
	return matched ? makeDuration(ms) : null;
}

/** Anything date-shaped → a Date; null otherwise. */
export function coerceDate(value) {
	if (isDate(value)) return value;
	if (typeof value === 'number') return new Date(value);
	if (typeof value !== 'string') return null;
	const text = value.trim();
	const keyword = temporalKeyword(text.toLowerCase());
	if (keyword) return keyword;
	// A DATE-ONLY string is local midnight, not UTC midnight. `new Date(...)`
	// reads 'YYYY-MM-DD' as UTC, so west of Greenwich every such date silently
	// became the day before — the kind of bug that only shows up in someone
	// else's timezone. Anything carrying a time is left to the native parser.
	const dateOnly = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(text);
	if (dateOnly) {
		return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3] ?? 1));
	}
	if (!/^\d{4}-\d{2}-\d{2}[T ]/.test(text)) return null;
	const date = new Date(text);
	return Number.isNaN(date.getTime()) ? null : date;
}

function temporalKeyword(word) {
	const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
	if (word === 'today') return midnight();
	if (word === 'now') return new Date();
	if (word === 'tomorrow') { const d = midnight(); d.setDate(d.getDate() + 1); return d; }
	if (word === 'yesterday') { const d = midnight(); d.setDate(d.getDate() - 1); return d; }
	return null;
}

export const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** Comparison key: dates and durations compare numerically, text case-insensitively. */
function comparable(value) {
	if (isDate(value)) return value.getTime();
	if (isDuration(value)) return value.ms;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'number') return value;
	if (value === null || value === undefined) return null;
	if (typeof value === 'object') return null;
	return String(value).toLowerCase();
}

/** `a === b` across the value types, links included. */
export function valuesEqual(a, b, linkKey, isLinkish) {
	// Link identity applies only when a side really is a link: linkKey() will
	// reduce any string, and two ordinary strings must compare as strings.
	if (!isLinkish || isLinkish(a) || isLinkish(b)) {
		const ka = linkKey?.(a);
		const kb = linkKey?.(b);
		if (ka !== null && ka !== undefined && kb !== null && kb !== undefined) return ka === kb;
	}
	const ca = comparable(a);
	const cb = comparable(b);
	// A missing field is `undefined` (vault-model.js#pageValue), the literal
	// is `null`, and Dataview treats them as one value: `WHERE x != null`
	// must drop a note that has no x at all, and `WHERE x = null` must find
	// it — as typeof() already says 'null' for both. Objects (links, arrays)
	// still compare by identity here.
	if (ca === null || cb === null) return (a ?? null) === (b ?? null);
	// A date compared against a plain 'YYYY-MM-DD' should match.
	if (isDate(a) !== isDate(b)) {
		const da = coerceDate(a);
		const db = coerceDate(b);
		if (da && db) return da.getTime() === db.getTime();
	}
	return ca === cb;
}

export function truthy(value) {
	if (value === undefined || value === null || value === false) return false;
	if (value === '' || value === 0) return false;
	if (Array.isArray(value)) return value.length > 0;
	return true;
}

// ---- evaluator --------------------------------------------------------------

/**
 * Evaluate a parsed tree.
 *
 * `ctx` supplies `resolve(name)` for bare identifiers, the `functions` table,
 * and an optional `linkKey` so link-valued comparisons know their own
 * identity rules. Errors inside a clause yield `undefined`.
 */
export function evaluate(node, ctx) {
	try { return run(node, ctx); } catch { return undefined; }
}

function run(node, ctx) {
	switch (node.kind) {
		case 'literal': return node.value;
		case 'list': return node.items.map((item) => run(item, ctx));
		case 'linkLiteral': return ctx.makeLink
			? ctx.makeLink(node.target, node.display) : node.target;
		case 'ident': {
			const temporal = temporalKeyword(node.name.toLowerCase());
			const resolved = ctx.resolve(node.name);
			// A field named `today` in someone's frontmatter wins over the keyword.
			return resolved !== undefined ? resolved : temporal ?? undefined;
		}
		// A lambda evaluates to a closure over its defining context; only
		// callFunction (below) can apply it, so it stays inert data everywhere
		// else — a lambda in a cell renders as nothing, not as code.
		case 'lambda': return { __lambda: true, params: node.params, body: node.body, ctx };
		case 'field': {
			const object = run(node.object, ctx);
			if (object === undefined || object === null) return undefined;
			if (Array.isArray(object)) {
				// Dataview spreads field access over a list.
				const mapped = object.map((item) => item?.[node.name]).filter((v) => v !== undefined);
				return mapped.length ? mapped : undefined;
			}
			return object[node.name];
		}
		case 'index': {
			const object = run(node.object, ctx);
			const index = run(node.index, ctx);
			if (object === undefined || object === null) return undefined;
			if (Array.isArray(object)) return object[Number(index)];
			return object[index];
		}
		case 'unary': {
			const value = run(node.operand, ctx);
			if (node.op === '!') return !truthy(value);
			const n = Number(value);
			return Number.isNaN(n) ? undefined : -n;
		}
		case 'call': {
			const fn = ctx.functions?.[node.name.toLowerCase()];
			if (!fn) return undefined;
			return fn(node.args.map((arg) => run(arg, ctx)), ctx);
		}
		case 'binary': return binary(node, ctx);
		default: return undefined;
	}
}

/**
 * Apply a lambda value — `filter(list, (x) => …)` reaches here. Parameters
 * shadow the defining context's names; everything else resolves as it did
 * where the lambda was written. Not a lambda → undefined, never a throw.
 */
export function callFunction(fn, args, outerCtx) {
	if (typeof fn === 'function') return fn(args, outerCtx);
	if (!fn || fn.__lambda !== true) return undefined;
	const ctx = fn.ctx;
	const scope = {};
	fn.params.forEach((p, i) => { scope[p] = args[i]; });
	return evaluate(fn.body, {
		...ctx,
		resolve: (name) => (name in scope ? scope[name] : ctx.resolve(name)),
	});
}

function binary(node, ctx) {
	const op = node.op;
	if (op === 'and' || op === '&&') return truthy(run(node.left, ctx)) && truthy(run(node.right, ctx));
	if (op === 'or' || op === '||') return truthy(run(node.left, ctx)) || truthy(run(node.right, ctx));

	const a = run(node.left, ctx);
	const b = run(node.right, ctx);

	if (op === '=' || op === '==') return valuesEqual(a, b, ctx.linkKey, ctx.isLinkish);
	if (op === '!=' || op === '<>') return !valuesEqual(a, b, ctx.linkKey, ctx.isLinkish);

	if (op === '+' || op === '-') {
		const arith = dateArithmetic(op, a, b);
		if (arith !== undefined) return arith;
	}
	if (op === '+') {
		if (typeof a === 'string' || typeof b === 'string') {
			if (a === undefined || b === undefined) return undefined;
			return String(display(a)) + String(display(b));
		}
		if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
	}

	const na = Number(isDuration(a) ? a.ms : a);
	const nb = Number(isDuration(b) ? b.ms : b);
	if (['<', '>', '<=', '>='].includes(op)) {
		const ca = comparable(a);
		const cb = comparable(b);
		if (ca === null || cb === null) return false;
		if (typeof ca !== typeof cb) return false;
		switch (op) {
			case '<': return ca < cb;
			case '>': return ca > cb;
			case '<=': return ca <= cb;
			case '>=': return ca >= cb;
		}
	}
	if (Number.isNaN(na) || Number.isNaN(nb)) return undefined;
	switch (op) {
		case '+': return na + nb;
		case '-': return na - nb;
		case '*': return na * nb;
		case '/': return nb === 0 ? undefined : na / nb;
		case '%': return nb === 0 ? undefined : na % nb;
		default: return undefined;
	}
}

/** date ± duration → date; date − date → duration. `now() - "60d"` needs this. */
function dateArithmetic(op, a, b) {
	const da = isDate(a) ? a : null;
	const db = isDate(b) ? b : null;
	const ra = isDuration(a) ? a : typeof a === 'string' ? parseDuration(a) : null;
	const rb = isDuration(b) ? b : typeof b === 'string' ? parseDuration(b) : null;

	if (da && rb) return new Date(da.getTime() + (op === '-' ? -rb.ms : rb.ms));
	if (da && db && op === '-') return makeDuration(da.getTime() - db.getTime());
	if (ra && rb) return makeDuration(op === '-' ? ra.ms - rb.ms : ra.ms + rb.ms);
	if (ra && db && op === '+') return new Date(db.getTime() + ra.ms);
	return undefined;
}

/** A value as it should read in a cell (not HTML — the renderers escape). */
export function display(value) {
	if (value === undefined || value === null) return '';
	// Local components, for the same reason coerceDate builds them locally:
	// toISOString() would shift a local-midnight date back a day west of UTC.
	if (isDate(value)) {
		return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`
			+ `-${String(value.getDate()).padStart(2, '0')}`;
	}
	if (isDuration(value)) return formatDuration(value);
	if (Array.isArray(value)) return value.map(display).join(', ');
	if (typeof value === 'object' && value.__link) return value.display ?? String(value.path).replace(/\.(md|jmd)$/i, '');
	return String(value);
}

export function formatDuration(duration) {
	let ms = Math.abs(duration.ms);
	const parts = [];
	for (const [unit, factor] of [['year', 31536e6], ['month', 2592e6], ['day', 864e5], ['hour', 36e5], ['minute', 6e4]]) {
		const n = Math.floor(ms / factor);
		if (n > 0) { parts.push(`${n} ${unit}${n === 1 ? '' : 's'}`); ms -= n * factor; }
		if (parts.length === 2) break;
	}
	if (!parts.length) return '0 minutes';
	return (duration.ms < 0 ? '-' : '') + parts.join(', ');
}
