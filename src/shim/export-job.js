// An export's job for the export host (UPSTREAM-LATEX-EXPORT-PLAN.md §3, L1
// and L2): what the export worker starts from (its vfs, cwd and env) and the
// one build it runs. Pure, so the Node harness (tools/export-note.mjs) builds
// the same job the app does.
//
// As desktop's main/export.js#exportNote, an export reads the vault's own
// jmarkdown configuration, from the note's folder, never the preview's
// generated one; a vault this device does not trust exports from a folder
// whose configuration says `Run note code: false` and nothing else
// (restrictedExportDir). The output is written at the vault's root, so every
// image path in the .tex is vault-relative, and the figures land in
// `<base>-figures/` beside it (`Copy figures`), drawn by mp-tikz-wasm alone
// (`Figure engine: wasm`: the iPad has no TeX tools to fall back on).
//
// The decisions are desktop's own, imported (Clew-app's U1–U7): processFile's
// options are engine/export-config.js#noteExportOptions; whether the build
// gets Clew's LaTeX style is engine/latex-style.js#latexStyleWanted, with the
// `ios` platform (no colour emoji face: the .tex may be typeset anywhere, and
// the iPad's own TeX has none); the vault's citation settings are
// shared/citation-files.js#vaultBiblify. The worker applies the last two with
// export-config.js#configureExportBuild, as desktop's export worker does.
import { noteExportOptions } from '../../vendor/clew/engine/export-config.js';
import { latexStyleWanted } from '../../vendor/clew/engine/latex-style.js';
import { vaultBiblify } from '../../vendor/clew/shared/citation-files.js';
import { figuresFolder } from '../../vendor/clew/shared/export-figures.js';

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
 *   trusted: boolean, vaultOptions?: Record<string, unknown>,
 *   settings?: { latexExportStyle?: string, latexEngine?: string }, locale?: string }} opts
 * @returns {{ base: string, init: { files: object, cwd: string, env: object },
 *   build: { file: string, options: object, latexStyle: object | null, biblify: object | null } }}
 */
export function exportJob({ vaultRoot = '/vault', noteRel, format, files, env, trusted, vaultOptions = {}, settings = {}, locale = '' }) {
	if (format !== 'latex') throw new Error(`not an export the export host makes: ${format}`);
	const rel = String(noteRel ?? '');
	if (!NOTE.test(rel) || rel.startsWith('/') || rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
		throw new Error(`not a note in this vault: ${rel}`);
	}
	const file = `${vaultRoot}/${rel}`;
	const base = rel.slice(rel.lastIndexOf('/') + 1).replace(NOTE, '');
	const output = `${vaultRoot}/${base}.tex`;
	// A `<base>-figures/` folder the vault already holds at the output's place
	// (a desktop export saved at the vault's root, synced here) stays out of
	// the worker's vfs: the engine would take it as its own, or warn that it
	// is not and refer the .tex to the vfs's cache, which the share never
	// carries. The share's folder is this export's own figures alone.
	const stale = `${figuresFolder(output)}/`;
	const snapshot = Object.fromEntries(Object.entries(files).filter(([abs]) => !abs.startsWith(stale)));
	let cwd = file.slice(0, file.lastIndexOf('/'));
	if (trusted !== true) {
		cwd = EXPORT_RESTRICTED_CWD;
		snapshot[`${cwd}/.jmarkdown/config.json`] = JSON.stringify({ 'Run note code': false }, null, '\t') + '\n';
	}
	return {
		base,
		init: { files: snapshot, cwd, env: { ...env } },
		build: {
			file,
			// Desktop's list (export.js): the vault's standard syntax and its
			// bibliography for this build (jmarkdown 455cb61: a note citing only
			// the vault's file still resolves), the figure cache, its copies, and
			// mp-tikz-wasm alone.
			options: noteExportOptions({
				format, output, vaultSettings: vaultOptions, vaultRoot, cacheDir: EXPORT_CACHE_DIR,
				figureEngine: { figureEngine: 'wasm', mpTikzDist: EXPORT_MPTIKZ_DIST },
			}),
			latexStyle: latexStyleWanted({
				to: 'latex', style: settings.latexExportStyle, engine: settings.latexEngine, locale, platform: 'ios',
			}),
			biblify: vaultBiblify(vaultOptions, vaultRoot),
		},
	};
}
