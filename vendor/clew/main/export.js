// Note export through the jmarkdown engine — the payoff of building on a
// dual-output engine: the same source exports to polished HTML, LaTeX, or
// (when a TeX toolchain is installed) PDF.
//
// Exports run a fresh one-shot worker with cwd = the NOTE's directory, so the
// normal jmarkdown config cascade applies (global ~/.jmarkdown + any vault
// .jmarkdown/) — deliberately NOT Clew's preview config: exports use the
// engine's own templates (CDN assets, biblify, the user's customizations).
import { dialog } from 'electron';
import { execFile } from 'node:child_process';
import { fork } from 'node:child_process';
import { paths } from './paths.js';
import fs from 'node:fs';
import path from 'node:path';
import { toolchainPath } from './render-service.js';

const WORKER_PATH = paths.engineWorker;

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
 * Export a note. format: 'html' | 'latex' | 'pdf'.
 * Prompts for a destination; returns { output } or { canceled: true }.
 */
export async function exportNote({ win, vaults, relPath, format }) {
	const abs = vaults.resolve(relPath);
	// Exports honor the vault's standard-syntax choice, like previews do.
	const normalSyntax = vaults.loadState('vault-settings.json')?.normalSyntax === true;
	const base = path.basename(abs).replace(/\.(md|jmd)$/i, '');
	const ext = format === 'html' ? 'html' : format === 'latex' ? 'tex' : 'pdf';

	const { canceled, filePath } = await dialog.showSaveDialog(win, {
		title: `Export ${base} as ${ext.toUpperCase()}`,
		defaultPath: path.join(vaults.root, `${base}.${ext}`),
		filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
	});
	if (canceled || !filePath) return { canceled: true };

	if (format === 'html') {
		await runWorker({ file: abs, options: { to: 'html', output: filePath, normalSyntax }, cwd: path.dirname(abs) });
		return { output: filePath };
	}

	// LaTeX (and PDF via LaTeX): build the .tex next to the requested output
	// so relative graphics resolve, then compile if PDF was asked for.
	const texFile = format === 'latex' ? filePath : filePath.replace(/\.pdf$/i, '.tex');
	await runWorker({ file: abs, options: { to: 'latex', output: texFile, normalSyntax }, cwd: path.dirname(abs) });
	if (format === 'latex') return { output: texFile };
	const pdf = await compilePdf(texFile);
	if (pdf !== filePath) fs.copyFileSync(pdf, filePath);
	return { output: filePath };
}
