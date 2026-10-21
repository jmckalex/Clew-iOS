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
// itself (VaultStore.resolve). And only what a document is for: an image
// graphicx typesets, and a .bib, never anything in a hidden folder or
// named with a leading dot (Clew-boss's review of L2: a note's
// `\includegraphics{.git/config}` would have put that file in a zip the
// user then shares). What the .tex names but the share will not carry is
// `refused`, said as a warning. Pure: tests/export-host.test.js.

const GRAPHICS = /\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/g;
const BIBLIOGRAPHY = /\\bibliography\s*\{([^{}]+)\}/g;
const BIBRESOURCE = /\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/g;
// What graphicx tries for a name without an extension (pdfTeX's and
// LuaTeX's list, the common part), and so the only files the share carries
// for an \includegraphics. An image TeX cannot typeset is a link in the
// .tex, not an \includegraphics (SVG always; GIF, WebP, BMP, AVIF since
// jmarkdown 6ac8a6c), so naming one here is refused with the rest.
const GRAPHIC_EXTS = ['.pdf', '.png', '.jpg', '.jpeg', '.jbig2', '.jb2', '.eps', '.mps'];
const isGraphic = (rel) => GRAPHIC_EXTS.some((ext) => rel.toLowerCase().endsWith(ext));
/** A path through a hidden folder, or to a hidden file (`.git/`, `.obsidian/`,
 *  `.clew/`, `.trash/`, `.env`): never shared. */
const isHidden = (rel) => rel.split('/').some((seg) => seg.startsWith('.'));

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
 * @returns {{ files: string[], bibs: { rel: string, as: string }[], missing: string[],
 *   refused: { rel: string, why: 'hidden' | 'not-image' }[] }}
 *   vault files to carry at their paths; bibliographies to carry beside the
 *   .tex as `as`; what the .tex names that the vault does not have; what it
 *   names that the vault has but the share does not carry
 */
export function texReferences({ tex, base, exists, bibFiles = [] }) {
	const text = uncommented(String(tex ?? ''));
	const own = `${base}-figures/`;
	const files = new Set();
	const missing = new Set();
	const refused = new Map();
	for (const [, named] of text.matchAll(GRAPHICS)) {
		const rel = vaultPath(named);
		if (!rel || rel.startsWith(own)) continue;
		const found = exists(rel) ? rel : GRAPHIC_EXTS.map((ext) => rel + ext).find((r) => exists(r));
		if (!found) missing.add(rel);
		else if (isHidden(found)) refused.set(found, 'hidden');
		else if (!isGraphic(found)) refused.set(found, 'not-image');
		else files.add(found);
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
		if (!rel || !safeAs) missing.add(as);
		else if (isHidden(rel) || isHidden(safeAs)) refused.set(rel, 'hidden');
		else bibs.push({ rel, as: safeAs });
	}
	return {
		files: [...files].sort(), bibs, missing: [...missing].sort(),
		refused: [...refused.keys()].sort().map((rel) => ({ rel, why: refused.get(rel) })),
	};
}
