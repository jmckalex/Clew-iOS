// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Meta Bind's input widgets: `INPUT[toggle:done]` in prose renders a real
// toggle two-way bound to the note's `done` property. The plugin's idea IS
// Clew's own writable-database idea, which is why this port exists at all:
// the engine renders a widget carrying the same data-edit-path/-field/
// -source contract the editable query cells use, the preview client posts
// the same field-edit message on change, and the write flows through the
// same editNoteField path — frontmatter safety valve included. Nothing new
// is trusted; a widget is an editable cell that lives in a sentence.
//
//   INPUT[toggle:done]
//   INPUT[slider(minValue(0), maxValue(10)):rating]
//   INPUT[inlineSelect(option(draft), option(review), option(done)):status]
//   INPUT[text:subtitle]      INPUT[number:pages]
//   INPUT[toggle:[[Other Note]]#done]        (bind another note's property)
//   VIEW[{rating}]                           (display a bound value)
//
// Input types beyond toggle/slider/text/number/inlineSelect/select are
// refused BY NAME, inline, as are VIEW expressions beyond a single
// property and the whole button system (buttons run commands — behavior,
// not data). Cosmetic arguments (addLabels, …) are tolerated; `class(…)`
// is HONORED — author classes land on the element, as the plugin does it,
// so a vault script's stylesheet can size or restyle individual widgets.
// In a site export widgets render disabled: a static page has no write path.
//
// `locked` (a bare argument, Clew's — owner's ask 2026-09-30, for a GRADE
// that must not change by accident): `INPUT[number(locked):grade]` renders
// the widget inert beside a padlock button, which unlocks it for one edit
// — preview-client/meta-bind.js relocks it on commit, when focus leaves, and
// every render emits it locked again, so no state is stored anywhere.
// Obsidian's plugin skips an argument it does not know with a warning and
// still renders the field, so such a note keeps working there (unlocked).
import { display, coerceDate } from './dv-expr.js';
import { currentPage, scanPages, resolvePath } from './vault-model.js';
import { ID as BLOCK_ID } from './block-refs.js';

const esc = (s) => String(s)
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Widgets render as Web Awesome elements (MIT, bundled, lazily loaded by
// the preview client). The first six are Meta Bind's own vocabulary; the
// dated/textArea/progressBar group closes types Clew previously refused;
// `rating` and `color` are CLEW-NATIVE extensions — Obsidian's plugin
// will show its unknown-type error for those, which the manual says.
const SUPPORTED = new Set(['toggle', 'slider', 'text', 'number', 'inlineselect', 'select',
	'textarea', 'datepicker', 'date', 'time', 'progressbar', 'rating', 'color']);

// ---- parsing ----------------------------------------------------------------

/** Split `a, b(c, d), e` on top-level commas. */
function splitArgs(text) {
	const parts = [];
	let depth = 0;
	let buffer = '';
	for (const ch of text) {
		if (ch === '(') depth++;
		if (ch === ')') depth--;
		if (ch === ',' && depth === 0) { parts.push(buffer.trim()); buffer = ''; continue; }
		buffer += ch;
	}
	if (buffer.trim()) parts.push(buffer.trim());
	return parts;
}

/** `INPUT[…]`'s inside → { type, options, min, max, step, file, prop } or { error }. */
export function parseInputDeclaration(inner) {
	// The first ':' outside parentheses splits widget from bind target.
	let colon = -1;
	let depth = 0;
	for (let i = 0; i < inner.length; i++) {
		if (inner[i] === '(') depth++;
		if (inner[i] === ')') depth--;
		if (inner[i] === ':' && depth === 0) { colon = i; break; }
	}
	if (colon === -1) return { error: 'no bound property (INPUT[type:property])' };
	const left = inner.slice(0, colon).trim();
	const bind = inner.slice(colon + 1).trim();
	const head = /^([A-Za-z][\w]*)\s*(?:\(([\s\S]*)\))?$/.exec(left);
	if (!head) return { error: `unreadable input “${left}”` };
	const type = head[1];
	if (!SUPPORTED.has(type.toLowerCase())) return { error: `no Clew widget for INPUT[${type}]` };

	const decl = { type: type.toLowerCase(), options: [], min: 0, max: 100, step: 1, file: null, prop: null };
	for (const arg of head[2] ? splitArgs(head[2]) : []) {
		const call = /^([A-Za-z][\w]*)\s*\(([\s\S]*)\)$/.exec(arg);
		if (!call) {
			if (/^locked$/i.test(arg)) decl.locked = true;
			continue;                              // other bare flags (addLabels…) are cosmetic
		}
		const [, name, value] = call;
		if (name === 'option') {
			const [v, label] = splitArgs(value);
			decl.options.push({ value: v ?? '', label: label ?? v ?? '' });
		} else if (name === 'minValue') decl.min = Number(value) || 0;
		else if (name === 'maxValue') { decl.max = Number(value) || 100; decl.maxSet = true; }
		else if (name === 'stepSize') decl.step = Number(value) || 1;
		else if (name === 'defaultValue') decl.defaultValue = value;
		else if (name === 'class') {
			// Honored, not merely tolerated: the classes land on the element.
			// Only CSS-identifier-shaped tokens survive (they go into an HTML
			// attribute); several class(…) arguments accumulate.
			decl.classes ??= [];
			decl.classes.push(...value.split(/[\s,]+/).filter((c) => /^[A-Za-z_][\w-]*$/.test(c)));
		}
		// anything else is the plugin's cosmetics; the widget works without it
	}

	let file = null;
	let prop = bind;
	const hash = bind.lastIndexOf('#');
	if (hash > 0) { file = bind.slice(0, hash).trim(); prop = bind.slice(hash + 1); }
	prop = prop.trim();
	// `^block-id` binds the widget to TEXT — the block the marker names —
	// rather than to a property. Only the text widgets can hold prose.
	if (new RegExp(`^\\^${BLOCK_ID}$`).test(prop)) {
		if (decl.type !== 'text' && decl.type !== 'textarea') {
			return { error: `only text and textArea bind to a ^block (INPUT[${type}:${prop}])` };
		}
		decl.block = true;
	} else if (!/^[A-Za-z_][\w-]*$/.test(prop)) {
		return { error: `bind target “${bind}” (nested paths are not supported)` };
	}
	decl.file = file;
	decl.prop = prop;
	return decl;
}

/** The text a `^id` marker names: its line, marker stripped, fences masked. */
export function blockTextOf(text, id) {
	const re = new RegExp(`^(.*?)[ \\t]+\\^${id}[ \\t]*$`);
	let inFence = false;
	for (const line of String(text).split('\n')) {
		if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
		if (inFence) continue;
		const m = re.exec(line);
		if (m) return m[1];
	}
	return null;
}

// ---- rendering --------------------------------------------------------------

const refusal = (text) => `<code class="clew-mb-refused">${esc(text)}</code>`;

// A padlock, closed and open (the client shows one by aria-pressed). Inline
// SVG rather than wa-icon, whose default library fetches from a CDN.
const PADLOCK = '<svg class="clew-mb-lock-closed" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="7" width="10" height="7.5" rx="1.5" fill="currentColor"/></svg>'
	+ '<svg class="clew-mb-lock-open" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 7V5a3.5 3.5 0 0 1 6.9-.8" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="7" width="10" height="7.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

/** A lockable widget: locked, beside the button that unlocks it for one edit. */
function lockable(widget, prop) {
	return `<span class="clew-mb-lockable">${widget}<button type="button" class="clew-mb-lock"`
		+ ` aria-pressed="true" aria-label="Unlock ${esc(prop)}" title="Locked — click to edit">${PADLOCK}</button></span>`;
}

function boundPage(file) {
	if (!file) return currentPage();
	const target = file.replace(/^\[\[|\]\]$/g, '').split('|')[0].trim();
	const rel = resolvePath(target);
	return rel ? scanPages().byPath.get(rel) ?? null : null;
}

export function inputHtml(inner) {
	const decl = parseInputDeclaration(inner);
	if (decl.error) return refusal(`INPUT[${inner}] — ${decl.error}`);
	const page = boundPage(decl.file);
	if (!page) return refusal(`INPUT[${inner}] — “${decl.file}” is not in this vault`);
	const value = decl.block
		? blockTextOf(page.text ?? '', decl.prop.slice(1))
		: page.fields?.[decl.prop] ?? decl.defaultValue;
	if (decl.block && value === null) {
		return refusal(`INPUT[${inner}] — no ${decl.prop} block in “${page.path}”`);
	}
	const source = decl.block ? 'block' : page.sources?.[decl.prop] ?? 'fm';
	const siteExport = process.env.CLEW_SITE_EXPORT === '1';
	// A site export has no write path: every widget is disabled and a lock
	// would be a button that does nothing. progressBar only ever displays.
	const locked = decl.locked === true && !siteExport && decl.type !== 'progressbar';
	// Locked is `inert` — no click, focus or keystroke reaches it, shadow DOM
	// included — and it is in the HTML, so a widget is locked before any
	// script runs and every re-render (a morph syncs attributes) relocks it.
	const disabled = siteExport ? ' disabled' : locked ? ' inert' : '';
	const extra = decl.classes?.length ? ' ' + decl.classes.join(' ') : '';
	const data = `class="clew-mb${esc(extra)}" data-edit-path="${esc(page.path)}"`
		+ ` data-edit-field="${esc(decl.prop)}" data-edit-source="${esc(source)}"`;

	if (global.isLatex) return esc(display(value ?? ''));

	const widget = widgetHtml(decl, { data, value, disabled, extra, inner });
	return locked ? lockable(widget, decl.prop) : widget;
}

function widgetHtml(decl, { data, value, disabled, extra, inner }) {
	switch (decl.type) {
		case 'toggle':
			return `<wa-switch ${data}${value === true || value === 'true' ? ' checked' : ''}${disabled}></wa-switch>`;
		case 'slider': {
			const n = Number(value);
			const now = Number.isFinite(n) ? n : decl.min;
			return `<span class="clew-mb-slider"><wa-slider ${data}`
				+ ` min="${decl.min}" max="${decl.max}" step="${decl.step}" value="${now}"${disabled}></wa-slider>`
				+ `<span class="clew-mb-value">${now}</span></span>`;
		}
		case 'number':
			return `<wa-number-input ${data} size="small" value="${esc(value ?? '')}"${disabled}></wa-number-input>`;
		case 'text':
			return `<wa-input type="text" ${data} value="${esc(value ?? '')}"${disabled}></wa-input>`;
		case 'textarea':
			return `<wa-textarea ${data} value="${esc(value ?? '')}" rows="3" resize="vertical"${disabled}></wa-textarea>`;
		case 'datepicker':
		case 'date':
			return `<wa-input type="date" ${data} value="${esc(display(value ?? ''))}"${disabled}></wa-input>`;
		case 'time':
			return `<wa-time-input ${data} value="${esc(value ?? '')}"${disabled}></wa-time-input>`;
		case 'rating': {
			const n = Number(value);
			return `<wa-rating ${data} value="${Number.isFinite(n) ? n : 0}"`
				+ ` max="${decl.maxSet ? decl.max : 5}" precision="${decl.step}"${disabled}></wa-rating>`;
		}
		case 'color':
			return `<wa-color-picker ${data} value="${esc(value ?? '#888888')}" size="small"${disabled}></wa-color-picker>`;
		case 'progressbar': {
			// Read-only: a bound DISPLAY of a number, scaled to min/max.
			const n = Number(value);
			const pct = Number.isFinite(n)
				? Math.max(0, Math.min(100, ((n - decl.min) / (decl.max - decl.min || 1)) * 100)) : 0;
			return `<wa-progress-bar class="clew-mb-display${esc(extra)}" value="${pct}"></wa-progress-bar>`;
		}
		case 'inlineselect':
		case 'select': {
			const current = String(value ?? '');
			const options = decl.options.map((option) =>
				`<wa-option value="${esc(option.value)}"${option.value === current ? ' selected' : ''}>${esc(option.label)}</wa-option>`);
			if (!decl.options.some((o) => o.value === current)) {
				options.unshift(`<wa-option value="${esc(current)}" selected>${esc(current || '—')}</wa-option>`);
			}
			return `<wa-select ${data} value="${esc(current)}"${disabled}>${options.join('')}</wa-select>`;
		}
		default:
			return refusal(`INPUT[${inner}]`);
	}
}

const VIEW_KINDS = new Set(['relativetime', 'formatdate', 'formatnumber', 'formatbytes', 'badge', 'qr']);

/** Local-component ISO (no Z): a date-only property is LOCAL midnight, and
 *  a UTC-flavoured string would show yesterday west of Greenwich. */
function localIso(date) {
	const pad = (n) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
		+ `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * `VIEW[{prop}]` displays a bound value; `VIEW[kind:{prop}]` formats it —
 * relativeTime, formatDate, formatNumber, formatBytes, badge, qr. The
 * kinds are CLEW-NATIVE (Meta Bind's own VIEW takes expressions, which
 * are refused here by name).
 */
export function viewHtml(inner) {
	const match = /^(?:([A-Za-z]+)\s*:)?\s*\{\s*([A-Za-z_][\w-]*)\s*\}$/.exec(inner.trim());
	if (!match) return refusal(`VIEW[${inner}] — only {property}, optionally kind:{property}`);
	const kind = match[1]?.toLowerCase() ?? null;
	if (kind && !VIEW_KINDS.has(kind)) return refusal(`VIEW[${inner}] — no “${match[1]}” view`);
	const page = currentPage();
	const value = page?.fields?.[match[2]];
	const text = esc(display(value ?? ''));
	if (global.isLatex || !kind) {
		return global.isLatex ? text : `<span class="clew-mb-view">${text}</span>`;
	}
	if (kind === 'badge') return `<wa-badge variant="brand">${text}</wa-badge>`;
	if (kind === 'qr') {
		return value === undefined || value === ''
			? refusal(`VIEW[${inner}] — nothing to encode`)
			: `<wa-qr-code value="${esc(String(value))}" size="128"></wa-qr-code>`;
	}
	if (kind === 'formatnumber') return `<wa-format-number value="${Number(value) || 0}"></wa-format-number>`;
	if (kind === 'formatbytes') return `<wa-format-bytes value="${Number(value) || 0}"></wa-format-bytes>`;
	const date = coerceDate(value);
	if (!date) return `<span class="clew-mb-view">${text}</span>`;
	return kind === 'relativetime'
		? `<wa-relative-time date="${localIso(date)}" sync></wa-relative-time>`
		: `<wa-format-date date="${localIso(date)}" year="numeric" month="short" day="numeric"></wa-format-date>`;
}

// ---- the extensions ---------------------------------------------------------

export const metaBindInline = {
	name: 'metaBindInline',
	level: 'inline',
	start(src) { return src.match(/\b(?:INPUT|VIEW|BUTTON)\[/)?.index; },
	tokenizer(src) {
		// [[wikilinks]] inside a bind target carry brackets of their own.
		const match = /^(INPUT|VIEW|BUTTON)\[((?:[^[\]]|\[\[[^\]]*\]\])*)\]/.exec(src);
		if (!match) return;
		return { type: 'metaBindInline', raw: match[0], widget: match[1], inner: match[2] };
	},
	renderer(token) {
		if (token.widget === 'INPUT') return inputHtml(token.inner);
		if (token.widget === 'VIEW') return viewHtml(token.inner);
		return global.isLatex ? '' : refusal(`BUTTON[${token.inner}] — buttons run commands; no Clew equivalent`);
	},
};

/** ```meta-bind fences hold one declaration; the button/embed fences are
 *  the plugin's command machinery and are refused by name. */
export const metaBindFence = {
	name: 'metaBindFence',
	level: 'block',
	start(src) { return src.match(/^```meta-bind/m)?.index; },
	tokenizer(src) {
		const match = /^```meta-bind(-button|-embed|-js|-js-view)?[ \t]*\n([\s\S]*?)\n```[ \t]*(?:\n+|$)/.exec(src);
		if (!match) return;
		return { type: 'metaBindFence', raw: match[0], flavor: match[1] ?? '', body: match[2].trim() };
	},
	renderer(token) {
		if (global.isLatex) return '';
		if (token.flavor) {
			return `<div class="clew-query is-unsupported"><div class="clew-query-title">`
				+ `Clew does not run meta-bind${esc(token.flavor)} blocks</div>`
				+ `<div class="clew-query-note">${token.flavor === '-button'
					? 'Buttons run commands — behavior, not data. Clew\'s own tier for that is the note API.'
					: 'This block is the plugin\'s scripting surface.'}</div></div>\n`;
		}
		const inline = /^(INPUT|VIEW)\[((?:[^[\]]|\[\[[^\]]*\]\])*)\]$/.exec(token.body);
		if (!inline) {
			return `<div class="clew-query is-unsupported"><div class="clew-query-title">`
				+ `This meta-bind block is not a single INPUT[…] or VIEW[…]</div></div>\n`;
		}
		const html = inline[1] === 'INPUT' ? inputHtml(inline[2]) : viewHtml(inline[2]);
		return `<p class="clew-mb-block">${html}</p>\n`;
	},
};
