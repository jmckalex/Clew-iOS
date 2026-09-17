// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// ```dataviewjs — a `dv` shim over the same page model as ```dataview.
//
// This is OFF unless a vault opts in (`dataviewJs` in vault-settings.json),
// and the gate is the whole design. Unlike DQL, which is a closed grammar
// whose unsupported parts can be enumerated and refused before running, this
// is JavaScript: nothing can be known about a block until it runs. What can be
// promised instead is that failure is NAMED — a block reaching for something
// Clew has no equivalent of says which thing, rather than rendering blank or,
// worse, rendering something plausible and wrong.
//
// The gate is not new caution: Clew already runs note-embedded JavaScript
// (jmarkdown script blocks, `.clew/scripts/*.js`). What it is not willing to
// do is run it in a vault the user has just downloaded without being asked.
//
// Honestly missing, and each says so by name when touched:
//   dv.app     Obsidian's internal application object — no faithful shim exists
//   dv.io      asynchronous vault IO
//   dv.luxon   a date library Clew does not ship
// and anything asynchronous: the renderer is synchronous, so a block using
// top-level `await` is reported rather than half-run.
import { display, isDate, isDuration, coerceDate, parseDuration } from './dv-expr.js';
import { FUNCTIONS, valueHtml } from './dv-functions.js';
import { scanPages, currentPage, fileFields, makeLink } from './vault-model.js';
import { parseQuery, parseSource, runQuery } from './dataview.js';
import fs from 'node:fs';
import path from 'node:path';

const escapeHtml = (s) => String(s)
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Enabled per vault; the render service passes the flag through the worker env. */
export const jsEnabled = () => process.env.CLEW_DATAVIEW_JS === '1';

class UnavailableError extends Error {}
const unavailable = (what, why) => {
	throw new UnavailableError(`${what} is not available in Clew — ${why}.`);
};

/**
 * `dv.container` (and a block's `this.container`) must be PASSABLE — the
 * Charts bridge takes it as renderChart's second argument and ignores it —
 * but there is still no live DOM here, so anything actually done WITH the
 * container fails by name on first touch instead.
 */
const containerToken = new Proxy({}, {
	get: (_, prop) => unavailable(`container.${String(prop)}`, 'there is no live DOM during rendering'),
});

// ---- DataArray ---------------------------------------------------------------

/**
 * Dataview's chainable array. A Proxy so that `pages[0]`, `pages.length` and
 * `pages.file` all behave: the last of those is Dataview's field spreading,
 * where reading a property off an array reads it off every element.
 */
export function dataArray(items) {
	const values = [...items];
	const api = {
		values,
		array: () => [...values],
		get length() { return values.length; },
		where: (fn) => dataArray(values.filter((v, i) => safeCall(fn, v, i))),
		filter: (fn) => dataArray(values.filter((v, i) => safeCall(fn, v, i))),
		map: (fn) => dataArray(values.map((v, i) => safeCall(fn, v, i))),
		flatMap: (fn) => dataArray(values.flatMap((v, i) => asList(safeCall(fn, v, i)))),
		forEach: (fn) => { values.forEach((v, i) => safeCall(fn, v, i)); return api; },
		sort: (fn, direction = 'asc') => {
			const sign = String(direction).toLowerCase().startsWith('desc') ? -1 : 1;
			const keyed = values.map((v, i) => ({ v, i, k: fn ? safeCall(fn, v, i) : v }));
			keyed.sort((a, b) => {
				const x = sortable(a.k);
				const y = sortable(b.k);
				if (x === y) return a.i - b.i;
				if (x === null) return 1;
				if (y === null) return -1;
				return (x < y ? -1 : 1) * sign;
			});
			return dataArray(keyed.map((e) => e.v));
		},
		groupBy: (fn) => {
			const groups = new Map();
			values.forEach((v, i) => {
				const key = safeCall(fn, v, i);
				const id = display(key);
				if (!groups.has(id)) groups.set(id, { key, rows: [] });
				groups.get(id).rows.push(v);
			});
			return dataArray([...groups.values()].map((g) => ({ key: g.key, rows: dataArray(g.rows) })));
		},
		distinct: (fn) => {
			const seen = new Set();
			const out = [];
			values.forEach((v, i) => {
				const id = display(fn ? safeCall(fn, v, i) : v);
				if (seen.has(id)) return;
				seen.add(id);
				out.push(v);
			});
			return dataArray(out);
		},
		limit: (n) => dataArray(values.slice(0, Math.max(0, Number(n) || 0))),
		/** Dataview's in-place edit; it returns the array so chains continue. */
		mutate: (fn) => { values.forEach((v, i) => safeCall(fn, v, i)); return api; },
		groupIn: (fn) => api.groupBy(fn),
		expand: (fn) => dataArray(values.flatMap((v, i) => [v, ...asList(safeCall(fn, v, i))])),
		slice: (a, b) => dataArray(values.slice(a, b)),
		first: () => values[0],
		last: () => values[values.length - 1],
		find: (fn) => values.find((v, i) => safeCall(fn, v, i)),
		some: (fn) => values.some((v, i) => safeCall(fn, v, i)),
		every: (fn) => values.every((v, i) => safeCall(fn, v, i)),
		includes: (v) => values.includes(v),
		join: (sep = ', ') => values.map(display).join(sep),
		reverse: () => dataArray([...values].reverse()),
		concat: (other) => dataArray([...values, ...asList(other)]),
		[Symbol.iterator]: () => values[Symbol.iterator](),
	};
	return new Proxy(api, {
		get(target, prop) {
			if (prop in target) return target[prop];
			if (typeof prop === 'string' && /^\d+$/.test(prop)) return values[Number(prop)];
			if (prop === Symbol.isConcatSpreadable) return true;
			// Dataview spreads an unknown property over the elements.
			if (typeof prop === 'string') {
				return dataArray(values.map((v) => v?.[prop]).filter((v) => v !== undefined));
			}
			return undefined;
		},
		has: (target, prop) => prop in target || prop in values,
	});
}

const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : v?.values ?? [v]);
const safeCall = (fn, ...args) => { try { return fn(...args); } catch { return undefined; } };
function sortable(value) {
	if (value === undefined || value === null) return null;
	if (isDate(value)) return value.getTime();
	if (isDuration(value)) return value.ms;
	if (typeof value === 'number' || typeof value === 'boolean') return Number(value);
	return String(display(value)).toLowerCase();
}

// ---- the page shape a script sees ----------------------------------------------

/**
 * A page as a script sees it: the frontmatter fields at the top level,
 * `file` beneath. (No inline fields: `Key:: value` is a description list
 * in this dialect — query-fences.js.)
 *
 * The list-valued `file` members are DataArrays rather than plain arrays,
 * because scripts write `page.file.tasks.where(...)` — Dataview returns its
 * chainable array everywhere, and a plain one fails on the second call.
 */
const pageProxy = (page) => {
	const file = fileFields(page);
	const wrapped = {};
	for (const [key, value] of Object.entries(file)) {
		wrapped[key] = Array.isArray(value) ? dataArray(value) : value;
	}
	return { file: wrapped, ...page.fields };
};

// ---- the dv object ---------------------------------------------------------------

const VIEW_DEPTH_LIMIT = 3;

/**
 * Build a `dv` for one block. `out` collects HTML in call order, which is how
 * a script that calls dv.header() then dv.table() ends up in that order.
 */
export function makeDv(out, self, viewDepth = 0) {
	const pagesOf = (source) => {
		const all = scanPages().pages.filter((p) => p.isNote);
		if (!source || !String(source).trim()) return dataArray(all.map(pageProxy));
		const predicate = parseSource(String(source));
		return dataArray(all.filter(predicate).map(pageProxy));
	};

	const dv = {
		// -- querying ---------------------------------------------------------
		pages: pagesOf,
		pagePaths: (source) => dataArray(pagesOf(source).values.map((p) => p.file.path)),
		page: (name) => {
			const target = String(name).replace(/^\[\[|\]\]$/g, '').split('|')[0];
			const found = scanPages().pages.find((p) => p.isNote
				&& (p.path === target || p.path.replace(/\.(md|jmd)$/i, '') === target || p.name === target));
			return found ? pageProxy(found) : undefined;
		},
		current: () => (self ? pageProxy(self) : undefined),
		array: (value) => dataArray(asList(value)),
		isArray: (value) => Array.isArray(value) || Boolean(value?.values),
		/** The DQL engine, for `dv.tryQuery`-style use. Returns a DataArray.
		 *  Rows carry FLATTEN bindings; after GROUP BY they are `{key, rows}`
		 *  group objects rather than pages, as in Dataview. */
		tryQuery: (source) => {
			const query = parseQuery(String(source));
			const rows = runQuery(query, scanPages().pages.filter((p) => p.isNote), self);
			return dataArray(rows.map((row) => (row.page
				? { ...pageProxy(row.page), ...row.extra }
				: { ...row.extra })));
		},
		query: (source) => ({ successful: true, value: { values: dv.tryQuery(source).values } }),

		// -- values -------------------------------------------------------------
		fileLink: (target, _embed, displayText) => makeLink(String(target), displayText ?? null),
		date: (value) => coerceDate(value) ?? undefined,
		duration: (value) => parseDuration(String(value)) ?? undefined,
		func: FUNCTIONS,
		/** Dataview exposes its own function table; keep the names aligned. */
		compare: (a, b) => (sortable(a) < sortable(b) ? -1 : sortable(a) > sortable(b) ? 1 : 0),

		// -- rendering -----------------------------------------------------------
		header: (level, text) => {
			const n = Math.min(6, Math.max(1, Number(level) || 2));
			out.push(`<h${n}>${escapeHtml(display(text))}</h${n}>`);
		},
		paragraph: (text) => out.push(`<p>${valueHtml(text)}</p>`),
		span: (text) => out.push(`<span>${valueHtml(text)}</span>`),
		el: (tag, text) => {
			const name = /^[a-z][a-z0-9]*$/i.test(String(tag)) ? String(tag).toLowerCase() : 'div';
			out.push(`<${name}>${valueHtml(text)}</${name}>`);
		},
		table: (headers, rows) => {
			const head = asList(headers).map((h) => `<th>${escapeHtml(display(h))}</th>`).join('');
			const body = asList(rows).map((row) =>
				`<tr>${asList(row).map((cell) => `<td>${valueHtml(cell)}</td>`).join('')}</tr>`).join('\n');
			out.push(`<table class="clew-query clew-dataview"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
		},
		list: (items) => {
			out.push(`<ul class="clew-query clew-dataview">\n`
				+ asList(items).map((item) => `<li>${valueHtml(item)}</li>`).join('\n') + '\n</ul>');
		},
		taskList: (tasks) => {
			const entries = asList(tasks).map((task) => {
				const text = escapeHtml(String(task?.text ?? display(task)));
				const done = Boolean(task?.completed ?? task?.done);
				const wire = task?.path !== undefined && task?.line !== undefined
					? ` data-task-path="${escapeHtml(task.path)}" data-task-line="${task.line}"` : '';
				return `<li${wire}><input type="checkbox" disabled${done ? ' checked' : ''}> ${text}</li>`;
			}).join('\n');
			out.push(`<div class="clew-tasks clew-dataview"><ul class="clew-tasks-list">\n${entries}\n</ul></div>`);
		},

		// -- reusable views -------------------------------------------------------
		/**
		 * `dv.view("folder/name", input)` runs another script from the vault —
		 * the second most-used call in the wild after dv.current. Its CSS
		 * sibling is ignored; a view that styles itself still renders.
		 */
		view: (viewPath, input) => {
			if (viewDepth >= VIEW_DEPTH_LIMIT) unavailable('dv.view', 'the views nest too deeply');
			const root = process.env.CLEW_VAULT_ROOT;
			if (!root) return;
			const candidates = [`${viewPath}.js`, path.join(String(viewPath), 'view.js')];
			for (const candidate of candidates) {
				const abs = path.join(root, candidate);
				let code;
				try { code = fs.readFileSync(abs, 'utf8'); } catch { continue; }
				runScript(code, makeDv(out, self, viewDepth + 1), input);
				return;
			}
			unavailable(`dv.view("${viewPath}")`, 'no such view script in the vault');
		},

		// -- the Charts plugin's bridge -----------------------------------------
		/**
		 * Obsidian's Charts plugin gives dataviewjs `renderChart(config, el)`:
		 * a raw Chart.js configuration in, a chart in the output. The Clew
		 * Charts plugin's engine surface registers global.clewCharts when a
		 * vault enables it; without the plugin the call fails by name like
		 * everything else here. The element argument is accepted and ignored —
		 * output lands in call order, like every dv.* renderer.
		 */
		renderChart: (config, _element) => {
			const hook = globalThis.clewCharts;
			if (!hook) unavailable('renderChart', 'the Charts plugin is not enabled in this vault');
			try { out.push(hook.emit(config)); }
			catch (error) { throw new UnavailableError(`renderChart: ${String(error?.message ?? error)}`); }
		},

		// -- honestly missing -------------------------------------------------------
		get app() { return unavailable('dv.app', 'it is Obsidian\'s internal application object'); },
		get io() { return unavailable('dv.io', 'it is asynchronous, and rendering here is not'); },
		get luxon() { return unavailable('dv.luxon', 'Clew does not ship the Luxon date library; use dv.date()'); },
		get container() { return containerToken; },
		get component() { return unavailable('dv.component', 'there is no live DOM during rendering'); },
	};
	return dv;
}

/**
 * Run a block's code with `dv` and `input` in scope. Synchronous by design.
 *
 * `app` is bound deliberately: Obsidian puts its application object in scope
 * as a global, and scripts reach for it bare. Left unbound it fails as
 * "ReferenceError: app is not defined", which reads like a bug in Clew rather
 * than the true answer, which is that there is no such object here.
 */
export function runScript(code, dv, input) {
	const app = new Proxy({}, {
		get: () => unavailable('The Obsidian `app` object', 'it is Obsidian\'s own application, which Clew is not'),
	});
	// Obsidian also puts `window` in scope. The one property with a Clew
	// answer is renderChart (the Charts bridge); every other property names
	// itself as missing rather than pretending a browser is here.
	const windowShim = new Proxy({}, {
		get: (_, prop) => (prop === 'renderChart' ? dv.renderChart
			: unavailable(`window.${String(prop)}`, 'there is no browser window during rendering')),
	});
	// eslint-disable-next-line no-new-func
	const fn = new Function('dv', 'input', 'dataview', 'app', 'window', 'renderChart', `"use strict";\n${code}\n`);
	// `this.container` is how the wild calls renderChart; give it something.
	fn.call({ container: dv.container }, dv, input, dv, app, windowShim, dv.renderChart);
}

const notice = (title, lines) =>
	`<div class="clew-query is-unsupported"><div class="clew-query-title">${escapeHtml(title)}</div>`
	+ lines.map((l) => `<div class="clew-query-note">${l}</div>`).join('') + '</div>\n';

/** Render one ```dataviewjs block. Never throws out into the build. */
export function renderDataviewJs(code) {
	const out = [];
	const self = currentPage();
	try {
		runScript(code, makeDv(out, self), undefined);
	} catch (error) {
		const isKnown = error instanceof UnavailableError;
		const message = isKnown ? error.message
			: /await is only valid|Unexpected reserved word/i.test(String(error?.message))
				? 'This block is asynchronous. Clew renders notes synchronously, so a '
					+ 'dataviewjs block using top-level `await` cannot be run.'
				: `${error?.name ?? 'Error'}: ${error?.message ?? error}`;
		return (out.length ? out.join('\n') + '\n' : '')
			+ notice('This dataviewjs block did not finish', [
				escapeHtml(message),
				'Whatever it had already drawn is above; the rest did not run.',
			]);
	}
	if (!out.length) return `<div class="clew-query is-empty">This dataviewjs block produced no output.</div>\n`;
	return out.join('\n') + '\n';
}
