/*
	Build-warning collector.

	Problems worth telling the author about but not worth aborting the build
	over: an unresolvable :ref still renders '??' (mirroring LaTeX's own
	undefined-reference mark), a duplicate :label still lets the later
	definition win. LaTeX nags about both at the end of a run; this module
	gives the HTML pipeline the same courtesy. Detection sites call
	addWarning() as they go, and processFile prints the collected summary to
	stderr once the output is written. The watch worker additionally ships the
	list to the watcher (see watch-worker.js), which surfaces it in the browser
	as an amber banner — the dismissible sibling of the red build-error overlay.

	State is module-level but RESET per document build via resetWarnings()
	(called at the top of processFile) — the same pattern as crossref.js, and
	important for the same reason: a single process may build more than one
	document (library use, multi-file books).
*/

let warnings = [];

// Discard all collected warnings. Call once at the start of each build.
export function resetWarnings() {
	warnings = [];
}

export function addWarning(message) {
	warnings.push(message);
}

export function getWarnings() {
	return warnings.slice();
}

// Print the collected warnings to stderr as a short summary block. Silent
// when there are none (the overwhelmingly common case). console.warn writes
// to stderr, so this never corrupts stdout-mode document output.
export function reportWarnings() {
	if (warnings.length === 0) return;
	console.warn(`jmarkdown: ${warnings.length} warning${warnings.length === 1 ? '' : 's'}:`);
	for (const w of warnings) {
		console.warn(`  - ${w}`);
	}
}
