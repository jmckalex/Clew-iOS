// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Obsidian **Bases**: `.base` files, embedded as `![[Trips.base#Location]]`.
//
// Bases is Obsidian's FIRST-PARTY database view, and the reason it is here
// rather than on a someday list is what the vault survey turned up: kepano's
// published vault — Obsidian's own CEO — contains zero Dataview queries, 30
// `.base` files, and embeds one in 50 of its 103 notes. A `.base` embed
// previously rendered as a "(not found)" box in Clew, because `mediaKind()`
// did not know the extension and the embed fell through to note
// transclusion. That is a visible breakage in a modern vault.
//
// The format is YAML:
//
//     filters:      a nested and/or/not tree of expressions
//     formulas:     named computed columns, reachable as formula.Name
//     properties:   display names, keyed by `note.x` / `file.x` / `formula.x`
//     views:        [{ type: table|cards|map, name, filters?, order, sort, limit }]
//
// The expressions are the same language as ```dataview, written with method
// calls — `file.hasLink(this)`, `list(loc).contains(this)` — which dv-expr.js
// desugars to the function calls Dataview spells out. That is the whole reason
// the two features share a parser.
import { display, evaluate, parseExpression } from './dv-expr.js';
import { FUNCTIONS, valueHtml } from './dv-functions.js';
import {
	scanPages, currentPage, fileFields, linkKey, isLinkish, makeLink, isLink, resolvePath,
} from './vault-model.js';

const NOTE_FILE = /\.(md|jmd)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;

const escapeHtml = (s) => String(s)
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- a YAML subset ----------------------------------------------------------

/**
 * Nested maps, block sequences, and scalars — enough for a `.base` file and
 * deliberately no more.
 *
 * Engine files may not import src/shared (dist/engine is a verbatim copy), so
 * the app's frontmatter reader is out of reach; and that one is a FLAT reader
 * anyway, which `views:` is not. Anything this cannot parse comes back as a
 * string rather than a throw, so a `.base` using YAML features Clew does not
 * read degrades to a view Clew cannot build, and says so.
 */
export function parseYaml(text) {
	const lines = [];
	for (const raw of String(text).replace(/\r/g, '').split('\n')) {
		if (!raw.trim() || /^\s*#/.test(raw)) continue;
		lines.push({ indent: raw.match(/^[ \t]*/)[0].replace(/\t/g, '  ').length, text: raw.trim() });
	}
	const [value] = parseBlock(lines, 0, lines.length ? lines[0].indent : 0);
	return value ?? {};
}

function parseBlock(lines, index, indent) {
	if (index >= lines.length) return [null, index];
	if (lines[index].text.startsWith('- ')) return parseSequence(lines, index, indent);
	return parseMapping(lines, index, indent);
}

function parseSequence(lines, index, indent) {
	const items = [];
	let i = index;
	while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
		const inner = lines[i].text.slice(2).trim();
		const childIndent = indent + 2;
		const hasChildren = i + 1 < lines.length && lines[i + 1].indent > indent;
		if (/^[\w.$-]+\s*:/.test(inner)) {
			// `- key: value` opens a map whose remaining keys are indented below.
			const own = [{ indent: childIndent, text: inner }];
			let j = i + 1;
			while (j < lines.length && lines[j].indent > indent) {
				own.push({ indent: lines[j].indent, text: lines[j].text });
				j++;
			}
			const [value] = parseMapping(own, 0, childIndent);
			items.push(value);
			i = j;
			continue;
		}
		if (inner === '' && hasChildren) {
			const [value, next] = parseBlock(lines, i + 1, lines[i + 1].indent);
			items.push(value);
			i = next;
			continue;
		}
		items.push(scalar(inner));
		i++;
	}
	return [items, i];
}

function parseMapping(lines, index, indent) {
	const map = {};
	let i = index;
	while (i < lines.length && lines[i].indent === indent) {
		const match = /^("[^"]*"|'[^']*'|[^:]+?)\s*:\s*([\s\S]*)$/.exec(lines[i].text);
		if (!match) { i++; continue; }
		const key = match[1].replace(/^["']|["']$/g, '');
		const inline = match[2].trim();
		if (inline !== '') { map[key] = scalar(inline); i++; continue; }
		if (i + 1 < lines.length && lines[i + 1].indent > indent) {
			const [value, next] = parseBlock(lines, i + 1, lines[i + 1].indent);
			map[key] = value;
			i = next;
			continue;
		}
		map[key] = null;
		i++;
	}
	return [map, i];
}

function scalar(text) {
	const value = text.trim();
	if (value === '[]') return [];
	if (value === '{}') return {};
	if (/^".*"$/.test(value) || /^'.*'$/.test(value)) return value.slice(1, -1);
	if (value === 'true') return true;
	if (value === 'false') return false;
	if (value === 'null' || value === '~') return null;
	if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
	if (/^\[.*\]$/.test(value)) {
		return value.slice(1, -1).split(',').map((v) => scalar(v)).filter((v) => v !== '');
	}
	return value;
}

// ---- filters ------------------------------------------------------------------

const cache = new Map();
const compile = (source) => {
	if (!cache.has(source)) cache.set(source, parseExpression(String(source)));
	return cache.get(source);
};

/**
 * A filter tree — `{and: [...]}`, `{or: [...]}`, `{not: [...]}`, or a bare
 * expression string — into a predicate. Nodes may nest arbitrarily.
 */
export function compileFilter(node) {
	if (node === null || node === undefined) return () => true;
	if (typeof node === 'string') {
		const tree = compile(node);
		return (ctx) => Boolean(evaluate(tree, ctx));
	}
	if (Array.isArray(node)) {
		const parts = node.map(compileFilter);
		return (ctx) => parts.every((fn) => fn(ctx));
	}
	const tests = [];
	if (node.and) { const parts = [].concat(node.and).map(compileFilter); tests.push((c) => parts.every((f) => f(c))); }
	if (node.or) { const parts = [].concat(node.or).map(compileFilter); tests.push((c) => parts.some((f) => f(c))); }
	if (node.not) { const parts = [].concat(node.not).map(compileFilter); tests.push((c) => !parts.some((f) => f(c))); }
	if (!tests.length) return () => true;
	return (ctx) => tests.every((fn) => fn(ctx));
}

// ---- evaluation context --------------------------------------------------------

function contextFor(page, self, formulas) {
	const file = fileFields(page);
	const computed = {};
	let computing = false;
	const context = {
		functions: FUNCTIONS,
		linkKey,
		isLinkish,
		makeLink,
		resolve(name) {
			if (name === 'this') return self ? { file: fileFields(self), ...self.fields } : undefined;
			if (name === 'file') return file;
			if (name === 'note') return page.fields;
			if (name === 'formula') return formulaValues();
			if (name in page.fields) return page.fields[name];
			if (name in file) return file[name];
			return undefined;
		},
	};
	// Formulas may reference earlier formulas, so they are computed in
	// declaration order — and guarded, because a base that references itself
	// must not recurse forever.
	function formulaValues() {
		if (computing) return computed;
		computing = true;
		for (const [name, source] of Object.entries(formulas ?? {})) {
			if (!(name in computed)) computed[name] = evaluate(compile(source), context);
		}
		computing = false;
		return computed;
	}
	return context;
}

// ---- the base document ----------------------------------------------------------

/** Parse a `.base` file into { filters, formulas, properties, views }. */
export function parseBase(text) {
	const doc = parseYaml(text);
	const views = Array.isArray(doc.views) ? doc.views.filter(Boolean) : [];
	return {
		filters: doc.filters ?? null,
		formulas: doc.formulas ?? {},
		properties: doc.properties ?? {},
		views: views.length ? views : [{ type: 'table', name: 'Table', order: [] }],
	};
}

/** A column's heading: the base's own displayName if it gave one. */
function headingFor(base, column) {
	const bare = String(column).replace(/^(note|file|formula)\./, '');
	for (const key of [column, `note.${column}`, `file.${column}`, `formula.${column}`]) {
		const displayName = base.properties?.[key]?.displayName;
		if (displayName) return displayName;
	}
	return bare;
}

/** Rows for one view: base filters AND the view's own, then sort and limit. */
export function runView(base, view, pages, self) {
	const baseFilter = compileFilter(base.filters);
	const viewFilter = compileFilter(view.filters);
	let rows = pages.filter((page) => {
		const ctx = contextFor(page, self, base.formulas);
		return baseFilter(ctx) && viewFilter(ctx);
	});

	const sorts = [].concat(view.sort ?? []).filter(Boolean);
	for (const entry of [...sorts].reverse()) {
		const key = entry.property ?? entry.column ?? entry.field;
		if (!key) continue;
		const tree = compile(key);
		const desc = String(entry.direction ?? 'ASC').toUpperCase().startsWith('DESC');
		rows = rows.map((page, i) => ({ page, i })).sort((x, y) => {
			const a = sortKey(evaluate(tree, contextFor(x.page, self, base.formulas)));
			const b = sortKey(evaluate(tree, contextFor(y.page, self, base.formulas)));
			if (a === b) return x.i - y.i;
			if (a === null) return 1;
			if (b === null) return -1;
			return (a < b ? -1 : 1) * (desc ? -1 : 1);
		}).map((entry_) => entry_.page);
	}
	if (!sorts.length) rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
	const limit = Number(view.limit);
	return limit > 0 ? rows.slice(0, limit) : rows;
}

function sortKey(value) {
	if (value === undefined || value === null) return null;
	if (value instanceof Date) return value.getTime();
	if (typeof value === 'number' || typeof value === 'boolean') return Number(value);
	return String(display(value)).toLowerCase();
}

// ---- rendering -------------------------------------------------------------------

const internalLink = (target, text) =>
	`<a class="internal-link" href="#" data-href="${escapeHtml(String(target).replace(NOTE_FILE, ''))}">${escapeHtml(text)}</a>`;

const cellHtml = valueHtml;

const notice = (title, lines) =>
	`<div class="clew-query is-unsupported"><div class="clew-query-title">${escapeHtml(title)}</div>`
	+ lines.map((l) => `<div class="clew-query-note">${l}</div>`).join('') + '</div>\n';

/** The vault path an image-valued expression points at, or null. */
function imagePath(value) {
	const link = isLink(value) ? value : typeof value === 'string' ? { path: value } : null;
	if (!link) return null;
	const resolved = resolvePath(String(link.path)) ?? String(link.path);
	return IMAGE.test(resolved) ? resolved : null;
}

const assetUrl = (rel) => {
	// Preview documents live at clew-preview://vault/<sid>/<path>, so a vault
	// URL must carry the session id as its first segment (see wikilinks.js).
	const sid = process.env.CLEW_SESSION_ID;
	const encoded = rel.split('/').map(encodeURIComponent).join('/');
	return sid ? `/${encodeURIComponent(sid)}/${encoded}` : `/${encoded}`;
};

function renderTableView(base, view, rows, self) {
	const columns = [].concat(view.order ?? []).filter(Boolean).map(String);
	const useColumns = columns.length ? columns : ['file.name'];
	const head = useColumns.map((c) => `<th>${escapeHtml(headingFor(base, c))}</th>`).join('');
	const body = rows.map((page) => {
		const ctx = contextFor(page, self, base.formulas);
		const cells = useColumns.map((column) => {
			const value = evaluate(compile(column), ctx);
			// `file.name` is the row's identity — link it, as Obsidian does.
			if (column === 'file.name') return `<td>${internalLink(page.path, page.name)}</td>`;
			return `<td${editableAttrs(page, column)}>${cellHtml(value)}</td>`;
		});
		return `<tr>${cells.join('')}</tr>`;
	}).join('\n');
	return `<table class="clew-query clew-base"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Bases columns are `note.x` or a bare property; both are real stored fields. */
function editableAttrs(page, column) {
	const bare = String(column).replace(/^note\./, '');
	if (/^(file|formula)\./.test(column) || !/^[A-Za-z][\w -]*$/.test(bare)) return '';
	const source = page.sources?.[bare];
	if (!source) return '';
	return ` class="clew-q-cell" data-edit-path="${escapeHtml(page.path)}"`
		+ ` data-edit-field="${escapeHtml(bare)}" data-edit-source="${escapeHtml(source)}"`;
}

function renderCardsView(base, view, rows, self) {
	const size = Number(view.cardSize) || 0;
	const style = size ? ` style="--clew-card-size: ${Math.max(40, Math.min(400, size))}px"` : '';
	const columns = [].concat(view.order ?? []).filter(Boolean).map(String);
	const cards = rows.map((page) => {
		const ctx = contextFor(page, self, base.formulas);
		const image = view.image ? imagePath(evaluate(compile(String(view.image)), ctx)) : null;
		const meta = columns.filter((c) => c !== 'file.name').map((column) => {
			const value = cellHtml(evaluate(compile(column), ctx));
			return value ? `<div class="clew-card-meta">${value}</div>` : '';
		}).join('');
		return `<div class="clew-card" data-href="${escapeHtml(page.path.replace(NOTE_FILE, ''))}">`
			+ (image ? `<img class="clew-card-image" src="${escapeHtml(assetUrl(image))}" alt="" loading="lazy">` : '')
			+ `<div class="clew-card-title">${internalLink(page.path, page.name)}</div>`
			+ meta + '</div>';
	}).join('\n');
	return `<div class="clew-cards"${style}>\n${cards}\n</div>`;
}

/**
 * The map view: every row that yields a coordinate becomes a marker on the
 * same Leaflet map the ```leaflet fence produces — the `clew-leaflet` div
 * and its data-leaflet config are the contract, and the preview client's
 * leaflet-maps.js does everything else (tiles, fit-to-markers, popups whose
 * links open the note). `coordinates:` names the property holding
 * [lat, long] — kepano's vaults store a list of two strings — and a
 * "lat, long" string works too. `defaultZoom` caps the fit. `markerColor`
 * is evaluated per row; a named marker color tints the pin the way
 * `mapmarker:` does on leaflet fences. `markerIcon` names Lucide icons
 * Clew does not ship, so markers stay pins and dots — presentation
 * degrades, the data does not.
 */
function renderMapView(base, view, rows, self) {
	const coordSource = String(view.coordinates ?? 'note.coordinates');
	const colorSource = view.markerColor !== undefined ? String(view.markerColor) : null;
	const markers = [];
	for (const page of rows) {
		const ctx = contextFor(page, self, base.formulas);
		let coords = null;
		try { coords = coordsFrom(evaluate(compile(coordSource), ctx)); } catch { /* no marker */ }
		if (!coords) continue;
		const marker = { lat: coords[0], long: coords[1], link: page.path, label: page.name };
		if (colorSource) {
			try {
				const color = evaluate(compile(colorSource), ctx);
				if (typeof color === 'string' && /^[a-z]+$/i.test(color)) marker.type = color.toLowerCase();
			} catch { /* default pin */ }
		}
		markers.push(marker);
	}
	if (!markers.length) {
		return `<div class="clew-query is-empty">No rows in this view carry coordinates.</div>`;
	}
	const config = { noteMarkers: markers };
	const zoom = Number(view.defaultZoom);
	if (Number.isFinite(zoom)) config.zoom = zoom;
	const json = JSON.stringify(config)
		.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
	return `<div class="clew-leaflet" data-leaflet="${json}" style="height:400px"></div>`;
}

/** [lat, long] out of the shapes vaults store: a two-element list of numbers
 *  or numeric strings, or one "lat, long" string. */
function coordsFrom(value) {
	const list = Array.isArray(value) ? value
		: typeof value === 'string' ? value.split(',')
			: null;
	if (!list || list.length < 2) return null;
	const lat = Number(list[0]);
	const long = Number(list[1]);
	return Number.isFinite(lat) && Number.isFinite(long) ? [lat, long] : null;
}

/** Render one view of a parsed base. */
export function renderBaseView(base, viewName) {
	const view = viewName
		? base.views.find((v) => String(v.name ?? '').toLowerCase() === String(viewName).toLowerCase())
		: base.views[0];
	if (!view) {
		return notice(`This base has no view called "${viewName}"`, [
			'Views in this file: ' + escapeHtml(base.views.map((v) => v.name ?? '(unnamed)').join(', ')) + '.',
		]);
	}
	const type = String(view.type ?? 'table').toLowerCase();
	if (type !== 'table' && type !== 'cards' && type !== 'list' && type !== 'map') {
		return notice(`Clew does not render "${type}" base views`, [
			'Table, list, card and map views work; this one is left alone rather '
			+ 'than approximated with a different kind of view.',
		]);
	}

	const self = currentPage();
	const rows = runView(base, view, scanPages().pages, self);
	if (!rows.length) return `<div class="clew-query is-empty">No results in this base view.</div>\n`;
	const title = view.name ? `<div class="clew-query-group">${escapeHtml(view.name)}</div>` : '';
	const body = type === 'cards' ? renderCardsView(base, view, rows, self)
		: type === 'map' ? renderMapView(base, view, rows, self)
			: renderTableView(base, view, rows, self);
	return title + body + '\n';
}

/** Render a `.base` file's view from its raw YAML. */
export function renderBase(text, viewName) {
	if (global.isLatex) return '';
	let base;
	try { base = parseBase(text); } catch {
		return notice('This .base file could not be read', ['Clew reads a YAML subset; this file uses more of it.']);
	}
	if (!base.views.length) return notice('This .base file defines no views', []);
	return renderBaseView(base, viewName);
}

/**
 * The `![[Something.base]]` embed hook.
 *
 * wikilinks.js calls this rather than the other way round: vault-model.js
 * deliberately avoids importing wikilinks.js so that this direction is
 * available without a cycle.
 */
export function renderBaseEmbed(relPath, viewName, readFile) {
	const text = readFile(relPath);
	if (text === null) {
		return notice('This base could not be read', [escapeHtml(relPath)]);
	}
	return renderBase(text, viewName);
}

/**
 * ```base — the same document, written inline in a note. Obsidian supports
 * both; kepano's vault only uses the file form, but the fence costs one
 * tokenizer and makes a base testable without a second file.
 */
export const baseFence = {
	name: 'baseFence',
	level: 'block',
	start(src) { return src.match(/^```base\b/m)?.index; },
	tokenizer(src) {
		const match = /^```base[ \t]*\n([\s\S]*?)\n```[ \t]*(?:\n+|$)/.exec(src);
		if (!match) return;
		return { type: 'baseFence', raw: match[0], text: match[1] };
	},
	renderer(token) {
		return renderBase(token.text, null);
	},
};

export default [baseFence];
