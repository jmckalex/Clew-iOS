/*
	`Run note code` — ONE switch over every path by which a DOCUMENT makes the
	engine run code while it builds.

	A JMarkdown document can run JavaScript in the build process (script
	blocks, function calls in prose, `math.…(` expressions, `function(…)`
	blocks), load and run files next to it (the `Load javascript`, `Load
	extensions`, `Load directives` and `Load environments` header keys), define
	tokenizers from its own header (`Extension …` keys), and hand Wolfram
	Language to wolframscript (Mathematica blocks and ⟦…⟧). For an author
	building their own documents that is the point. For a host rendering
	documents it did not write — Clew, opening a vault someone sent — it means
	the first render of a note runs that note's code with the host's rights.

	So a host sets `"Run note code": false` in its config, and each of those
	paths then REFUSES BY NAME, in place: a visible `jmd-refused` marker in
	HTML (`data-jmd-refused` carries the name, so a host can tell the reader
	what was held back and offer to trust the document), nothing in LaTeX, and
	a build warning either way. The default is true — today's behaviour — so
	the CLI and the book builds are unchanged.

	The switch lives in CONFIG only. A metadata header can never set it
	(config-manager.js drops the key), or a document could switch its own code
	back on.

	What this does NOT cover: the external programs the engine runs over a
	document's content (lualatex for a TiKZ picture, mpost, mmdc, ffmpeg).
	TeX is a programming language too, so what those programs may do with
	their input is a real question — but it is theirs to restrict (their own
	flags and sandboxes), and a separate one from this switch. Nor does it
	cover `<script>` a document passes through to its HTML, which runs in
	whatever displays the page — the host's business, not the build's.
*/

import { configManager } from './config-manager.js';
import { addWarning } from './warnings.js';

export function noteCodeAllowed() {
	return configManager.get('Run note code') !== false;
}

const escapeHTML = (s) => String(s)
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The marker that stands where the code's output would have been. `block`
// for a construct that is a block of its own (a script block, a Mathematica
// container), inline otherwise.
export function refuseNoteCode(name, { block = false } = {}) {
	addWarning(`${name} not run — "Run note code" is off`);
	if (global.isLatex) return '';
	const label = escapeHTML(name);
	const tag = block ? 'div' : 'span';
	return `<${tag} class="jmd-error jmd-refused" data-jmd-refused="${label}">[${label} not run: note code is off]</${tag}>${block ? '\n' : ''}`;
}

// The marker that stands where a document's code RAN AND THREW. A note's
// broken function is the note's problem, not the build's: the error is shown
// in place and the rest of the document still renders — what a script
// block's parse error has always done. Same shape as a refusal (a `jmd-error`
// span or div, nothing in LaTeX, a build warning either way), with
// `data-jmd-error` naming the construct.
export function noteCodeError(name, error, { block = false } = {}) {
	const message = error?.message ?? String(error);
	addWarning(`${name} failed: ${message}`);
	if (global.isLatex) return '';
	const label = escapeHTML(name);
	const tag = block ? 'div' : 'span';
	return `<${tag} class="jmd-error" data-jmd-error="${label}">[${label} failed: ${escapeHTML(message)}]</${tag}>${block ? '\n' : ''}`;
}

// Header keys have no place in the body to stand in, so their markers are
// collected while the header is read and placed at the top of the body
// (index.js), the way `Math macros` places its block.
let headerRefusals = [];

export function resetHeaderRefusals() {
	headerRefusals = [];
}

export function refuseHeaderKey(name) {
	headerRefusals.push(refuseNoteCode(name, { block: true }));
}

export function headerRefusalsHTML() {
	return headerRefusals.join('');
}
