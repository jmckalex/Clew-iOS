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
import path from 'node:path';
import { toolchainPath } from './render-service.js';
import { printNoteToPdf } from './print-pdf.js';
import { settings } from './settings.js';

const WORKER_PATH = paths.engineWorker;

/** Where a restricted vault's export runs from (see the header). */
function restrictedExportDir() {
	const dir = paths.restrictedExport;
	fs.mkdirSync(path.join(dir, '.jmarkdown'), { recursive: true });
	fs.writeFileSync(path.join(dir, '.jmarkdown', 'config.json'), JSON.stringify({ 'Run note code': false }, null, '\t') + '\n');
	return dir;
}

function runWorker({ file, options, cwd }) {
	return new Promise((resolve, reject) => {
		const child = fork(WORKER_PATH, [], {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
			env: { ...process.env, PATH: toolchainPath() },
		});
		let stderr = '';
		child.stdout.on('data', () => {});
		child.stderr.on('data', (chunk) => { stderr += chunk; });
		child.on('message', (msg) => {
			if (msg?.type === 'ready') {
				child.send({ type: 'build', file, options });
			} else if (msg?.type === 'done') {
				resolve(msg.output);
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

function findTexCommand() {
	for (const candidate of ['latexmk', 'pdflatex']) {
		for (const dir of ['/Library/TeX/texbin', '/usr/local/bin', '/opt/homebrew/bin']) {
			if (fs.existsSync(path.join(dir, candidate))) return path.join(dir, candidate);
		}
	}
	return null;
}

function compilePdf(texFile) {
	const tex = findTexCommand();
	if (!tex) throw new Error('No TeX toolchain found (latexmk/pdflatex). Install MacTeX for PDF export.');
	const args = tex.endsWith('latexmk')
		? ['-pdf', '-interaction=nonstopmode', '-quiet', path.basename(texFile)]
		: ['-interaction=nonstopmode', path.basename(texFile)];
	return new Promise((resolve, reject) => {
		execFile(tex, args, { cwd: path.dirname(texFile), timeout: 120000 }, (err) => {
			const pdf = texFile.replace(/\.tex$/, '.pdf');
			// pdflatex exits non-zero on warnings; accept if the PDF materialized.
			if (fs.existsSync(pdf)) resolve(pdf);
			else reject(err ?? new Error('PDF was not produced'));
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
	const normalSyntax = vaults.loadState('vault-settings.json')?.normalSyntax === true;
	const base = path.basename(abs).replace(/\.(md|jmd)$/i, '');
	const ext = format === 'html' ? 'html' : format === 'latex' ? 'tex' : 'pdf';

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

	if (format === 'print-pdf') {
		await printNoteToPdf({
			sessionId, callerToken, relPath, outFile: filePath, paperSize: settings.get('printPaperSize'),
		});
		return { output: filePath };
	}

	if (format === 'html') {
		await runWorker({ file: abs, options: { to: 'html', output: filePath, normalSyntax }, cwd });
		return { output: filePath };
	}

	// LaTeX (and PDF via LaTeX): build the .tex next to the requested output
	// so relative graphics resolve, then compile if PDF was asked for.
	const texFile = format === 'latex' ? filePath : filePath.replace(/\.pdf$/i, '.tex');
	await runWorker({ file: abs, options: { to: 'latex', output: texFile, normalSyntax }, cwd });
	if (format === 'latex') return { output: texFile };
	const pdf = await compilePdf(texFile);
	if (pdf !== filePath) fs.copyFileSync(pdf, filePath);
	return { output: filePath };
}
