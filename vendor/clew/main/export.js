// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Note export through the jmarkdown engine — the payoff of building on a
// dual-output engine: the same source exports to polished HTML, LaTeX, or
// (when a TeX toolchain is installed) PDF.
//
// Exports run a fresh one-shot worker with cwd = the NOTE's directory, so the
// normal jmarkdown config cascade applies (global ~/.jmarkdown + any vault
// .jmarkdown/) — deliberately NOT Clew's preview config: exports use the
// engine's own templates (CDN assets, biblify, the user's customizations).
//
// Except for a vault this device does not trust (vault-trust.js; frame-
// bridge.md §4.4, the owner's Q9): its exports run from a Clew-owned folder
// in userData whose one config key turns the engine's `Run note code` off.
// The cascade then sees the user's global ~/.jmarkdown and that key — never
// a .jmarkdown/config.json the vault carries, which can load engine
// extensions, i.e. run code. The engine resolves a note's relative paths
// (images, Bibliography, includes) from the note's own folder, not the
// working directory, so the export is otherwise the same (measured: HTML and
// LaTeX byte-identical from either folder).
//
// The figures an export makes the engine render — mermaid, MetaPost, TiKZ,
// video posters, Mathematica — are cached OUTSIDE the vault and copied beside
// the output (export-cache.js, figureCache below; the owner's "Outside",
// 2026-10-06): an export writes nothing in the vault but what was asked for.
import { dialog } from 'electron';
import { execFile } from 'node:child_process';
import { fork } from 'node:child_process';
import { paths } from './paths.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toolchainPath } from './render-service.js';
import { bibliographyDirs, bibliographyList, vaultBiblify } from '../shared/citation-files.js';
import { printNoteToPdf } from './print-pdf.js';
import { settings } from './settings.js';
import { calloutsEnv } from './callout-types.js';
import { iconTable } from './callout-files.js';
import { latexmkCommand, latexPdfRefusal } from './latex-engine.js';
import { chooseLatexEngine, pdfViaLatexFailure, texMissingFiles, missingFileWarnings } from '../shared/latex-engine.js';
import { identityKey } from './vault-trust.js';
import { figuresState, otherOutputs, vaultCacheDir, markUsed, pruneExportCache, figureEngineOptions, texRefusalDir } from './export-cache.js';
import { figuresFolder, explainFiguresWarnings } from '../shared/export-figures.js';
import { latexStyleWanted } from '../engine/latex-style.js';
import { noteExportOptions } from '../engine/export-config.js';
import { buildIndex, fontDirs } from './system-fonts.js';

const WORKER_PATH = paths.engineWorker;
// Clew's own export worker (engine/export-worker.mjs): the engine's worker
// with its Obsidian links ON — resolvers the IPC to the engine's own worker
// cannot carry.
const EXPORT_WORKER = path.join(paths.engineAssets, 'export-worker.mjs');

/** Where a restricted vault's export runs from (see the header). */
export function restrictedExportDir() {
	const dir = paths.restrictedExport;
	fs.mkdirSync(path.join(dir, '.jmarkdown'), { recursive: true });
	fs.writeFileSync(path.join(dir, '.jmarkdown', 'config.json'), JSON.stringify({ 'Run note code': false }, null, '\t') + '\n');
	return dir;
}

/**
 * What draws this export's TikZ and MetaPost (export-cache.js#
 * figureEngineOptions): a trusted vault's as the `exportFigureEngine` setting
 * says, a restricted vault's always the staged mp-tikz-wasm alone.
 */
export function figureEngine(trusted) {
	return figureEngineOptions({ trusted, dist: paths.mptikzAssets, setting: settings.get('exportFigureEngine') });
}

// A restricted vault's worker finds refusing stand-ins for the TeX tools
// first on its PATH (export-cache.js#texRefusalDir): a second guard behind the
// engine's own (`wasm` never runs the tools since jmarkdown c82d206), so its
// figures' TeX never reaches the installed lualatex.
function workerPath(restricted) {
	const refuse = restricted ? texRefusalDir(path.join(paths.restrictedExport, 'no-tex')) : null;
	return refuse ? [refuse, toolchainPath()].join(path.delimiter) : toolchainPath();
}

/**
 * One engine build in a one-shot worker. With `vault` ({ root, restricted }),
 * the engine's Obsidian links are ON (jmarkdown obsidian-links.js; the owner,
 * 2026-10-05): [[links]] print as their text and ![[image]] embeds resolve
 * across the vault as the preview resolves them — through Clew's export
 * worker, which gives the engine those resolvers. Without it, the engine's
 * own worker, exactly as before.
 */
/**
 * Clew's LaTeX style for this build (engine/latex-style.js), or null: a
 * LaTeX build, the `latexExportStyle` setting `clew` (the default), and an
 * engine that can set its fonts — never with pdfLaTeX forced. The machine's
 * locale and platform choose the paper, the hyphenation and the emoji face.
 */
function latexStyle(options) {
	return latexStyleWanted({
		to: options?.to, style: settings.get('latexExportStyle'), engine: settings.get('latexEngine'),
		locale: Intl.DateTimeFormat().resolvedOptions().locale, platform: process.platform,
	});
}

export function runWorker({ file, options, cwd, callouts = '', vault = null }) {
	// The font index the export worker hands figures' named families from
	// (engine/font-families.js) — the preview's, brought up to date first
	// (its folders' mtimes; ~0.2s once, a read after).
	if (vault) {
		try { buildIndex(fontDirs(), paths.systemFontIndex); } catch { /* the worker finds none: the engine's folder search */ }
	}
	return new Promise((resolve, reject) => {
		const child = fork(vault ? EXPORT_WORKER : WORKER_PATH, vault ? [WORKER_PATH] : [], {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
			// The engine renders callouts itself (jmarkdown a7de8c6), HTML and
			// LaTeX; CLEW_CALLOUTS hands it this vault's custom types, as the
			// preview does — a `Callouts` key in the user's own config wins.
			env: {
				...process.env, PATH: workerPath(vault?.restricted === true), CLEW_CALLOUTS: callouts,
				...(vault ? { CLEW_VAULT_ROOT: vault.root, CLEW_VAULT_RESTRICTED: vault.restricted ? '1' : '0', CLEW_FONT_INDEX: paths.systemFontIndex } : {}),
			},
		});
		let stderr = '';
		child.stdout.on('data', () => {});
		child.stderr.on('data', (chunk) => { stderr += chunk; });
		child.on('message', (msg) => {
			if (msg?.type === 'ready') {
				child.send({ type: 'build', file, options, latexStyle: latexStyle(options), biblify: vault?.biblify ?? null });
			} else if (msg?.type === 'done') {
				resolve({
					output: msg.output, warnings: Array.isArray(msg.warnings) ? msg.warnings : [],
					bookMap: msg.bookMap ?? null, latexFiles: msg.latexFiles ?? null,
				});
			} else if (msg?.type === 'error') {
				reject(new Error(msg.message));
			}
		});
		child.on('exit', (code) => {
			if (code !== 0) reject(new Error(`export worker failed (${code}): ${stderr.slice(-500)}`));
		});
		child.on('error', reject);
	});
}

/**
 * The bibliography an export's config cascade configures, as the engine
 * resolves it (bibliographies.js): `Biblify.bibliography` from the global
 * ~/.jmarkdown/config.json, overridden by the working folder's own
 * .jmarkdown/config.json, each relative path against the working folder.
 */
export function configuredBibliographies(cwd) {
	let value = '';
	for (const file of [path.join(os.homedir(), '.jmarkdown', 'config.json'), path.join(cwd, '.jmarkdown', 'config.json')]) {
		try {
			const named = JSON.parse(fs.readFileSync(file, 'utf8'))?.Biblify?.bibliography;
			if (named && (!Array.isArray(named) || named.length)) value = named;
		} catch { /* no such config */ }
	}
	return bibliographyList(value).filter((p) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(p)).map((p) => path.resolve(cwd, p));
}

let exportsRunning = 0;

/**
 * Where this export's engine keeps the figures it makes — never in the vault
 * (processFile's `cacheDir`, jmarkdown d134995). A trusted vault's: its folder
 * in the device's export cache, reused by its later exports and pruned once
 * no export is running (least recently used first, to EXPORT_CACHE_LIMIT). A
 * restricted vault's: a temporary folder of this export's own, removed when
 * it ends, so nothing of it stays anywhere. `done(figures)` ends it, with the
 * folders the engine copied this export's figures into (markUsed: what they
 * hold is kept longest); call it once, before any of them is removed.
 */
export function figureCache({ root, trusted }) {
	if (!trusted) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-figures-'));
		return { cacheDir: dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
	}
	const dir = vaultCacheDir(paths.exportCache, identityKey(root));
	fs.mkdirSync(dir, { recursive: true });
	exportsRunning += 1;
	return {
		cacheDir: dir,
		done: (figures = []) => {
			for (const f of figures) markUsed(dir, f);
			exportsRunning -= 1;
			if (exportsRunning) return;
			try { pruneExportCache(paths.exportCache); } catch (err) { console.warn('[clew] export cache prune:', err?.message ?? err); }
		},
	};
}

/**
 * Before an export writes `output`: the `-figures/` folder an earlier one
 * left goes to the Trash — never deleted — so a diagram since removed leaves
 * no copy behind. Only a folder the engine MARKED as its own (FIGURES_MARKER),
 * and only while no other export it serves is there (a note's .tex and .html
 * share one; a book's pages use it too). A folder of that name the user made
 * is never touched — the engine leaves it alone too, and warns
 * (explainFiguresWarnings).
 */
export async function clearFigures(vaults, output) {
	const dir = figuresFolder(output);
	if (figuresState(dir) === 'marked' && !otherOutputs(output).length) await vaults.trashExported(dir);
}

const TEX_DIRS = ['/Library/TeX/texbin', '/usr/local/bin', '/opt/homebrew/bin'];
// The device word the window says (renderer/lib/device-name.js): a desktop
// page has no host name, so its platform's.
export const DEVICE_WORD = process.platform === 'darwin' ? 'this Mac' : 'this computer';
// CLEW_SMOKE_NO_TEX (scenarios only; render-service.js#toolchainPath): none here either.
const findTex = (name) => (process.env.CLEW_SMOKE && process.env.CLEW_SMOKE_NO_TEX ? null
	: TEX_DIRS.map((dir) => path.join(dir, name)).find((p) => fs.existsSync(p)) ?? null);

/**
 * Compile the exported .tex to a PDF with the engine it needs
 * (latex-engine.js: read off the document itself, or the `latexEngine`
 * setting). latexmk when installed — it runs BibTeX and the reruns — else
 * the engine once. A failure names the engine, why it was chosen, and the
 * log's first error. The NOTE's folder is on TeX's and BibTeX's search
 * paths: the .tex is written beside the chosen output, which need not be
 * beside the note, and `\bibliography{refs}` or a relative graphic is the
 * note's (the default save path is the vault root — every citation came out
 * undefined there, 2026-10-02). A run that made its PDF can still have left
 * something out: TeX goes on past a file it cannot find (nonstopmode), so the
 * log's not-found lines come back as `missing` (shared/latex-engine.js#
 * texMissingFiles) for the caller's warnings — an image named by a path that
 * is not there used to leave the PDF without a word (the owner's A1).
 *
 * @returns {Promise<{pdf: string, engine: string, reason: string, missing: {file: string, line: number|null}[]}>}
 */
export function compilePdf(texFile, noteDir, bibDirs = [noteDir]) {
	const { engine, reason } = chooseLatexEngine(fs.readFileSync(texFile, 'utf8'), settings.get('latexEngine') ?? 'auto');
	const latexmk = findTex('latexmk');
	const tex = latexmk ?? findTex(engine);
	if (!tex) throw new Error(`No TeX toolchain found (latexmk or ${engine}). Install MacTeX for PDF export.`);
	// `-g`: latexmk always runs. An unchanged note re-exported to the same
	// place otherwise found its rewritten .tex up to date, ran nothing, and
	// left the last PDF — which the freshness check below rightly refused
	// ("no PDF was produced", measured 2026-10-05). One extra pass, no
	// parsing of latexmk's messages. Its configuration and biber's are the
	// user's own, never a file in the folder it runs in (latex-engine.js#
	// latexmkCommand: a book's runs in the vault's build/).
	const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
	const command = latexmk
		? latexmkCommand({ engine, texFile: path.basename(texFile), env: process.env, isFile })
		: { args: ['-interaction=nonstopmode', path.basename(texFile)], env: {} };
	const pdf = texFile.replace(/\.tex$/, '.pdf');
	const started = Date.now();
	return new Promise((resolve, reject) => {
		// A trailing separator keeps TeX's own search path after ours. BibTeX
		// gets every bibliography's folder: `\bibliography{…}` names each
		// file by its basename (jmarkdown 909af7a: the note's AND the
		// configured ones).
		const searchPath = (dirs, name) => `${dirs.join(path.delimiter)}${path.delimiter}${process.env[name] ?? ''}`;
		const env = { ...process.env, ...command.env, PATH: toolchainPath(), BIBINPUTS: searchPath(bibDirs, 'BIBINPUTS'), TEXINPUTS: searchPath([noteDir], 'TEXINPUTS') };
		execFile(tex, command.args, { cwd: path.dirname(texFile), timeout: 180000, env }, (err) => {
			// A non-zero exit can be warnings only: accept a PDF THIS run wrote —
			// never one an earlier export left at the same path.
			const fresh = fs.existsSync(pdf) && fs.statSync(pdf).mtimeMs >= started - 1000;
			// As bytes: pdfTeX breaks its lines inside a letter's UTF-8
			// (texMissingFiles joins them before decoding).
			let log = new Uint8Array();
			try { log = fs.readFileSync(texFile.replace(/\.tex$/, '.log')); } catch { /* none written */ }
			if (fresh) {
				resolve({ pdf, engine, reason, missing: texMissingFiles(log) });
				return;
			}
			reject(new Error(pdfViaLatexFailure({ engine, reason, log: new TextDecoder().decode(log), error: err?.message })));
		});
	});
}

/**
 * Export a note. format: 'html' | 'latex' | 'pdf' | 'print-pdf'.
 *
 * The two PDFs are different documents on purpose. 'pdf' goes out through
 * the engine's LaTeX path and a TeX toolchain — typeset, and nothing like
 * the screen. 'print-pdf' prints the reading view itself (print-pdf.js), so
 * what you were looking at is what you get, with no TeX installed.
 *
 * Prompts for a destination; returns { output } or { canceled: true }.
 */
export async function exportNote({ win, vaults, sessionId, callerToken = null, relPath, format, outFile, trusted = false }) {
	// No PDF via LaTeX in a vault this device does not trust (latex-engine.js#
	// latexPdfRefusal): refused before the save dialog, nothing built.
	if (format === 'pdf' && !trusted) return { refused: latexPdfRefusal('note', DEVICE_WORD) };
	const abs = vaults.resolve(relPath);
	const cwd = trusted ? path.dirname(abs) : restrictedExportDir();
	const vaultSettings = vaults.loadState('vault-settings.json') ?? {};
	const callouts = calloutsEnv(settings.get('callouts'), vaultSettings.callouts, () => iconTable(paths.faIcons));
	const base = path.basename(abs).replace(/\.(md|jmd)$/i, '');
	const ext = format === 'html' ? 'html' : format === 'latex' ? 'tex' : 'pdf';
	// The engine's Obsidian links, on for every note export (runWorker): Clew's
	// own wikilink handling is the preview's and the site's, never an export's,
	// which runs the user's own config cascade. And the vault's citation
	// settings as reading view has them (shared/citation-files.js#vaultBiblify),
	// for an HTML export to cite alike.
	const vault = { root: vaults.root, restricted: !trusted, biblify: vaultBiblify(vaultSettings, vaults.root) };

	// A relative outFile is vault-relative, not process-relative: the caller
	// is a scenario inside the vault, and resolving against the working
	// directory dropped the PDF in the repo root the first time.
	let filePath = outFile ? (path.isAbsolute(outFile) ? outFile : path.join(vaults.root, outFile)) : null;
	if (!filePath) {
		const chosen = await dialog.showSaveDialog(win, {
			title: `Export ${base} as ${ext.toUpperCase()}`,
			defaultPath: path.join(vaults.root, `${base}.${ext}`),
			filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
		});
		if (chosen.canceled || !chosen.filePath) return { canceled: true };
		filePath = chosen.filePath;
	}

	// A caller-named path (a scenario's outFile) may name a folder that does
	// not exist yet; the save dialog's always does.
	fs.mkdirSync(path.dirname(filePath), { recursive: true });

	if (format === 'print-pdf') {
		await printNoteToPdf({
			sessionId, callerToken, relPath, outFile: filePath, paperSize: settings.get('printPaperSize'),
		});
		return { output: filePath };
	}

	// HTML, LaTeX, or PDF via LaTeX — the last built in a temporary folder,
	// removed afterwards, and ONLY the PDF delivered: the build's .tex, .aux,
	// .log, .fls, .out, .fdb_latexmk and its figures' copies never land beside
	// it (the clew command's since 2026-10-04; the menu's too since the
	// figures moved out of the vault). The note's folder is on TEXINPUTS
	// (compilePdf), so its relative graphics resolve from there.
	const build = format === 'pdf' ? fs.mkdtempSync(path.join(os.tmpdir(), 'clew-export-')) : null;
	const written = build ? path.join(build, `${base}.tex`) : filePath;
	let figures = null;
	try {
		figures = figureCache({ root: vaults.root, trusted });
		if (!build) await clearFigures(vaults, written);
		// processFile's options for a note (engine/export-config.js): the vault's
		// standard syntax and bibliography, the figure cache and its copies.
		const options = noteExportOptions({
			format, output: written, vaultSettings, vaultRoot: vaults.root, cacheDir: figures.cacheDir, figureEngine: figureEngine(trusted),
		});
		const built = await runWorker({ file: abs, options, cwd, callouts, vault });
		const warnings = explainFiguresWarnings(built.warnings, { restricted: !trusted, platform: process.platform });
		if (format !== 'pdf') return { output: written, warnings };
		const noteDir = path.dirname(abs);
		const configured = [...configuredBibliographies(cwd), ...options.bibliography];
		const bibDirs = bibliographyDirs(fs.readFileSync(abs, 'utf8'), noteDir, configured);
		const { pdf, engine, reason, missing } = await compilePdf(written, noteDir, bibDirs);
		fs.copyFileSync(pdf, filePath);
		return { output: filePath, engine, reason, warnings: [...warnings, ...missingFileWarnings(missing)] };
	} finally {
		figures?.done([figuresFolder(written)]);
		if (build) fs.rmSync(build, { recursive: true, force: true });
	}
}
