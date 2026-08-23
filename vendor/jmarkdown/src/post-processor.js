/*
	This file contains all the code for post-processing the HTML constructed
	by the call to marked.parse().  
*/

import * as cheerio from 'cheerio';
export { cheerio };
import { configManager } from './config-manager.js';
import { replaceTargetsBySources } from './sources-and-targets.js';
import { resolveCitations } from './biblify-compile.js';
import { resetCrossrefs, recordLabel, lookupLabel, typedRefText } from './crossref.js';
import { addWarning } from './warnings.js';
import { buildIndexes } from './indexing.js';
import { getNumberedSpecs } from './numbered-environments.js';
import { commandForDepth } from './sectioning.js';

// A :ref/:cref that can't produce a number renders '??' (mirroring LaTeX's
// undefined-reference mark) — but '??' deep in a long document is easy to
// miss, so also record a warning for the end-of-build summary. The two
// failure modes get distinct messages: no such label at all, vs. a label
// whose target carries no number (e.g. headings without `Headings: numeric`).
function warnUnresolvedRef(key, info) {
	addWarning(info
		? `reference '${key}' resolved to a target with no number (is heading numbering off?)`
		: `unresolved reference '${key}' — no matching :label`);
}

// Post-process HTML output using cheerio
export function postProcessHTML(html, options = {}) {
	// Load into cheerio — in fragment mode, pass isDocument=false to prevent
	// cheerio wrapping the content in <html><head><body> tags.
	const $ = cheerio.load(html, null, !options.fragment);

	// Find all our marker spans
	$('span.marker-to-remove').each((i, elem) => {
		const $elem = $(elem);
		const classes = $elem.attr('data-add-classes');
		const id = $elem.attr('data-add-id');

	    // Add classes and id to parent
		const $parent = $elem.parent();
		if (classes) {
			$parent.addClass(classes);
		}
		if (id) {
			$parent.attr('id', id);
		}

	    // Remove the marker span
		$elem.remove();
	});

	resetCrossrefs();
	figureList = [];
	tableList = [];
	listingList = [];
	if (configManager.get("Headings") && configManager.get("Headings")[0] == "numeric") {
		add_labels_to_headers($);
	}
	number_figures($);
	number_tables($);
	number_listings($);
	number_theorems($);
	number_equations($);
	number_environments($);
	process_crossrefs($);
	replace_float_lists($);
	// Back-of-book index: AFTER heading numbering (locators read the
	// header-label spans) — collects :index marks, replaces ::Index divs.
	buildIndexes($);
	strip_matter_markers($);
	replaceTargetsBySources($);

	// Resolve compile-time citations (\cite-family commands + ::Bibliography),
	// when enabled. HTML only — LaTeX output is handled natively by natbib and
	// never reaches the post-processor.
	if (configManager.get('Biblify.resolve') && !global.isLatex) {
		resolveCitations($, { fragment: !!options.fragment, outBase: options.outBase });
	}

	// Only hoist styles to <head> in full-document mode; in fragment mode there's no <head>.
	if (!options.fragment) {
		moveBodyStylesToHead($);
	}
	return $.html();
}

// Add numeric headings, if requested.  (Right now, this is only supported if the
// metadata header has 'Headings: numeric')
function add_labels_to_headers($) {
	let [h1,h2,h3,h4,h5,h6] = [0,0,0,0,0,0];

	$('div.toc').addClass('numeric');

	$(":header").each((i, elem) => {
		let $elem = $(elem);
		switch($elem.prop('tagName')) {
		case "H1":
			$(elem).prepend(`<span class='header-label h1-label xref'>${++h1}.</span> `);
			h2 = 0;
			break;
		case "H2":
			$(elem).prepend(`<span class='header-label h2-label xref'>${h1}.${++h2}.</span> `);
			h3 = 0;
			break;
		case "H3":
			$(elem).prepend(`<span class='header-label h3-label xref'>${h1}.${h2}.${++h3}.</span> `);
			h4 = 0;
			break;
		case "H4":
			$(elem).prepend(`<span class='header-label h4-label xref'>${h1}.${h2}.${h3}.${++h4}.</span> `);
			h5 = 0;
			break;
		case "H5":
			$(elem).prepend(`<span class='header-label h5-label xref'>${h1}.${h2}.${h3}.${h4}.${++h5}.</span> `);
			h6 = 0;
			break;
		case "H6":
			$(elem).prepend(`<span class='header-label h6-label xref'>${h1}.${h2}.${h3}.${h4}.${h5}.${++h6}.</span> `);
			break;
		}
		// Now update the TOC, if it exists.
		let id = $elem.attr('id');
		let $toc = $(`[data-id='${id}']`);
		if ($toc.length > 0) {
			$toc.html($elem.html());
		}
		let html = $elem.html();
		html = `<a href='#toc'>${html}</a>`;
		$elem.html(html);
	})
}

// Ordered caption text + anchor for each figure / table / listing, collected
// during numbering and consumed by replace_float_lists to build {{LOF}} /
// {{LOT}} / {{LOL}}. Reset per run in postProcessHTML.
let figureList = [];
let tableList = [];
let listingList = [];

// Replace {{LOF}} / {{LOT}} / {{LOL}} paragraphs with a list of figures /
// tables / listings, each entry linking to its float. LaTeX uses
// \listoffigures/\listoftables/\listoflistings instead (handled in the parse
// hook), so this is HTML-only.
function replace_float_lists($) {
	const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
	const build = (items, cls) => {
		const lis = items.map(it => it.anchor
			? `<li><a href="#${it.anchor}">${esc(it.text)}</a></li>`
			: `<li>${esc(it.text)}</li>`).join('\n');
		return `<nav class="${cls}"><ul>\n${lis}\n</ul></nav>`;
	};
	$('p').each((i, el) => {
		const t = $(el).text().trim();
		if (t === '{{LOF}}') $(el).replaceWith(build(figureList, 'list-of-figures'));
		else if (t === '{{LOT}}') $(el).replaceWith(build(tableList, 'list-of-tables'));
		else if (t === '{{LOL}}') $(el).replaceWith(build(listingList, 'list-of-listings'));
	});
}

// Matter/appendix markers are LaTeX book-structure commands (handled in the parse
// hook for LaTeX). HTML has no equivalent, so just drop the marker paragraphs.
// (HTML appendix lettering — headings A, B… after {{appendix}} — is not yet
// implemented; the marker simply vanishes.)
function strip_matter_markers($) {
	const markers = ['{{frontmatter}}', '{{mainmatter}}', '{{backmatter}}', '{{appendix}}'];
	$('p').each((i, el) => {
		if (markers.includes($(el).text().trim())) $(el).remove();
	});
}

// Number figure floats (@begin(figure), see floats.js) in document order: prefix
// each caption with "Figure N:" and record the figure's id in the cross-ref
// registry so :ref/:cref resolve. LaTeX numbers figures natively, so this is
// HTML-only (the post-processor never runs for LaTeX). Always on — a float is
// numbered by definition, independent of the Headings: numeric heading option.
function number_figures($) {
	let n = 0;
	$('figure.figure').each((i, elem) => {
		const $fig = $(elem);
		n++;
		const id = $fig.attr('id');

		// Sub-number any subfigures: (a), (b), … with combined refs like "1a".
		let sub = 0;
		$fig.children('figure.subfigure').each((j, subelem) => {
			const $sub = $(subelem);
			const letter = String.fromCharCode(97 + sub);
			sub++;
			const subId = $sub.attr('id');
			$sub.attr('data-xref-number', `${n}${letter}`).attr('data-xref-type', 'figure');
			$sub.children('figcaption').first()
				.prepend(`<span class="subfigure-label">(${letter})</span> `);
			if (subId) {
				recordLabel(subId, { number: `${n}${letter}`, type: 'figure', anchor: subId });
			}
		});

		// Number the parent figure (its own direct figcaption) + collect for LOF.
		// The data-xref-number/-type stamp lets a :label INSIDE the construct
		// adopt its number (see the xref-label pass).
		$fig.attr('data-xref-number', `${n}`).attr('data-xref-type', 'figure');
		const $cap = $fig.children('figcaption').first();
		$cap.prepend(`<span class="figure-label xref">Figure ${n}:</span> `);
		figureList.push({ text: $cap.text(), anchor: id });
		if (id) {
			recordLabel(id, { number: `${n}`, type: 'figure', anchor: id });
		}
	});
}

// Number table floats (@begin(table), see floats.js) in document order, with a
// counter independent of figures: prefix each caption with "Table N:" and record
// the id for :ref/:cref. HTML-only (LaTeX numbers tables natively).
function number_tables($) {
	let n = 0;
	$('figure.table-float').each((i, elem) => {
		const $tab = $(elem);
		n++;
		const id = $tab.attr('id');
		$tab.attr('data-xref-number', `${n}`).attr('data-xref-type', 'table');
		const $cap = $tab.children('figcaption').first();
		$cap.prepend(`<span class="table-label xref">Table ${n}:</span> `);
		tableList.push({ text: $cap.text(), anchor: id });
		if (id) {
			recordLabel(id, { number: `${n}`, type: 'table', anchor: id });
		}
	});
}

// Number code-listing floats (@begin(listing), see floats.js) in document order
// with their own counter: prefix each caption with "Listing N:" and record the
// id for :ref/:cref. HTML-only (LaTeX numbers listings natively via minted).
function number_listings($) {
	let n = 0;
	$('figure.listing').each((i, elem) => {
		const $lst = $(elem);
		n++;
		const id = $lst.attr('id');
		$lst.attr('data-xref-number', `${n}`).attr('data-xref-type', 'listing');
		const $cap = $lst.children('figcaption').first();
		$cap.prepend(`<span class="listing-label xref">Listing ${n}:</span> `);
		listingList.push({ text: $cap.text(), anchor: id });
		if (id) {
			recordLabel(id, { number: `${n}`, type: 'listing', anchor: id });
		}
	});
}

// Number theorem-like environments (@begin(theorem|lemma|…), see theorems.js)
// with ONE shared sequential counter (Theorem 1, Lemma 2, Definition 3, …), in
// document order, and record each for :ref/:cref. The reference WORD still comes
// from the kind ("lemma 2"), matching the LaTeX thmtools+cleveref setup. The
// label runs into the first paragraph ("Theorem 1 (name). …"), amsthm-style.
// proof environments are labelled "Proof." (unnumbered) and get a QED mark.
// HTML-only — LaTeX numbers theorems natively.
function number_theorems($) {
	const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
	const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

	let n = 0;
	$('.theorem-env').each((i, elem) => {
		const $env = $(elem);
		n++;
		const kind = $env.attr('data-kind') || 'theorem';
		const name = $env.attr('data-name');
		const id = $env.attr('id');
		$env.attr('data-xref-number', `${n}`).attr('data-xref-type', kind);
		let text = `${cap(kind)} ${n}`;
		if (name) text += ` (${esc(name)})`;
		text += '.';
		const labelHtml = `<span class="theorem-label">${text}</span> `;
		const $firstP = $env.children('p').first();
		if ($firstP.length) $firstP.prepend(labelHtml);
		else $env.prepend(labelHtml);
		if (id) {
			recordLabel(id, { number: `${n}`, type: kind, anchor: id });
		}
	});

	$('.proof-env').each((i, elem) => {
		const $p = $(elem);
		const labelHtml = `<span class="proof-label">Proof.</span> `;
		const $firstP = $p.children('p').first();
		if ($firstP.length) $firstP.prepend(labelHtml);
		else $p.prepend(labelHtml);
		$p.append('<span class="qed">&#8718;</span>');
	});
}

// Number user-defined numbered environments (defineEnvironment(..., {numbered:
// true}); see numbered-environments.js). The decorated HTML renderer wrapped
// each in a .jmd-env marker carrying its counter group, kind, optional name,
// and id. One document-order walk over all markers keeps a counter per group,
// so environments that share a `counter` interleave correctly (Exercise 1,
// Solution 2, Exercise 3). The number/label/cross-ref handling mirrors
// number_theorems exactly — including the data-xref-number/-type stamp that
// lets a :label inside the body adopt this number. LaTeX numbers these
// natively (thmtools), so this is HTML-only.
function number_environments($) {
	const specs = getNumberedSpecs();
	if (!specs.size) return;
	const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
	const counters = {};
	$('.jmd-env').each((i, elem) => {
		const $env = $(elem);
		const kind = $env.attr('data-jmd-kind');
		const spec = specs.get(kind);
		if (!spec) return;                          // marker without a live spec — skip
		const group = $env.attr('data-jmd-counter') || spec.counter;
		counters[group] = (counters[group] || 0) + 1;
		const n = counters[group];
		const name = $env.attr('data-jmd-name');
		const id = $env.attr('id');
		$env.attr('data-xref-number', `${n}`).attr('data-xref-type', spec.type);
		let text = `${spec.title} ${n}`;
		if (name) text += ` (${esc(name)})`;
		text += '.';
		const labelHtml = `<span class="env-label">${text}</span> `;
		// Prepend into the first paragraph (the author's box nests inside the
		// marker, so reach in with find), falling back to the marker itself.
		const $firstP = $env.find('p').first();
		if ($firstP.length) $firstP.prepend(labelHtml);
		else $env.prepend(labelHtml);
		if (id) {
			recordLabel(id, { number: `${n}`, type: spec.type, anchor: id });
		}
	});
}

// Number display equations (@begin(equation), see equations.js) in document
// order with their own counter: append "(N)" and record the id for :ref/:cref.
// HTML-only — LaTeX numbers equations natively. Numbers stay in step with LaTeX
// because both count the equations in order.
function number_equations($) {
	let n = 0;
	$('div.equation').each((i, elem) => {
		const $eq = $(elem);
		n++;
		const id = $eq.attr('id');
		$eq.attr('data-xref-number', `${n}`).attr('data-xref-type', 'equation');
		$eq.append(`<span class="eqn-number">(${n})</span>`);
		if (id) {
			recordLabel(id, { number: `${n}`, type: 'equation', anchor: id });
		}
	});
}

function process_crossrefs($) {
	// First pass: record every :label's number + anchor in the registry.
	$(".xref-label").each((i, elem) => {
		let $elem = $(elem);
		let key = $elem.attr('data-key');
		let anchor = $elem.attr('id');
		let number;
		let type;
		let in_footnote = $elem.closest('[id^="footnote-"]').length > 0 ? true : false;
		// A :label INSIDE a numbered construct (theorem, figure, table, listing,
		// equation — anything a numbering pass stamped data-xref-number on)
		// adopts that construct's number and type: the HTML twin of LaTeX's
		// \label inside an environment, which the LaTeX output supports
		// natively. Equivalent to labelling via the {id=…} attribute.
		const $host = $elem.closest('[data-xref-number]');
		if (in_footnote) {
			let $footnote = $elem.closest('[id^="footnote-"]');
			const $ol = $footnote.closest("ol");
			const $allItems = $ol.children('li');
			const currentIndex = $allItems.index($footnote);
			number = `${currentIndex+1}`;
			type = 'footnote';
		}
		else if ($host.length) {
			number = $host.attr('data-xref-number');
			type = $host.attr('data-xref-type');
		}
		else {
			// The nearest preceding .xref is the number span a numbered heading
			// prepends (see add_labels_to_headers). Needs Headings: numeric.
			// Type word for the typed :cref/:Cref form: a heading-anchored
			// label takes the sectioning word for its depth (section/
			// subsection/chapter…), honouring Heading base / Document class.
			let $xref = $elem.prevAll(".xref").first();
			number = $xref.text();
			const $heading = $elem.closest(':header');
			if ($heading.length) {
				const level = parseInt($heading.prop('tagName').slice(1), 10);
				type = commandForDepth(level);
			}
		}
		if (number != undefined && number.endsWith('.')) {
			number = number.slice(0, -1);
		}
		recordLabel(key, { number, anchor, type });
	});

	// Second pass: turn each :ref into a hyperlink carrying the number. An
	// unknown key renders as '??', mirroring LaTeX's own undefined-reference mark.
	$(".xref-ref").each((i, elem) => {
		let $elem = $(elem);
		let key = $elem.attr('data-key');
		let info = lookupLabel(key);
		if (info && info.number !== undefined && info.number !== '') {
			$elem.replaceWith(`<a class="xref-ref" href="#${info.anchor}">${info.number}</a>`);
		}
		else {
			$elem.text('??');
			warnUnresolvedRef(key, info);
		}
	});

	// Typed (cleveref-style) references: :cref -> "section 3", :Cref -> "Section 3".
	$(".xref-cref").each((i, elem) => {
		let $elem = $(elem);
		let key = $elem.attr('data-key');
		let cap = $elem.attr('data-cap') === '1';
		let info = lookupLabel(key);
		if (info && info.number !== undefined && info.number !== '') {
			$elem.replaceWith(`<a class="xref-cref" href="#${info.anchor}">${typedRefText(info.type, info.number, cap)}</a>`);
		}
		else {
			$elem.text('??');
			warnUnresolvedRef(key, info);
		}
	});
}

// When writing markdown, it's common to put <style> tags in the body.
// This moves all such tags to the <head> to be compliant with the HTML spec.
function moveBodyStylesToHead($) {
	const body_styles = $('body style').not('body svg style');
	if (body_styles.length > 0) {
		const styles = [];
		body_styles.each(function () {
			styles.push($(this));
			$(this).remove();
		});
		styles.forEach(style => {
			$('head').append(style);
		})
	}
}


import beautify from 'js-beautify';

export function beautifyHTML(html) {
	return beautify.html(html,
		{
			indent_size: 2,             // Number of spaces for indentation
			"css": {
				"end_with_newline": false
			},
			"js": {
				"end_with_newline": false
			},
			indent_char: ' ',           // Character to use for indent (usually space)
			max_preserve_newlines: 1,   // Maximum number of line breaks to preserve
			preserve_newlines: true,    // Whether to keep existing line breaks
			indent_inner_html: true,    // Indent <head> and <body> sections
			wrap_line_length: 0,        // Maximum line length (0 = no wrapping)
			wrap_attributes: 'auto',    // 'auto', 'force', 'force-aligned', 'force-expand-multiline'
			wrap_attributes_indent_size: 2, // Indent size for wrapped attributes
			unformatted: ['code', 'pre'], // Tags that shouldn't be reformatted
			content_unformatted: ['pre', 'code-display'], // Tags whose content shouldn't be reformatted
			extra_liners: [], // Tags that should have extra line breaks before them
			end_with_newline: true,     // End output with newline
			editorconfig: false,        // Use .editorconfig if present
			eol: '\n',                  // End of line character
			indent_scripts: 'normal'    // 'normal', 'keep', 'separate'
		});
}

import fs from 'fs';
import { postprocessor_scripts } from './script-blocks.js';
import { runInThisContext } from './utils.js';

export function runPostprocessScripts(html) {
	global.fs = fs;
	global.html = html;
	global.cheerio = cheerio;
	global.console = console;
	let configuration = `const $ = cheerio.load(html);`
	runInThisContext(configuration);
	for (let script of postprocessor_scripts) {
		runInThisContext(script);
	}
	return global.html;
}

