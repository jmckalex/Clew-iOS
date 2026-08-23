/*
	Preamble / package manager for LaTeX output.

	Features declare what they need at render time — e.g. the code renderer calls
	requirePackage('minted'), the link renderer requirePackage('hyperref') — and
	the assembler emits a complete, deduplicated preamble after the parse pass.
	Because registration is usage-driven, the preamble contains only the packages
	the document actually uses.

	This module is intentionally JMarkdown-agnostic: it knows nothing about
	configManager or global.isLatex. The caller (latex-template.js) feeds it the
	engine, the user-named Packages, and the user LaTeX preamble lines.
*/

// Insertion-ordered registry of required packages: name -> options string.
const requiredPackages = new Map();
// Arbitrary preamble snippets registered by features (e.g. \newenvironment).
const rawPreambleLines = [];
// Snippets that must follow the load-order-sensitive packages — specifically
// cleveref configuration (\crefname overrides). Emitted only when cleveref is
// actually loaded, right after it (and before the user preamble).
const latePreambleLines = [];

// A few packages are load-order sensitive and conventionally come near the end
// of the preamble (hyperref especially; cleveref must follow hyperref). They are
// emitted last, in this order, regardless of when they were requested.
const LATE_PACKAGES = ['hyperref', 'cleveref'];

// Declare that the document needs \usepackage[options]{name}. Idempotent: the
// first call fixes ordering; a later call may fill in options if none were set.
export function requirePackage(name, options = '') {
	if (!requiredPackages.has(name)) {
		requiredPackages.set(name, options);
	} else if (options && !requiredPackages.get(name)) {
		requiredPackages.set(name, options);
	}
}

// Register a verbatim preamble line (deduplicated).
export function addPreamble(line) {
	if (!rawPreambleLines.includes(line)) rawPreambleLines.push(line);
}

// Register a preamble line that must come AFTER the late packages (cleveref).
// Emitted only when cleveref is loaded — e.g. \crefname overrides, which are
// cleveref commands. Deduplicated.
export function addLatePreamble(line) {
	if (!latePreambleLines.includes(line)) latePreambleLines.push(line);
}

// Force cleveref to spell a reference type out in full ("figure 1"/"table 1"/
// "equation 1", not cleveref's abbreviated defaults), matching JMarkdown's HTML
// cross-ref wording. Only takes effect when cleveref is loaded.
export function crefName(type, singular, plural) {
	const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
	addLatePreamble(`\\crefname{${type}}{${singular}}{${plural}}`);
	addLatePreamble(`\\Crefname{${type}}{${cap(singular)}}{${cap(plural)}}`);
}

// Clear all registrations. Not needed for a normal single-document CLI run, but
// keeps tests and any future multi-document driver honest.
export function resetPreamble() {
	requiredPackages.clear();
	rawPreambleLines.length = 0;
	latePreambleLines.length = 0;
}

function usepackage(name, options) {
	return options ? `\\usepackage[${options}]{${name}}` : `\\usepackage{${name}}`;
}

function normaliseList(v) {
	if (v == null) return [];
	if (Array.isArray(v)) return v.filter(x => x != null && String(x).trim() !== '');
	const s = String(v).trim();
	return s ? [s] : [];
}

/*
	Assemble the full preamble string.

	  engine        'pdflatex' (default) | 'lualatex' | 'xelatex'
	  userPackages  array of package names from the `Packages` metadata key
	  userPreamble  array of verbatim lines from the `LaTeX preamble` metadata key

	Order: engine font/encoding defaults → feature & user packages (hyperref/
	cleveref forced last) → feature raw snippets → user raw preamble (last, so the
	author can always override).
*/
export function assemblePreamble({ engine = 'pdflatex', userPackages = [], userPreamble = [] } = {}) {
	const lines = [];
	const emitted = new Set();

	const emitPackage = (name, options = '') => {
		if (emitted.has(name)) return;
		emitted.add(name);
		lines.push(usepackage(name, options));
	};

	// Engine-dependent font/encoding defaults. pdflatex needs inputenc/fontenc;
	// the Unicode engines use fontspec instead and must NOT load inputenc.
	const eng = String(engine || 'pdflatex').toLowerCase();
	if (eng === 'lualatex' || eng === 'xelatex') {
		emitPackage('fontspec');
	} else {
		emitPackage('inputenc', 'utf8');
		emitPackage('fontenc', 'T1');
	}

	// Feature-required packages, then user-named packages — both in order,
	// skipping the load-order-sensitive ones for now.
	for (const [name, options] of requiredPackages) {
		if (!LATE_PACKAGES.includes(name)) emitPackage(name, options);
	}
	for (const name of normaliseList(userPackages)) {
		if (!LATE_PACKAGES.includes(name)) emitPackage(name);
	}

	// Feature raw preamble snippets.
	for (const line of rawPreambleLines) lines.push(line);

	// Load-order-sensitive packages, last and in their canonical order.
	for (const name of LATE_PACKAGES) {
		if (requiredPackages.has(name) || normaliseList(userPackages).includes(name)) {
			emitPackage(name, requiredPackages.get(name) || '');
		}
	}

	// Post-package configuration (\crefname for cleveref, \hypersetup for
	// hyperref) — emitted after the load-order-sensitive packages, and only when
	// one of them is actually present (each line is registered only alongside its
	// package, so this gate just avoids a stray block when neither is loaded).
	if (emitted.has('cleveref') || emitted.has('hyperref')) {
		for (const line of latePreambleLines) lines.push(line);
	}

	// User verbatim preamble, last of all so it can override anything above.
	for (const line of normaliseList(userPreamble)) lines.push(line);

	return lines.join('\n');
}
