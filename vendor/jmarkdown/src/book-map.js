/*
	The book map: every label of a build, with the number its references print,
	read off the DOM after the post-processor's one numbering pass (crossref.js
	holds the table). Asked for with processFile's `bookMap: true` or the CLI's
	`--book-map`; returned by processFile and written beside the output as
	`<output without extension>-bookmap.json`. Off, nothing is computed or
	written, and the build is untouched.

	Its shape is Clew's own book map's (its live numbering for a chapter edited
	alone), field for field, so Clew's parity scenario can hold the two against
	each other:

	  { "numbering": "per chapter" | "continuous" | null,
	    "labels": { "<label>": { "number": "2.3" | null, "type", "kind",
	                             "file", "line", "id" } } }

	  number  what @ref prints; null where it prints ??
	  type    the word @cref takes ('figure', 'theorem', 'section', …), or null
	  kind    the construct: its environment's name ('figure', 'lemma',
	          'exercise', …), 'heading', 'footnote', or 'plain'
	  file    the chapter's path as it was handed in (`chapters`, @chapter+);
	          the master's own name for its own text
	  line    the line in that file (1-based), where the build stamped one
	  id      the anchor a reference links to

	HTML only: in LaTeX, LaTeX numbers everything, so a LaTeX build writes none
	(and says so).
*/

import fs from 'fs';
import path from 'path';
import { configManager } from './config-manager.js';
import { addWarning } from './warnings.js';
import { labelEntries } from './crossref.js';
import { getBook } from './book.js';

let map = null;

/** Whether this build was asked for a book map. */
export function bookMapWanted() {
	return configManager.get('Book map') === true;
}

/** The map this build made, or null. */
export function getBookMap() { return map; }

/** Forget the last build's map (called as a build starts). */
export function resetBookMap() { map = null; }

// The construct a label belongs to (see above).
function kindOf($, $el) {
	if ($el.closest('li[id^="footnote-"], li[id^="fn-"]').length) return 'footnote';
	const $host = $el.closest('[data-xref-number]');
	if ($host.length) return $host.attr('data-jmd-kind') || $host.attr('data-xref-type') || 'plain';
	if ($el.is(':header') || $el.closest(':header').length) return 'heading';
	return 'plain';
}

// The source line a label stands on. A note's list sits at its chapter's end,
// unstamped, so a label inside a note takes the line of the note's reference
// in the text, which is where the author wrote it.
function lineOf($, $el) {
	const stamped = (node) => Number(node.closest('[data-source-line]').attr('data-source-line')) || null;
	const $note = $el.closest('li[id^="footnote-"], li[id^="fn-"]');
	if ($note.length) {
		const $ref = $(`[href="#${$note.attr('id')}"]`).first();
		if ($ref.length) return stamped($ref);
	}
	return stamped($el);
}

/**
 * Build the map from the DOM ($), after the cross-references are resolved,
 * and write it beside the output. Called by the post-processor when wanted.
 */
export function makeBookMap($) {
	const book = getBook();
	const master = path.basename(String(global.current_file || ''));
	const labels = {};
	for (const [key, info] of labelEntries()) {
		const id = info?.anchor ?? null;
		const $el = id ? $(`[id="${String(id).replace(/"/g, '\\"')}"]`).first() : null;
		const found = $el && $el.length;
		const $section = found ? $el.closest('section.jmd-chapter') : null;
		const line = found ? lineOf($, $el) : null;
		const number = info?.number !== undefined && info?.number !== null && String(info.number) !== '' ? String(info.number) : null;
		labels[key] = {
			number,
			type: info?.type ?? null,
			kind: found ? kindOf($, $el) : 'plain',
			file: $section && $section.length ? $section.attr('data-file') : master,
			line,
			id,
		};
	}
	map = { numbering: book ? book.numbering : null, labels };
	const out = configManager.get('Output file');
	if (out) {
		fs.writeFileSync(`${out.replace(/\.[^./\\]+$/, '')}-bookmap.json`, `${JSON.stringify(map, null, '\t')}\n`);
	} else {
		addWarning('book map: there is no output file to write it beside (stdout) — processFile still returns it');
	}
	return map;
}

/** A LaTeX build asked for a map: say why there is none. */
export function warnNoLatexBookMap() {
	addWarning('book map: a LaTeX build writes none — LaTeX numbers the book itself; build the HTML for the map');
}
