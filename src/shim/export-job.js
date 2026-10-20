// An export's job for the export host (UPSTREAM-LATEX-EXPORT-PLAN.md §3, L1):
// what the export worker starts from (its vfs, cwd and env) and the one
// build it runs. Pure, so the Node harness (tools/export-note.mjs) builds the
// same job the app does.
//
// As desktop's main/export.js#exportNote, an export reads the vault's own
// jmarkdown configuration, from the note's folder, never the preview's
// generated one; a vault this device does not trust exports from a folder
// whose configuration says `Run note code: false` and nothing else
// (restrictedExportDir). The output is written at the vault's root, so every
// image path in the .tex is vault-relative, and the figures land in
// `<base>-figures/` beside it (`Copy figures`), drawn by mp-tikz-wasm alone
// (`Figure engine: wasm`: the iPad has no TeX tools to fall back on).

/** Where a restricted vault's export runs from (desktop: restrictedExportDir). */
export const EXPORT_RESTRICTED_CWD = '/export/restricted';
/** The figure engine's cache: in the worker's vfs, gone with the worker. */
export const EXPORT_CACHE_DIR = '/export/cache';
/** `MP-TikZ dist`: any path, so the figure engine turns on; the library itself
 *  is imported by URL (scripts/build.js#exportEnginePatches). */
export const EXPORT_MPTIKZ_DIST = '/export/mptikz';

const NOTE = /\.(md|jmd)$/i;

/**
 * @param {{ vaultRoot?: string, noteRel: string, format: string,
 *   files: Record<string, unknown>, env: Record<string, string>,
 *   trusted: boolean, vaultOptions?: Record<string, unknown> }} opts
 * @returns {{ init: { files: object, cwd: string, env: object },
 *   build: { file: string, options: object } }}
 */
export function exportJob({ vaultRoot = '/vault', noteRel, format, files, env, trusted, vaultOptions = {} }) {
	if (format !== 'latex') throw new Error(`not an export the export host makes: ${format}`);
	const rel = String(noteRel ?? '');
	if (!NOTE.test(rel) || rel.startsWith('/') || rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
		throw new Error(`not a note in this vault: ${rel}`);
	}
	const file = `${vaultRoot}/${rel}`;
	const base = rel.slice(rel.lastIndexOf('/') + 1).replace(NOTE, '');
	const snapshot = { ...files };
	let cwd = file.slice(0, file.lastIndexOf('/'));
	if (trusted !== true) {
		cwd = EXPORT_RESTRICTED_CWD;
		snapshot[`${cwd}/.jmarkdown/config.json`] = JSON.stringify({ 'Run note code': false }, null, '\t') + '\n';
	}
	// The vault's bibliography for this build (jmarkdown 455cb61, desktop's
	// exportNote): a note citing only the vault's file still resolves.
	const bib = String(vaultOptions.bibliography ?? '').trim();
	const bibliography = bib ? [bib.startsWith('/') ? bib : `${vaultRoot}/${bib}`] : [];
	return {
		init: { files: snapshot, cwd, env: { ...env } },
		build: {
			file,
			options: {
				to: 'latex',
				output: `${vaultRoot}/${base}.tex`,
				normalSyntax: vaultOptions.normalSyntax === true,
				bibliography,
				cacheDir: EXPORT_CACHE_DIR,
				copyFigures: true,
				figureEngine: 'wasm',
				mpTikzDist: EXPORT_MPTIKZ_DIST,
			},
		},
	};
}
