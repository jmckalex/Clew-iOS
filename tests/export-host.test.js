// The export host's JS halves (UPSTREAM-LATEX-EXPORT-PLAN.md §3, L1): the
// job the app page builds (src/shim/export-job.js), the outputs the worker
// hands back (src/export/outputs.js), and the export worker itself, run under
// Node by tools/export-note.mjs over the demo vault with the staged
// mp-tikz-wasm: a MetaPost figure in a .tex is a PDF beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportJob, EXPORT_RESTRICTED_CWD } from '../src/shim/export-job.js';
import { exportOutputs, isSafeExportPath } from '../src/export/outputs.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('exportOutputs: the output and its -figures/ folder, relative to the output\'s folder; the cache stays behind', () => {
	const writes = new Map([
		['/vault/Note.tex', '\\documentclass{article}'],
		['/vault/Note-figures/.jmarkdown-figures', 'marker'],
		['/vault/Note-figures/MetaPost/abc-1.pdf', new Uint8Array([37, 80, 68, 70])],
		['/export/cache/MetaPost/abc-1.pdf', new Uint8Array([37, 80, 68, 70])],
		['/vault/Note-figuresX/stray.pdf', 'not ours'],
		['/vault/Other.tex', 'another output'],
	]);
	assert.deepEqual(exportOutputs(writes, '/vault/Note.tex').map((o) => o.rel),
		['Note-figures/.jmarkdown-figures', 'Note-figures/MetaPost/abc-1.pdf', 'Note.tex']);
	assert.deepEqual(exportOutputs(new Map([['/vault/Sub/A.tex', 'x']]), '/vault/Sub/A.tex').map((o) => o.rel), ['A.tex']);
});

test('isSafeExportPath: relative paths inside the folder only (ExportJobs.swift checks the same)', () => {
	for (const good of ['Note.tex', 'Note-figures/MetaPost/abc-1.pdf', 'a b/c.pdf']) assert.ok(isSafeExportPath(good), good);
	for (const bad of ['', '/etc/hosts', '../x', 'a/../../x', 'a//b', './a', 'a\\b', 'a\0b', 'x'.repeat(513), null]) {
		assert.ok(!isSafeExportPath(bad), JSON.stringify(bad));
	}
});

test('exportJob: one LaTeX build at the vault\'s root; a trusted vault from the note\'s folder, a restricted one from a folder that runs no note code', () => {
	const files = { '/vault/Notes/A.md': 'text', '/engine/default-template.tex.mustache': 'tpl' };
	const env = { CLEW_VAULT_ROOT: '/vault' };
	const trusted = exportJob({ noteRel: 'Notes/A.md', format: 'latex', files, env, trusted: true, vaultOptions: { bibliography: 'refs.bib', normalSyntax: true } });
	assert.equal(trusted.init.cwd, '/vault/Notes');
	assert.equal(trusted.build.file, '/vault/Notes/A.md');
	assert.equal(trusted.build.options.output, '/vault/A.tex');
	assert.deepEqual(trusted.build.options.bibliography, ['/vault/refs.bib'], 'the vault\'s bibliography, for this build');
	assert.equal(trusted.build.options.normalSyntax, true);
	assert.equal(trusted.build.options.figureEngine, 'wasm', 'never the TeX tools: the iPad has none');
	assert.equal(trusted.build.options.copyFigures, true);
	assert.notEqual(trusted.init.files, files, 'the caller\'s snapshot is not changed');

	const restricted = exportJob({ noteRel: 'Notes/A.md', format: 'latex', files, env, trusted: false });
	assert.equal(restricted.init.cwd, EXPORT_RESTRICTED_CWD);
	assert.deepEqual(JSON.parse(restricted.init.files[`${EXPORT_RESTRICTED_CWD}/.jmarkdown/config.json`]), { 'Run note code': false });
	assert.ok(!(`${EXPORT_RESTRICTED_CWD}/.jmarkdown/config.json` in files));
	assert.deepEqual(restricted.build.options.bibliography, []);

	assert.throws(() => exportJob({ noteRel: 'A.md', format: 'html', files, env, trusted: true }), /not an export/);
	for (const bad of ['../A.md', '/etc/A.md', 'A.txt', 'a//A.md', './A.md']) {
		assert.throws(() => exportJob({ noteRel: bad, format: 'latex', files, env, trusted: true }), /not a note/, bad);
	}
});

test('the export worker bundle carries the figure engine\'s library-by-URL patch (scripts/build.js)', () => {
	const bundle = path.join(root, 'dist', 'export-worker.js');
	assert.ok(fs.existsSync(bundle), 'run scripts/build.js first');
	assert.ok(fs.readFileSync(bundle, 'utf8').includes('__clewMpTikzUrl'));
});

const staged = fs.existsSync(path.join(root, 'mptikz-assets', 'index.js'));
test('the export worker under Node: Features/Diagrams.md as LaTeX, its MetaPost figure a PDF in Diagrams-figures/', { skip: !staged && 'mptikz-assets/ is not staged' }, () => {
	for (const flags of [[], ['--restricted']]) {
		const out = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-export-test-'));
		try {
			const summary = JSON.parse(execFileSync(process.execPath,
				[path.join(root, 'tools', 'export-note.mjs'), path.join(root, 'seed-vault'), 'Features/Diagrams.md', out, ...flags],
				{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
			const label = flags.length ? 'restricted' : 'trusted';
			assert.equal(summary.output, 'Diagrams.tex', label);
			const figures = summary.files.filter((f) => /^Diagrams-figures\/MetaPost\/[0-9a-f]{32}-\d+\.pdf$/.test(f.rel));
			assert.equal(figures.length, 1, `${label}: one MetaPost figure, as a PDF`);
			const pdf = fs.readFileSync(path.join(out, figures[0].rel));
			assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-', `${label}: a real PDF`);
			const tex = fs.readFileSync(path.join(out, 'Diagrams.tex'), 'utf8');
			assert.match(tex, /\\documentclass/);
			assert.ok(tex.includes(`\\includegraphics[max width=\\linewidth]{${figures[0].rel}}`), `${label}: the .tex refers to it beside itself`);
			assert.match(tex, /\\begin\{tikzpicture\}/, `${label}: TikZ stays native TeX`);
			assert.ok(!summary.warnings.some((w) => /mp-tikz-wasm would not load|metapost not drawn/.test(w)), `${label}: the library loaded`);
		} finally {
			fs.rmSync(out, { recursive: true, force: true });
		}
	}
});
