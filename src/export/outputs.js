// What an export build hands back, shared by the export worker and its tests
// (UPSTREAM-LATEX-EXPORT-PLAN.md §3, L1). Pure: no vfs, no DOM.

/**
 * The files an export build wrote that belong with its output: the output
 * itself, and the `<base>-figures/` folder the engine fills when `Copy
 * figures` is on (figure-cache.js#figuresDir: the output's name less its
 * extension, plus `-figures`). Each as a path relative to the output's
 * folder, sorted. The figure cache and anything else the build wrote stay
 * behind.
 *
 * @param {Map<string, string|Uint8Array> | Iterable<[string, string|Uint8Array]>} writes - absolute posix path → data
 * @param {string} output - the build's absolute output path
 * @returns {{ rel: string, data: string|Uint8Array }[]}
 */
export function exportOutputs(writes, output) {
	const dir = output.slice(0, output.lastIndexOf('/'));
	const figures = `${output.replace(/\.[^./]+$/, '')}-figures/`;
	const out = [];
	for (const [abs, data] of writes) {
		if (abs !== output && !abs.startsWith(figures)) continue;
		out.push({ rel: abs.slice(dir.length + 1), data });
	}
	return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/**
 * Whether `rel` may name a file in an export's folder: relative, no `..`, no
 * empty or `.` segment, no backslash or NUL, at most 512 characters. The same
 * rule as ExportJobs.swift#isSafeRelativePath, which checks again on the way
 * in.
 */
export function isSafeExportPath(rel) {
	if (typeof rel !== 'string' || rel === '' || rel.length > 512) return false;
	if (rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) return false;
	return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}
