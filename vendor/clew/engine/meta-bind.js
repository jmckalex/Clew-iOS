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
// not data). Cosmetic arguments (addLabels, class, …) are tolerated.
// In a site export widgets render disabled: a static page has no write path.
import { display } from './dv-expr.js';
import { currentPage, scanPages, resolvePath } from './vault-model.js';

const esc = (s) => String(s)
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SUPPORTED = new Set(['toggle', 'slider', 'text', 'number', 'inlineselect', 'select']);

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
		if (!call) continue;                       // bare flags (addLabels…) are cosmetic
		const [, name, value] = call;
		if (name === 'option') {
			const [v, label] = splitArgs(value);
			decl.options.push({ value: v ?? '', label: label ?? v ?? '' });
		} else if (name === 'minValue') decl.min = Number(value) || 0;
		else if (name === 'maxValue') decl.max = Number(value) || 100;
		else if (name === 'stepSize') decl.step = Number(value) || 1;
		else if (name === 'defaultValue') decl.defaultValue = value;
		// anything else is the plugin's cosmetics; the widget works without it
	}

	let file = null;
	let prop = bind;
	const hash = bind.lastIndexOf('#');
	if (hash > 0) { file = bind.slice(0, hash).trim(); prop = bind.slice(hash + 1); }
	prop = prop.trim();
	if (!/^[A-Za-z_][\w-]*$/.test(prop)) return { error: `bind target “${bind}” (nested paths are not supported)` };
	decl.file = file;
	decl.prop = prop;
	return decl;
}

// ---- rendering --------------------------------------------------------------

const refusal = (text) => `<code class="clew-mb-refused">${esc(text)}</code>`;

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
	const value = page.fields?.[decl.prop] ?? decl.defaultValue;
	const source = page.sources?.[decl.prop] ?? 'fm';
	const disabled = process.env.CLEW_SITE_EXPORT === '1' ? ' disabled' : '';
	const data = `class="clew-mb" data-edit-path="${esc(page.path)}"`
		+ ` data-edit-field="${esc(decl.prop)}" data-edit-source="${esc(source)}"`;

	if (global.isLatex) return esc(display(value ?? ''));

	switch (decl.type) {
		case 'toggle':
			return `<input type="checkbox" ${data}${value === true || value === 'true' ? ' checked' : ''}${disabled}>`;
		case 'slider': {
			const n = Number(value);
			const now = Number.isFinite(n) ? n : decl.min;
			return `<span class="clew-mb-slider"><input type="range" ${data}`
				+ ` min="${decl.min}" max="${decl.max}" step="${decl.step}" value="${now}"${disabled}>`
				+ `<span class="clew-mb-value">${now}</span></span>`;
		}
		case 'number':
			return `<input type="number" ${data} value="${esc(value ?? '')}"${disabled}>`;
		case 'text':
			return `<input type="text" ${data} value="${esc(value ?? '')}"${disabled}>`;
		case 'inlineselect':
		case 'select': {
			const current = String(value ?? '');
			const options = decl.options.map((option) =>
				`<option value="${esc(option.value)}"${option.value === current ? ' selected' : ''}>${esc(option.label)}</option>`);
			if (!decl.options.some((o) => o.value === current)) {
				options.unshift(`<option value="${esc(current)}" selected>${esc(current || '—')}</option>`);
			}
			return `<select ${data}${disabled}>${options.join('')}</select>`;
		}
		default:
			return refusal(`INPUT[${inner}]`);
	}
}

export function viewHtml(inner) {
	const single = /^\{\s*([A-Za-z_][\w-]*)\s*\}$/.exec(inner.trim());
	if (!single) return refusal(`VIEW[${inner}] — only a single {property} is supported`);
	const page = currentPage();
	const value = page?.fields?.[single[1]];
	const text = esc(display(value ?? ''));
	if (global.isLatex) return text;
	return `<span class="clew-mb-view">${text}</span>`;
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
