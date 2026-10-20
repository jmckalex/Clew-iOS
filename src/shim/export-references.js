// What a note's LaTeX export needs beside it to typeset, read from the .tex
// itself (UPSTREAM-LATEX-EXPORT-PLAN.md §3, L2). Desktop writes the .tex into
// the vault, where everything it names already is; the iPad shares it, so the
// share must carry what it names: the zip holds the .tex at its root, its
// figures folder, each vault file a `\includegraphics` names at its vault
// path (the .tex is written at the vault's root, so its paths are
// vault-relative already), and each bibliography `\bibliography{…}` names
// beside the .tex — jmarkdown names every file by its basename since
// 909af7a, and BibTeX looks beside the document (desktop puts each one's
// folder on BIBINPUTS instead: export.js#compilePdf).
//
// Decided here, in the app page, from the .tex and the vault's mirror, never
// by the export host's page: what goes into the zip is what the document
// names and the vault has, and native copies only vault paths it clamps
// itself (VaultStore.resolve). Pure: tests/export-host.test.js.

const GRAPHICS = /\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/g;
const BIBLIOGRAPHY = /\\bibliography\s*\{([^{}]+)\}/g;
const BIBRESOURCE = /\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/g;
// What graphicx tries for a name without an extension (pdfTeX's and
// LuaTeX's list, the common part).
const GRAPHIC_EXTS = ['.pdf', '.png', '.jpg', '.jpeg', '.jbig2', '.jb2', '.eps', '.mps'];

/** A vault-relative path from one the .tex names, or null when it leaves
 *  the vault, is absolute, or is a URL. */
function vaultPath(named) {
	const p = named.trim().replace(/^"(.*)"$/, '$1');
	if (!p || p.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.includes('\\')) return null;
	const out = [];
	for (const seg of p.split('/')) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') {
			if (!out.length) return null;
			out.pop();
		} else {
			out.push(seg);
		}
	}
	return out.length ? out.join('/') : null;
}

/** The .tex with its comments taken out (a `%` not escaped). */
const uncommented = (tex) => tex.split('\n').map((line) => line.replace(/(^|[^\\])%.*$/, '$1')).join('\n');

/**
 * @param {{ tex: string, base: string, exists: (rel: string) => boolean,
 *   bibFiles?: string[] }} o
 *   the .tex (written at the vault's root); its base name, whose
 *   `<base>-figures/` is the export's own; whether the vault holds a
 *   vault-relative path; the .bib files the build could have used (the
 *   note's header's, the vault's, the vault's jmarkdown config's),
 *   vault-relative
 * @returns {{ files: string[], bibs: { rel: string, as: string }[], missing: string[] }}
 *   vault files to carry at their paths; bibliographies to carry beside the
 *   .tex as `as`; what the .tex names that the vault does not have
 */
export function texReferences({ tex, base, exists, bibFiles = [] }) {
	const text = uncommented(String(tex ?? ''));
	const own = `${base}-figures/`;
	const files = new Set();
	const missing = new Set();
	for (const [, named] of text.matchAll(GRAPHICS)) {
		const rel = vaultPath(named);
		if (!rel || rel.startsWith(own)) continue;
		const found = exists(rel) ? rel : GRAPHIC_EXTS.map((ext) => rel + ext).find((r) => exists(r));
		if (found) files.add(found);
		else missing.add(rel);
	}
	const bibs = [];
	const taken = new Set();
	const names = [
		...[...text.matchAll(BIBLIOGRAPHY)].flatMap(([, list]) => list.split(',')),
		...[...text.matchAll(BIBRESOURCE)].map(([, one]) => one),
	].map((n) => n.trim()).filter(Boolean);
	for (const name of names) {
		const as = /\.bib$/i.test(name) ? name : `${name}.bib`;
		if (taken.has(as)) continue;
		taken.add(as);
		// A path the .tex names is the vault's at that path; a bare name is the
		// build's file of that name, the first in the build's own order.
		const rel = as.includes('/')
			? (() => { const r = vaultPath(as); return r && exists(r) ? r : null; })()
			: bibFiles.find((f) => f.slice(f.lastIndexOf('/') + 1).toLowerCase() === as.toLowerCase() && exists(f));
		const safeAs = vaultPath(as);
		if (rel && safeAs) bibs.push({ rel, as: safeAs });
		else missing.add(as);
	}
	return { files: [...files].sort(), bibs, missing: [...missing].sort() };
}
