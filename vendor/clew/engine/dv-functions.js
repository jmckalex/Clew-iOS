// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The function table for the query dialects. Which functions exist here was
// decided by MEASUREMENT, not by copying a reference page: every function real
// vaults were found to use, plus the obvious neighbours of each. Dataview
// documents around sixty; the ones that actually appear in ordinary vaults are
// `contains`, `date`, `dur`, `link`, `elink`, `choice` and `regexmatch`.
//
// Anything absent evaluates to `undefined` rather than throwing, so an
// unsupported function narrows a query instead of breaking a note.
import {
	asArray, coerceDate, display, formatDuration, isDate, isDuration,
	makeDuration, parseDuration, truthy, valuesEqual,
} from './dv-expr.js';
import { linkKey, makeLink, isLink, isLinkish } from './vault-model.js';

/** An external link value — rendered as an <a href> by the table renderers. */
export const makeExternalLink = (url, text) => ({ __extlink: true, url, display: text ?? url });
export const isExternalLink = (v) => v !== null && typeof v === 'object' && v.__extlink === true;

const str = (v) => (v === undefined || v === null ? '' : display(v));
const num = (v) => {
	if (typeof v === 'number') return v;
	if (isDuration(v)) return v.ms;
	if (isDate(v)) return v.getTime();
	const n = Number(String(v).replace(/,/g, ''));
	return Number.isNaN(n) ? undefined : n;
};
const eq = (a, b) => valuesEqual(a, b, linkKey, isLinkish);

/** Dataview's `contains`: substring for text, membership for lists, key for objects. */
function containsValue(haystack, needle, fold = false) {
	if (haystack === undefined || haystack === null) return false;
	if (Array.isArray(haystack)) return haystack.some((item) => containsValue(item, needle, fold));
	// A link on EITHER side makes this a link lookup — `list(loc).contains(this)`
	// has a frontmatter string `[[Japan]]` on one side and a page on the other.
	if (isLinkish(haystack) || isLinkish(needle)) {
		const a = linkKey(haystack);
		const b = linkKey(needle);
		if (a !== null && b !== null) return a === b;
	}
	if (typeof haystack === 'object') return Object.keys(haystack).some((k) => (fold ? k.toLowerCase() : k) === (fold ? str(needle).toLowerCase() : str(needle)));
	const a = fold ? str(haystack).toLowerCase() : str(haystack);
	const b = fold ? str(needle).toLowerCase() : str(needle);
	return b === '' ? false : a.includes(b);
}

const safeRegex = (pattern, flags) => {
	try { return new RegExp(pattern, flags); } catch { return null; }
};

const pad2 = (n) => String(n).padStart(2, '0');

/** A small strftime-ish subset of Luxon's tokens — what date formats use. */
export function formatDate(date, pattern) {
	if (!isDate(date)) return '';
	const map = {
		yyyy: date.getFullYear(), yy: pad2(date.getFullYear() % 100),
		MMMM: date.toLocaleString('en', { month: 'long' }),
		MMM: date.toLocaleString('en', { month: 'short' }),
		MM: pad2(date.getMonth() + 1), M: date.getMonth() + 1,
		dd: pad2(date.getDate()), d: date.getDate(),
		EEEE: date.toLocaleString('en', { weekday: 'long' }),
		EEE: date.toLocaleString('en', { weekday: 'short' }),
		HH: pad2(date.getHours()), H: date.getHours(),
		mm: pad2(date.getMinutes()), ss: pad2(date.getSeconds()),
	};
	return String(pattern).replace(/yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|HH|H|mm|ss/g, (t) => String(map[t]));
}

export const FUNCTIONS = {
	// -- membership and text --------------------------------------------------
	contains: ([a, b]) => containsValue(a, b, false),
	icontains: ([a, b]) => containsValue(a, b, true),
	econtains: ([a, b]) => asArray(a).some((item) => eq(item, b)),
	containsword: ([a, b]) => new RegExp(`\\b${String(b).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(str(a)),
	containsany: ([a, ...rest]) => rest.flat().some((needle) => containsValue(a, needle, false)),
	containsall: ([a, ...rest]) => rest.flat().every((needle) => containsValue(a, needle, false)),
	isempty: ([a]) => a === undefined || a === null || a === '' || (Array.isArray(a) && a.length === 0),
	isnotempty: ([a]) => !(a === undefined || a === null || a === '' || (Array.isArray(a) && a.length === 0)),
	startswith: ([a, b]) => str(a).startsWith(str(b)),
	endswith: ([a, b]) => str(a).endsWith(str(b)),
	lower: ([a]) => str(a).toLowerCase(),
	upper: ([a]) => str(a).toUpperCase(),
	split: ([a, sep, limit]) => {
		const parts = str(a).split(sep === undefined ? /\s+/ : new RegExp(String(sep)));
		return limit === undefined ? parts : parts.slice(0, Number(limit));
	},
	join: ([a, sep]) => asArray(a).map(str).join(sep === undefined ? ', ' : str(sep)),
	replace: ([a, from, to]) => str(a).split(str(from)).join(str(to)),
	substring: ([a, from, to]) => str(a).slice(Number(from) || 0, to === undefined ? undefined : Number(to)),
	truncate: ([a, n, suffix]) => {
		const text = str(a);
		const limit = Number(n) || 0;
		return text.length <= limit ? text : text.slice(0, Math.max(0, limit - 3)) + (suffix === undefined ? '...' : str(suffix));
	},
	padleft: ([a, n, ch]) => str(a).padStart(Number(n) || 0, ch === undefined ? ' ' : str(ch)),
	padright: ([a, n, ch]) => str(a).padEnd(Number(n) || 0, ch === undefined ? ' ' : str(ch)),
	regexmatch: ([pattern, text]) => {
		const re = safeRegex(`^(?:${str(pattern)})$`);
		return re ? re.test(str(text)) : false;
	},
	regextest: ([pattern, text]) => {
		const re = safeRegex(str(pattern));
		return re ? re.test(str(text)) : false;
	},
	regexreplace: ([text, pattern, to]) => {
		const re = safeRegex(str(pattern), 'g');
		return re ? str(text).replace(re, str(to)) : str(text);
	},

	// -- lists and aggregation ------------------------------------------------
	length: ([a]) => (a === undefined || a === null ? 0 : Array.isArray(a) ? a.length : typeof a === 'object' ? Object.keys(a).length : str(a).length),
	list: (args) => (args.length === 1 ? asArray(args[0]) : args),
	array: (args) => (args.length === 1 ? asArray(args[0]) : args),
	first: ([a]) => asArray(a)[0],
	last: ([a]) => asArray(a)[asArray(a).length - 1],
	reverse: ([a]) => [...asArray(a)].reverse(),
	unique: ([a]) => {
		const out = [];
		for (const item of asArray(a)) if (!out.some((seen) => eq(seen, item))) out.push(item);
		return out;
	},
	flat: ([a]) => asArray(a).flat(Infinity),
	nonnull: ([a]) => asArray(a).filter((v) => v !== null && v !== undefined && v !== ''),
	sum: ([a]) => asArray(a).reduce((total, v) => total + (num(v) ?? 0), 0),
	product: ([a]) => asArray(a).reduce((total, v) => total * (num(v) ?? 1), 1),
	average: ([a]) => {
		const items = asArray(a).map(num).filter((v) => v !== undefined);
		return items.length ? items.reduce((x, y) => x + y, 0) / items.length : undefined;
	},
	min: (args) => pick(args, (a, b) => a < b),
	max: (args) => pick(args, (a, b) => a > b),

	// -- numbers ---------------------------------------------------------------
	number: ([a]) => num(a),
	round: ([a, digits]) => {
		const n = num(a);
		if (n === undefined) return undefined;
		const factor = 10 ** (Number(digits) || 0);
		return Math.round(n * factor) / factor;
	},
	floor: ([a]) => (num(a) === undefined ? undefined : Math.floor(num(a))),
	ceil: ([a]) => (num(a) === undefined ? undefined : Math.ceil(num(a))),
	trunc: ([a]) => (num(a) === undefined ? undefined : Math.trunc(num(a))),

	// -- dates and durations ---------------------------------------------------
	date: ([a, pattern]) => {
		if (pattern !== undefined && isDate(a)) return formatDate(a, pattern);
		return coerceDate(a) ?? undefined;
	},
	now: () => new Date(),
	today: () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; },
	dur: ([a]) => (isDuration(a) ? a : parseDuration(str(a)) ?? undefined),
	duration: ([a]) => (isDuration(a) ? a : parseDuration(str(a)) ?? undefined),
	dateformat: ([a, pattern]) => formatDate(coerceDate(a), str(pattern)),
	durationformat: ([a]) => (isDuration(a) ? formatDuration(a) : ''),
	striptime: ([a]) => {
		const date = coerceDate(a);
		if (!date) return undefined;
		const out = new Date(date);
		out.setHours(0, 0, 0, 0);
		return out;
	},

	// -- links -----------------------------------------------------------------
	link: ([target, text]) => {
		if (target === undefined || target === null) return undefined;
		if (isLink(target)) return makeLink(target.path, text === undefined ? target.display : str(text));
		return makeLink(str(target), text === undefined ? null : str(text));
	},
	elink: ([url, text]) => (url === undefined || url === null || str(url) === '' ? undefined
		: makeExternalLink(str(url), text === undefined ? str(url) : str(text))),

	// -- links, Bases spelling -------------------------------------------------
	// `file.hasLink(this)` — does this row's file link to that page? Either
	// side may be a link, a page, or a `file` namespace; linkKey settles it.
	haslink: ([from, to]) => {
		const key = linkKey(to);
		if (key === null) return false;
		const links = [...asArray(from?.links ?? from?.outlinks), ...asArray(from?.embeds)];
		return links.some((link) => linkKey(link) === key);
	},
	hastag: ([page, ...tags]) => {
		const own = asArray(page?.tags).map((t) => String(t).toLowerCase().replace(/^#/, ''));
		return tags.flat().some((tag) => own.includes(String(tag).toLowerCase().replace(/^#/, '')));
	},
	infolder: ([page, folder]) => String(page?.folder ?? '').toLowerCase()
		.startsWith(String(folder).toLowerCase().replace(/\/$/, '')),

	// -- control ---------------------------------------------------------------
	// Bases writes `if(a, b, c)` where Dataview writes `choice(a, b, c)`.
	if: ([test, whenTrue, whenFalse]) => (truthy(test) ? whenTrue : whenFalse),
	choice: ([test, whenTrue, whenFalse]) => (truthy(test) ? whenTrue : whenFalse),
	default: ([a, fallback]) => (a === undefined || a === null || a === '' ? fallback : a),
	ldefault: ([a, fallback]) => (a === undefined || a === null || a === '' ? fallback : a),
	typeof: ([a]) => {
		if (Array.isArray(a)) return 'array';
		if (isDate(a)) return 'date';
		if (isDuration(a)) return 'duration';
		if (isLink(a)) return 'link';
		if (a === null || a === undefined) return 'null';
		return typeof a;
	},
	string: ([a]) => str(a),
};

function pick(args, better) {
	const items = (args.length === 1 ? asArray(args[0]) : args)
		.filter((v) => v !== undefined && v !== null);
	if (!items.length) return undefined;
	return items.reduce((best, v) => {
		const a = isDate(v) ? v.getTime() : isDuration(v) ? v.ms : typeof v === 'number' ? v : String(v);
		const b = isDate(best) ? best.getTime() : isDuration(best) ? best.ms : typeof best === 'number' ? best : String(best);
		return better(a, b) ? v : best;
	});
}

/** Function names this build understands — used to report the unsupported ones. */
export const KNOWN_FUNCTIONS = new Set(Object.keys(FUNCTIONS));

// ---- rendering a value ------------------------------------------------------

const NOTE_FILE = /\.(md|jmd)$/i;
const escapeHtml = (s) => String(s)
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const internalLink = (target, text) =>
	`<a class="internal-link" href="#" data-href="${escapeHtml(String(target).replace(NOTE_FILE, ''))}">${escapeHtml(text)}</a>`;

/**
 * One value as cell HTML, shared by both dialects so a link looks the same
 * wherever it came from.
 *
 * The case worth naming: a frontmatter value is often the STRING `[[Parks]]`
 * rather than a link object — YAML has no link type — and rendering it as text
 * put literal double brackets in the middle of kepano's tables. A string that
 * is shaped like a wikilink is a wikilink.
 */
export function valueHtml(value) {
	if (value === undefined || value === null) return '';
	if (isLink(value)) return internalLink(value.path, value.display ?? String(value.path).replace(NOTE_FILE, ''));
	if (isExternalLink(value)) {
		return `<a class="external-link" href="${escapeHtml(value.url)}" rel="noopener noreferrer">${escapeHtml(value.display)}</a>`;
	}
	if (Array.isArray(value)) return value.map(valueHtml).filter(Boolean).join(', ');
	if (typeof value === 'string') {
		const wikilink = /^\[\[([^\]|]*)(?:\|([^\]]*))?\]\]$/.exec(value.trim());
		if (wikilink) {
			const target = wikilink[1].split('#')[0].trim();
			return internalLink(target, wikilink[2]?.trim() || target);
		}
	}
	if (typeof value === 'boolean') return value ? '✓' : '';
	return escapeHtml(display(value));
}
