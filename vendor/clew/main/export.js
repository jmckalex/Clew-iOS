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
import { dialog } from 'electron';
import { execFile } from 'node:child_process';
import { fork } from 'node:child_process';
import { paths } from './paths.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toolchainPath } from './render-service.js';
import { bibliographyDirs, bibliographyList } from './citation-header.js';
import { printNoteToPdf } from './print-pdf.js';
import { settings } from './settings.js';
import { calloutsEnv } from './callout-types.js';
import { chooseLatexEngine, engineName, latexmkFlag, firstLatexError } from './latex-engine.js';

const WORKER_PATH = paths.engineWorker;

/** Where a restricted vault's export runs from (see the header). */
function restrictedExportDir() {
	const dir = paths.restrictedExport;
	fs.mkdirSync(path.join(dir, '.jmarkdown'), { recursive: true });
	fs.writeFileSync(path.join(dir, '.jmarkdown', 'config.json'), JSON.stringify({ 'Run note code': false }, null, '\t') + '\n');
	return dir;
}

function runWorker({ file, options, cwd, callouts = '' }) {
	return new Promise((resolve, reject) => {
		const child = fork(WORKER_PATH, [], {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
			// The engine renders callouts itself (jmarkdown a7de8c6), HTML and
			// LaTeX; CLEW_CALLOUTS hands it this vault's custom types, as the
			// preview does — a `Callouts` key in the user's own config wins.
			env: { ...process.env, PATH: toolchainPath(), CLEW_CALLOUTS: callouts },
		});
		let stderr = '';
		child.stdout.on('data', () => {});
		child.stderr.on('data', (chunk) => { stderr += chunk; });
		child.on('message', (msg) => {
			if (msg?.type === 'ready') {
				child.send({ type: 'build', file, options });
			} else if (msg?.type === 'done') {
				resolve({ output: msg.output, warnings: Array.isArray(msg.warnings) ? msg.warnings : [] });
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
function configuredBibliographies(cwd) {
	let value = '';
	for (const file of [path.join(os.homedir(), '.jmarkdown', 'config.json'), path.join(cwd, '.jmarkdown', 'config.json')]) {
		try {
			const named = JSON.parse(fs.readFileSync(file, 'utf8'))?.Biblify?.bibliography;
			if (named && (!Array.isArray(named) || named.length)) value = named;
		} catch { /* no such config */ }
	}
	return bibliographyList(value).filter((p) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(p)).map((p) => path.resolve(cwd, p));
}

const TEX_DIRS = ['/Library/TeX/texbin', '/usr/local/bin', '/opt/homebrew/bin'];
const findTex = (name) => TEX_DIRS.map((dir) => path.join(dir, name)).find((p) => fs.existsSync(p)) ?? null;

/**
 * Compile the exported .tex to a PDF with the engine it needs
 * (latex-engine.js: read off the document itself, or the `latexEngine`
 * setting). latexmk when installed — it runs BibTeX and the reruns — else
 * the engine once. A failure names the engine, why it was chosen, and the
 * log's first error. The NOTE's folder is on TeX's and BibTeX's search
 * paths: the .tex is written beside the chosen output, which need not be
 * beside the note, and `\bibliography{refs}` or a relative graphic is the
 * note's (the default save path is the vault root — every citation came out
 * undefined there, 2026-10-02).
 *
 * @returns {Promise<{pdf: string, engine: string, reason: string}>}
 */
function compilePdf(texFile, noteDir, bibDirs = [noteDir]) {
	const { engine, reason } = chooseLatexEngine(fs.readFileSync(texFile, 'utf8'), settings.get('latexEngine') ?? 'auto');
	const latexmk = findTex('latexmk');
	const tex = latexmk ?? findTex(engine);
	if (!tex) throw new Error(`No TeX toolchain found (latexmk or ${engine}). Install MacTeX for PDF export.`);
	const args = latexmk
		? [latexmkFlag(engine), '-interaction=nonstopmode', '-quiet', path.basename(texFile)]
		: ['-interaction=nonstopmode', path.basename(texFile)];
	const pdf = texFile.replace(/\.tex$/, '.pdf');
	const started = Date.now();
	return new Promise((resolve, reject) => {
		// A trailing separator keeps TeX's own search path after ours. BibTeX
		// gets every bibliography's folder: `\bibliography{…}` names each
		// file by its basename (jmarkdown 909af7a: the note's AND the
		// configured ones).
		const searchPath = (dirs, name) => `${dirs.join(path.delimiter)}${path.delimiter}${process.env[name] ?? ''}`;
		const env = { ...process.env, PATH: toolchainPath(), BIBINPUTS: searchPath(bibDirs, 'BIBINPUTS'), TEXINPUTS: searchPath([noteDir], 'TEXINPUTS') };
		execFile(tex, args, { cwd: path.dirname(texFile), timeout: 180000, env }, (err) => {
			// A non-zero exit can be warnings only: accept a PDF THIS run wrote —
			// never one an earlier export left at the same path.
			const fresh = fs.existsSync(pdf) && fs.statSync(pdf).mtimeMs >= started - 1000;
			if (fresh) {
				resolve({ pdf, engine, reason });
				return;
			}
			let log = '';
			try { log = fs.readFileSync(texFile.replace(/\.tex$/, '.log'), 'utf8'); } catch { /* none written */ }
			const first = firstLatexError(log) || err?.message || 'no PDF was produced';
			reject(new Error(`PDF via LaTeX failed — ${engineName(engine)} ran (${reason}). First error: ${first}`));
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
	const abs = vaults.resolve(relPath);
	const cwd = trusted ? path.dirname(abs) : restrictedExportDir();
	// Exports honor the vault's standard-syntax choice, like previews do.
	const vaultSettings = vaults.loadState('vault-settings.json') ?? {};
	const normalSyntax = vaultSettings.normalSyntax === true;
	const callouts = calloutsEnv(settings.get('callouts'), vaultSettings.callouts, paths.faIcons);
	const base = path.basename(abs).replace(/\.(md|jmd)$/i, '');
	const ext = format === 'html' ? 'html' : format === 'latex' ? 'tex' : 'pdf';
	// The vault's bibliography, for this build only (jmarkdown 455cb61): an
	// export runs the user's own config cascade, not Clew's generated one, so
	// without it a note citing only the vault's file exported every such
	// citation undefined. A configured file in every respect — a note's own
	// Bibliography adds to it, `Bibliography mode: replace` drops it.
	const vaultBibName = String(vaultSettings.bibliography ?? '').trim();
	const vaultBib = vaultBibName ? path.resolve(vaults.root, vaultBibName) : null;
	const bibliography = vaultBib ? [vaultBib] : [];

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

	if (format === 'html') {
		const { warnings } = await runWorker({ file: abs, options: { to: 'html', output: filePath, normalSyntax, bibliography }, cwd, callouts });
		return { output: filePath, warnings };
	}

	// LaTeX (and PDF via LaTeX): build the .tex next to the requested output
	// so relative graphics resolve, then compile if PDF was asked for.
	const texFile = format === 'latex' ? filePath : filePath.replace(/\.pdf$/i, '.tex');
	const { warnings } = await runWorker({ file: abs, options: { to: 'latex', output: texFile, normalSyntax, bibliography }, cwd, callouts });
	if (format === 'latex') return { output: texFile, warnings };
	const noteDir = path.dirname(abs);
	const configured = [...configuredBibliographies(cwd), ...bibliography];
	const bibDirs = bibliographyDirs(fs.readFileSync(abs, 'utf8'), noteDir, configured);
	const { pdf, engine, reason } = await compilePdf(texFile, noteDir, bibDirs);
	if (pdf !== filePath) fs.copyFileSync(pdf, filePath);
	return { output: filePath, engine, reason, warnings };
}
