/*
	Cross-reference registry — the HTML side.

	The LaTeX path emits native \label/\ref (see the :label/:ref directives) and
	lets the engine number and resolve everything, so it never uses this module.
	HTML has no such machinery, so the post-processor builds this table during its
	pass: each :label records the number / anchor of the thing it marks, and each
	:ref is resolved against it. Forward references work because the whole document
	is already in the DOM before resolution runs.

	State is module-level but is RESET per document build via resetCrossrefs()
	(called at the top of postProcessHTML), which closes the long-standing
	"crossrefs never resets between runs" bug — important once a single process
	builds more than one document (library use, multi-file books).
*/

import { addWarning } from './warnings.js';

let labels = {};

// Discard all recorded labels. Call once at the start of each document build.
export function resetCrossrefs() {
	labels = {};
}

// Record a labelled target.
//   key     the label name (e.g. 'sec:intro')
//   info    { number, anchor, type? }
//             number  resolved number text (e.g. '3' or '2.1')
//             anchor  the element id a :ref should link to
//             type    the kind of target ('section', 'figure', …) — used by the
//                     typed :cref/:Cref form
export function recordLabel(key, info) {
	// A duplicate is almost always an author mistake (copy-pasted :label), and
	// silently letting the later definition win sends every :ref to the wrong
	// target. Keep the overwrite (it matches LaTeX, where the last \label wins
	// after a "multiply defined" warning) but say so.
	if (Object.prototype.hasOwnProperty.call(labels, key)) {
		addWarning(`duplicate label '${key}' — the later definition replaces the earlier one`);
	}
	labels[key] = info;
}

// Look up a recorded target, or undefined if the key is unknown.
export function lookupLabel(key) {
	return labels[key];
}

// The word a typed (:cref/:Cref) reference uses for each target type. Identity
// for most; extend as new counter types arrive (figure/table/theorem already map
// to themselves). LaTeX's cleveref produces the equivalent words natively.
const TYPE_NAMES = {
	part: 'part', chapter: 'chapter', section: 'section', subsection: 'subsection',
	subsubsection: 'subsubsection', paragraph: 'paragraph', subparagraph: 'subparagraph',
	figure: 'figure', table: 'table', equation: 'equation', listing: 'listing',
	footnote: 'footnote',
	theorem: 'theorem', lemma: 'lemma', corollary: 'corollary',
	proposition: 'proposition', definition: 'definition', example: 'example',
	remark: 'remark'
};

// Format a cleveref-style typed reference, e.g. ('section', '3') -> 'section 3',
// capitalized -> 'Section 3'. The &#160; non-breaking space keeps the word and
// number on one line (cleveref uses ~ for the same reason); this output is HTML
// only — LaTeX uses \cref, which spaces natively. Falls back to the bare number
// when the type is unknown.
export function typedRefText(type, number, capitalized = false) {
	let name = TYPE_NAMES[type] || type || '';
	if (capitalized && name) name = name.charAt(0).toUpperCase() + name.slice(1);
	// Equations are referenced with a parenthesised number ("equation (2)"),
	// matching cleveref's convention; everything else is a bare number.
	const num = type === 'equation' ? `(${number})` : number;
	return name ? `${name}&#160;${num}` : `${num}`;
}
