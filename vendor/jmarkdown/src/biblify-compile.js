/*
	Compile-time citation/bibliography engine for JMarkdown.

	This is a server-side port of the runtime Biblify client
	(../biblify/src/biblify.js), driven by cheerio instead of jQuery and reading
	the .bib file from disk instead of fetching it. It runs as a cheerio post-pass
	(see post-processor.js) over the rendered HTML, and only on the HTML path —
	LaTeX output is handled natively by natbib (the \cite commands pass straight
	through and ::Bibliography emits \bibliography; see citations.js).

	The inline-citation formatters (`generic_paren_processor`, `bjps_processor`)
	and the name/year helpers are ported as faithfully as possible from Biblify so
	the compiled output matches what the browser client produces.

	Placeholders consumed here are emitted by the parse-time extensions in
	citations.js:
	  <span class="biblify-cite" data-cite-cmd="…">   one inline cite command
	  <div class="biblify-bibliography" data-style …> one ::Bibliography directive
*/

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { configManager } from './config-manager.js';
import { CITE_RE } from './citations.js';

const require = createRequire(import.meta.url);

// citation.js is CommonJS; require() returns the Cite constructor itself, with
// Cite.plugins as a static (exactly how the browser Biblify uses it).
let Cite;
try {
	Cite = require('citation-js');
} catch (e) {
	console.error('Could not load citation-js. Is it installed?', e.message);
}

// Register the bundled CSL templates once. apa / harvard1 / vancouver ship with
// @citation-js/plugin-csl; chicago / ajp / bjps are bundled here.
let templatesRegistered = false;
const BUNDLED_TEMPLATES = {
	chicago: 'chicago-author-date-16th-edition.xml',
	ajp: 'australasian-journal-of-philosophy.xml',
	bjps: 'the-british-journal-for-the-philosophy-of-science.xml',
	econometrica: 'econometrica.csl',
	ergo: 'ergo.csl'
};

function registerTemplates(appDir, customTemplate, baseDir, activeStyle) {
	if (!Cite) return;
	const cslConfig = Cite.plugins.config.get('@csl');
	if (!templatesRegistered) {
		for (const [name, file] of Object.entries(BUNDLED_TEMPLATES)) {
			try {
				const xml = fs.readFileSync(path.join(appDir, 'csl', file), 'utf8');
				cslConfig.templates.add(name, xml);
			} catch (e) {
				console.error(`Could not load CSL template "${name}" (${file}): ${e.message}`);
			}
		}
		templatesRegistered = true;
	}
	// A document-specific custom CSL style (set via `Bibliography style: foo.csl`).
	// Only register it when it is actually the active style — a project config may
	// carry a leftover `template` pointer while this document overrides the style
	// to a builtin one. The metadata handler treats any non-builtin style name as
	// a custom file, so only load when the file exists; otherwise fall back to a
	// bundled template of the same name (ajp, econometrica, ergo) without noise.
	if (customTemplate && customTemplate.name === activeStyle && customTemplate.file) {
		const file = path.isAbsolute(customTemplate.file)
			? customTemplate.file
			: path.resolve(baseDir, customTemplate.file);
		if (fs.existsSync(file)) {
			try {
				cslConfig.templates.add(customTemplate.name, fs.readFileSync(file, 'utf8'));
			} catch (e) {
				console.error(`Could not load custom CSL template "${customTemplate.name}": ${e.message}`);
			}
		} else if (!(customTemplate.name in BUNDLED_TEMPLATES)) {
			console.error(`Custom CSL template file not found for style "${customTemplate.name}": ${file}`);
		}
	}
}

// --- BibTeX indexing (Biblify.processBibfile / get_citations) -----------------

function processBibfile(data) {
	const map = {};
	const parts = data.split(/\n\s*\n/);
	for (const part of parts) {
		const match = part.match(/@[a-zA-Z]+\{([^,]+),/);
		if (match) {
			map[match[1].trim()] = part;
		}
	}
	return map;
}

function getEntries(keys, bibfileMap) {
	const entries = [];
	for (const key of keys) {
		const entry = bibfileMap[key];
		if (entry === undefined) {
			console.error(`Warning: no bibliography entry found for ${key}`);
			continue;
		}
		entries.push(entry);
	}
	return entries;
}

// --- name / year helpers (ported from Biblify) --------------------------------

function getFullNamesFromCitation(cite, forceAll) {
	const sources = cite.data[0]['author'] !== undefined
		? cite.data[0]['author']
		: cite.data[0]['editor'];

	let names = '';
	if (forceAll === true) {
		const length = sources.length;
		let i = 1;
		for (const name of sources) {
			if (i !== 1 && i !== length) names += ', ';
			else if (i === length) names += ' and ';
			names += `${name['given']} ${name['family']}`;
			i += 1;
		}
		return names;
	}

	if (sources.length > 2) {
		names = `${sources[0]['given']} ${sources[0]['family']} <em>et al.</em>`;
	} else if (sources.length === 2) {
		names = `${sources[0]['given']} ${sources[0]['family']} and ${sources[1]['given']} ${sources[1]['family']}`;
	} else {
		names = `${sources[0]['given']} ${sources[0]['family']}`;
	}
	return names;
}

// --- inline-citation formatters (ported from Biblify) -------------------------

function generic_paren_processor(type, entries, firstOptional, secondOptional, style) {
	const cite = new Cite(entries);

	if (type === 't') {
		if (firstOptional !== undefined && firstOptional.length > 0) {
			firstOptional = firstOptional.slice(1, -1);
			firstOptional = ', ' + firstOptional;
		} else {
			firstOptional = '';
		}

		let s = cite.format('citation', { template: style });
		s = s.replace(/(\(|\))/gi, '');

		let array = s.split(';').map(part => {
			part.trim();
			return part.replace(/(,)?(\s*\d+)/, '$2');
		});
		array = array.map(part => part.replace(/(\d+)/, '($1') + ')');
		s = array.join('; ');
		s = s.slice(0, -1) + firstOptional + ')';
		return s;
	}

	// type === 'p'
	let s = cite.format('citation', { template: style });
	let replacement = '';
	let firstText = '';
	if (firstOptional !== undefined) firstText = firstOptional.slice(1, -1);
	let secondText = '';
	if (secondOptional !== undefined) secondText = secondOptional.slice(1, -1);

	if (firstText.length > 0 && secondOptional === undefined) {
		const close = s.slice(-1);
		replacement = s.slice(0, -1) + ', ' + firstText + close;
	} else if (firstText.length > 0 && secondText.length === 0) {
		const open = s.slice(0, 1);
		replacement = open + firstText + ' ' + s.slice(1);
	} else if (firstText.length === 0 && secondText.length > 0) {
		const close = s.slice(-1);
		replacement = s.slice(0, -1) + ', ' + secondText + close;
	} else if (firstText.length > 0 && secondText.length > 0) {
		const open = s.slice(0, 1);
		const close = s.slice(-1);
		replacement = open + firstText + ' ' + s.slice(1, -1) + ', ' + secondText + close;
	} else {
		replacement = s;
	}
	return replacement;
}

function bjps_processor(type, entries, firstOptional, secondOptional, style) {
	const cite = new Cite(entries);

	if (type === 't') {
		if (firstOptional !== undefined && firstOptional.length > 0) {
			firstOptional = firstOptional.slice(1, -1);
			firstOptional = ', ' + firstOptional;
		} else {
			firstOptional = '';
		}

		let s = cite.format('citation', { template: style });
		let array = s.slice(1).slice(0, -1).split(';').map(part => part.trim());
		array = array.map(part => part.replace(/(\[\d+)/, '($1') + ')');
		s = array.join('; ');
		s = s.slice(0, -1) + firstOptional + ')';
		return s;
	}

	// type === 'p' — identical optional-argument handling to the generic processor
	return generic_paren_processor(type, entries, firstOptional, secondOptional, style);
}

function inlineCitation(type, entries, firstOptional, secondOptional, style) {
	const fn = style === 'bjps' ? bjps_processor : generic_paren_processor;
	return fn(type, entries, firstOptional, secondOptional, style);
}

// --- Vancouver range collapsing (ported from Biblify) -------------------------

function vancouverString(indexes) {
	const ranges = [];
	let next = [];
	const queue = indexes.slice();
	while (queue.length > 0) {
		const n = queue.shift();
		if (next.length === 0) {
			next.push(n);
		} else if (n === next[next.length - 1] + 1) {
			next.push(n);
		} else {
			ranges.push(next);
			next = [n];
		}
	}
	ranges.push(next);

	const out = [];
	for (const range of ranges) {
		let str = `${range[0]}`;
		if (range.length === 2) str += `,${range[1]}`;
		else if (range.length > 2) str += `-${range[range.length - 1]}`;
		out.push(str);
	}
	return out.join(',');
}

// --- small helpers ------------------------------------------------------------

function escapeAttr(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function orderedSet() {
	const arr = [];
	const seen = new Set();
	return {
		add(k) { if (!seen.has(k)) { seen.add(k); arr.push(k); } },
		values() { return arr.slice(); },
		get size() { return arr.length; }
	};
}

function parseKeys(keyString) {
	return keyString.split(',').map(k => k.trim()).filter(Boolean);
}

// =============================================================================
//  Main entry point
// =============================================================================

export function resolveCitations($, options = {}) {
	if (!Cite) return;

	const appDir = configManager.get('Jmarkdown app directory');
	const baseDir = configManager.get('Markdown file directory') || process.cwd();
	const bibPathRaw = configManager.get('Biblify.bibliography') || '';
	let style = (configManager.get('Biblify.bibliography style') || 'chicago').trim();
	if (!style) style = 'chicago';
	const customTemplate = configManager.get('Biblify.template');
	const tooltips = !!configManager.get('Biblify.tooltips');
	const minimal = !!configManager.get('Biblify.minimal');
	const outBase = options.outBase || null;

	if (!bibPathRaw) {
		console.error('Resolve citations is on but no `Bibliography` file was given; leaving citations unresolved.');
		recoverPlaceholders($);
		return;
	}

	// Read + index the .bib file (path resolves relative to the source file).
	let bibContent;
	try {
		const resolved = path.isAbsolute(bibPathRaw) ? bibPathRaw : path.resolve(baseDir, bibPathRaw);
		bibContent = fs.readFileSync(resolved, 'utf8');
	} catch (e) {
		console.error(`Could not read bibliography file "${bibPathRaw}": ${e.message}`);
		recoverPlaceholders($);
		return;
	}
	const bibfileMap = processBibfile(bibContent);

	registerTemplates(appDir, customTemplate, baseDir, style);

	const ctx = {
		bibfileMap,
		defaultStyle: style,
		tooltips,
		minimal,
		outBase,
		refCache: {}
	};

	if (style === 'vancouver') {
		resolveVancouver($, ctx);
	} else {
		resolveInline($, ctx);
		buildBibliographies($, ctx);
	}

	if (tooltips) addTooltips($, ctx);
	if (minimal) exportMinimalBib($, ctx);

	// Remove the invisible \nocite markers now that bibliographies and the
	// minimal export have consumed them.
	$('.biblify-nocite').remove();

	injectCss($, options.fragment, style);
}

// Fallback: if we can't resolve, turn placeholders back into their literal
// commands so the document isn't left full of empty spans.
function recoverPlaceholders($) {
	$('span.biblify-cite').each((i, el) => {
		const cmd = $(el).attr('data-cite-cmd') || '';
		$(el).replaceWith(document_text(cmd));
	});
	$('div.biblify-bibliography').remove();
}

function document_text(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

// --- Pass 1: resolve each inline citation placeholder -------------------------

function resolveInline($, ctx) {
	// Pre-compute, for each cite, the style of the bibliography that will list it
	// (the nearest following non-`all` ::Bibliography), so per-section style
	// switching renders inline citations in that section's style.
	const nodes = $('span.biblify-cite, div.biblify-bibliography').toArray();
	let nextStyle = ctx.defaultStyle;
	const styleFor = new Map();
	for (let i = nodes.length - 1; i >= 0; i--) {
		const $n = $(nodes[i]);
		if ($n.is('div.biblify-bibliography')) {
			if ($n.attr('data-all') !== 'true') {
				nextStyle = ($n.attr('data-style') || ctx.defaultStyle);
			}
		} else {
			styleFor.set(nodes[i], nextStyle);
		}
	}

	$('span.biblify-cite').each((i, el) => {
		const style = styleFor.get(el) || ctx.defaultStyle;
		resolveOne($, el, ctx, style);
	});
}

function resolveOne($, el, ctx, style) {
	const $el = $(el);
	const cmd = $el.attr('data-cite-cmd') || '';
	const m = CITE_RE.exec(cmd);
	if (!m) { $el.replaceWith(document_text(cmd)); return; }

	const fullcite = m[1] !== undefined;
	const nocite = m[2] !== undefined;
	const citeAuthors = m[3] !== undefined;
	let type = m[4] || 't';
	const isStarred = m[5] !== undefined;
	const firstOptional = m[6];
	const secondOptional = m[7];
	const keyString = m[8];
	const keys = parseKeys(keyString);
	const entries = getEntries(keys, ctx.bibfileMap);

	if (fullcite) {
		// Render the full bibliography entry inline (members of the "all" set only).
		if (entries.length === 0) { $el.remove(); return; }
		const html = new Cite(entries).format('bibliography', {
			format: 'html', template: style, lang: 'en-US'
		});
		const $out = $(html);
		$out.addClass(`biblify-${style}-template`);
		$out.attr('data-bibtex', keyString);
		$out.attr('data-bib-member', 'all');
		$el.replaceWith($out);
		return;
	}

	if (nocite) {
		// Suppress the inline citation, but keep an invisible marker so the entry
		// is still collected into the bibliography (and minimal export).
		$el.replaceWith(
			`<span class="biblify-nocite" data-bibtex="${escapeAttr(keyString)}" data-bib-member="section" hidden></span>`
		);
		return;
	}

	if (citeAuthors) {
		if (entries.length === 0) { $el.remove(); return; }
		const names = getFullNamesFromCitation(new Cite(entries), isStarred);
		$el.replaceWith(
			`<span class="biblify-cite-author" data-bibtex="${escapeAttr(keyString)}" data-bib-member="all">${names}</span>`
		);
		return;
	}

	// Normal \cite / \citet / \citep
	if (entries.length === 0) { $el.replaceWith(document_text(cmd)); return; }
	const replacement = inlineCitation(type, entries, firstOptional, secondOptional, style);
	$el.replaceWith(
		`<span class="biblify-cite-ref" data-bibtex="${escapeAttr(keyString)}" data-bib-member="section">${replacement}</span>`
	);
}

// --- Pass 2: assemble each ::Bibliography ------------------------------------

function buildBibliographies($, ctx) {
	const nodes = $('span[data-bibtex], div[data-bibtex], div.biblify-bibliography').toArray();
	let pending = orderedSet();
	const all = orderedSet();

	for (const node of nodes) {
		const $n = $(node);
		if ($n.is('div.biblify-bibliography')) {
			const bibStyle = $n.attr('data-style') || ctx.defaultStyle;
			const isAll = $n.attr('data-all') === 'true';
			const scope = $n.attr('data-scope');
			let keys;
			if (scope) keys = collectScope($, scope);
			else if (isAll) keys = all.values();
			else keys = pending.values();
			renderBibliography($, $n, keys, bibStyle, ctx);
			if (!isAll && !scope) pending = orderedSet();
		} else {
			const member = $n.attr('data-bib-member');
			const keys = parseKeys($n.attr('data-bibtex') || '');
			keys.forEach(k => all.add(k));
			if (member === 'section') keys.forEach(k => pending.add(k));
		}
	}
}

function collectScope($, scope) {
	const set = orderedSet();
	$(scope).find('[data-bibtex]').each((i, el) => {
		if ($(el).attr('data-bib-member') === 'section') {
			parseKeys($(el).attr('data-bibtex') || '').forEach(k => set.add(k));
		}
	});
	return set.values();
}

// Swap a bibliography placeholder for its rendered list, prepending the optional
// `{title="…"}` heading. Mirrors ::Index's data-title → <h2 class="index-title">
// in indexing.js, so both placement markers label their output the same way.
// Note the callers below drop the placeholder entirely when a bibliography would
// be empty — so an empty list never leaves a stranded heading behind.
function replaceBibPlaceholder($, $placeholder, $out) {
	const title = $placeholder.attr('data-title');
	if (title) {
		// .text() escapes; the title is author prose, not markup.
		$placeholder.before($('<h2 class="bibliography-title"></h2>').text(title));
	}
	$placeholder.replaceWith($out);
}

function renderBibliography($, $placeholder, keys, style, ctx) {
	if (!keys.length) { $placeholder.remove(); return; }
	const entries = keys.map(k => ctx.bibfileMap[k]).filter(Boolean);
	if (entries.length === 0) { $placeholder.remove(); return; }
	const html = new Cite(entries).format('bibliography', {
		format: 'html', template: style, lang: 'en-US'
	});
	const $out = $(html);
	$out.addClass(`biblify-${style}-template`);
	replaceBibPlaceholder($, $placeholder, $out);
}

// --- Vancouver (numeric) — whole-document path -------------------------------

function resolveVancouver($, ctx) {
	const placeholders = $('span.biblify-cite').toArray();

	// 1. Collect unique keys in first-appearance order.
	const orderedKeys = [];
	const seen = new Set();
	for (const el of placeholders) {
		const m = CITE_RE.exec($(el).attr('data-cite-cmd') || '');
		if (!m) continue;
		for (const k of parseKeys(m[8])) {
			if (!seen.has(k)) { seen.add(k); orderedKeys.push(k); }
		}
	}

	const entries = orderedKeys.map(k => ctx.bibfileMap[k]).filter(Boolean);
	if (entries.length === 0) {
		$('div.biblify-bibliography').remove();
		recoverPlaceholders($);
		return;
	}

	// 2. Build the numbered bibliography and remember each key's number.
	const bibHtml = new Cite(entries).format('bibliography', {
		format: 'html', template: 'vancouver', lang: 'en-US'
	});
	const $bib = $(bibHtml);
	$bib.addClass('biblify-vancouver-template');
	$bib.find('.csl-left-margin').each((i, el) => {
		const h = ($(el).html() || '').split('.');
		$(el).html(`[${h[0]}]`);
	});

	const keyIndexMap = {};
	$bib.find('[data-csl-entry-id]').each((i, el) => {
		const id = $(el).attr('data-csl-entry-id');
		const lm = $(el).find('.csl-left-margin').html() || '';
		const mt = lm.match(/\[([0-9]+)\]/);
		if (mt) keyIndexMap[id] = parseInt(mt[1], 10);
	});

	const bibTargets = $('div.biblify-bibliography').toArray();
	if (bibTargets.length === 0) {
		// No ::Bibliography directive — still number the inline citations.
	} else {
		bibTargets.forEach(bt => replaceBibPlaceholder($, $(bt), $bib.clone()));
	}

	// 3. Replace each inline placeholder with its collapsed numeric reference.
	for (const el of placeholders) {
		const m = CITE_RE.exec($(el).attr('data-cite-cmd') || '');
		if (!m) { $(el).remove(); continue; }
		const keys = parseKeys(m[8]);
		const keyString = keys.join(',');
		const indexes = keys.map(k => keyIndexMap[k]).filter(n => n !== undefined);
		const sorted = Array.from(new Set(indexes)).sort((a, b) => a - b);
		const str = vancouverString(sorted);
		$(el).replaceWith(
			`<span class="biblify-vancouver" data-bibtex="${escapeAttr(keyString)}">[${str}]</span>`
		);
	}
}

// --- tooltips -----------------------------------------------------------------

function refHtmlForKey($, key, ctx) {
	if (key in ctx.refCache) return ctx.refCache[key];
	const entry = ctx.bibfileMap[key];
	if (!entry) { ctx.refCache[key] = ''; return ''; }
	let inner = '';
	try {
		const html = new Cite([entry]).format('bibliography', {
			format: 'html', template: ctx.defaultStyle === 'vancouver' ? 'chicago' : ctx.defaultStyle, lang: 'en-US'
		});
		inner = $(html).find('.csl-entry').first().html() || '';
	} catch (e) {
		inner = '';
	}
	ctx.refCache[key] = inner;
	return inner;
}

function addTooltips($, ctx) {
	$('span[data-bibtex]').each((i, el) => {
		const $el = $(el);
		if ($el.hasClass('biblify-nocite')) return;
		if ($el.closest('.csl-bib-body').length) return;
		const keys = parseKeys($el.attr('data-bibtex') || '');
		const refs = keys.map(k => refHtmlForKey($, k, ctx)).filter(Boolean).join('<br>');
		if (!refs) return;
		const inner = $el.html();
		$el.addClass('biblify-tooltip-host');
		$el.html(`${inner}<span class="biblify-tooltip" role="tooltip">${refs}</span>`);
	});
}

// --- minimal .bib export ------------------------------------------------------

function exportMinimalBib($, ctx) {
	if (!ctx.outBase) {
		console.error('Minimal bibliography requested but output is going to stdout; skipping export.');
		return;
	}
	const set = orderedSet();
	$('[data-bibtex]').each((i, el) => {
		parseKeys($(el).attr('data-bibtex') || '').forEach(k => set.add(k));
	});
	const entries = set.values().map(k => ctx.bibfileMap[k]).filter(Boolean);
	if (entries.length === 0) return;
	const outPath = ctx.outBase.replace(/\.[^./]+$/, '') + '.cited.bib';
	try {
		fs.writeFileSync(outPath, entries.join('\n\n') + '\n');
	} catch (e) {
		console.error(`Could not write minimal bibliography to ${outPath}: ${e.message}`);
	}
}

// --- CSS injection ------------------------------------------------------------

function injectCss($, fragment, style) {
	const css = `
/* JMarkdown compile-time citations */
div.csl-bib-body { line-height: 1.4; }
div.csl-bib-body div.csl-entry { margin-bottom: 6pt; }
span.biblify-vancouver { font-weight: bold; vertical-align: super; }
div.biblify-vancouver-template div.csl-entry {
	display: grid;
	grid-template-columns: 18pt 1fr;
	column-gap: 8pt;
}
div.biblify-vancouver-template div.csl-entry div.csl-right-inline { width: auto; }
span.biblify-tooltip-host { position: relative; cursor: help; border-bottom: 1px dashed gray; }
span.biblify-tooltip-host > span.biblify-tooltip {
	display: none;
	position: absolute;
	left: 0;
	top: 1.4em;
	z-index: 50;
	width: max-content;
	max-width: 32em;
	padding: 6pt 8pt;
	background: #fff;
	border: 1px solid #999;
	border-radius: 4px;
	box-shadow: 0 2px 8px rgba(0,0,0,0.15);
	font-weight: normal;
	font-size: 0.85em;
	white-space: normal;
}
span.biblify-tooltip-host:hover > span.biblify-tooltip { display: block; }
`;
	const $style = $(`<style>${css}</style>`);
	if (!fragment && $('head').length) {
		$('head').append($style);
	} else {
		// Fragment mode: no <head>; prepend the style to the root.
		$.root().prepend($style);
	}
}
