// The export host's JS halves (UPSTREAM-LATEX-EXPORT-PLAN.md §3, L1 and L2):
// the job the app page builds (src/shim/export-job.js), the outputs the
// worker hands back (src/export/outputs.js), what a .tex needs beside it in
// the share (src/shim/export-references.js), and the export worker itself,
// run under Node by tools/export-note.mjs over the demo vault with the staged
// mp-tikz-wasm: a MetaPost figure in a .tex is a PDF beside it, an image
// embed an \includegraphics of its vault path, Clew's style in the preamble.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportJob, EXPORT_RESTRICTED_CWD } from '../src/shim/export-job.js';
import { exportOutputs, isSafeExportPath } from '../src/export/outputs.js';
import { texReferences } from '../src/shim/export-references.js';

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
	assert.equal(trusted.base, 'A');
	assert.deepEqual(trusted.build.latexStyle, { locale: '', platform: 'ios' }, 'Clew\'s style unless a setting says not (latexStyleWanted)');
	assert.deepEqual(trusted.build.biblify, { bibliography: '/vault/refs.bib', resolve: true }, 'the vault\'s Biblify (vaultBiblify)');
	const styled = (settings) => exportJob({ noteRel: 'A.md', format: 'latex', files, env, trusted: true, settings, locale: 'en-US' }).build.latexStyle;
	assert.deepEqual(styled({ latexExportStyle: 'clew', latexEngine: 'auto' }), { locale: 'en-US', platform: 'ios' });
	assert.equal(styled({ latexExportStyle: 'none' }), null, 'the user\'s configuration only');
	assert.equal(styled({ latexEngine: 'pdflatex' }), null, 'never with pdfLaTeX forced');
	const stale = exportJob({ noteRel: 'Notes/A.md', format: 'latex', env, trusted: true,
		files: { ...files, '/vault/A-figures/old.pdf': '', '/vault/A-figures/.jmarkdown-figures': 'x', '/vault/A-figuresX.md': 'kept', '/vault/Notes/A-figures/k.pdf': '' } });
	assert.deepEqual(Object.keys(stale.init.files).filter((p) => p.includes('-figures')).sort(), ['/vault/A-figuresX.md', '/vault/Notes/A-figures/k.pdf'],
		'the vault\'s folder at the output\'s figures place stays out of the vfs, and nothing else');

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

test('texReferences: what the .tex names and the vault has, at vault paths; bibliographies beside the .tex by the names it uses', () => {
	const vault = new Set(['Attachments/a b.png', 'Attachments/fig.pdf', 'Library/refs.bib', 'Notes/refs.bib', 'Notes/extra.bib', 'Sub/x.jpg']);
	const exists = (r) => vault.has(r);
	const tex = [
		'\\includegraphics[max width=\\linewidth]{Attachments/a b.png}',
		'\\includegraphics{Attachments/fig}',                  // graphicx's own extension search
		'\\includegraphics{"Sub/./x.jpg"}',
		'\\includegraphics{Note-figures/MetaPost/h-1.pdf}',    // the export's own
		'\\includegraphics{../escape.png}',
		'\\includegraphics{/etc/passwd}',
		'\\includegraphics{https://example.com/x.png}',
		'\\includegraphics{Attachments/gone.png}',
		'% \\includegraphics{Attachments/commented.png}',
		'100\\% \\includegraphics{Attachments/a b.png}',      // an escaped % is not a comment
		'\\bibliography{refs, extra,nothere}',
		'\\addbibresource{Library/refs.bib}',
	].join('\n');
	const refs = texReferences({ tex, base: 'Note', exists, bibFiles: ['Library/refs.bib', 'Notes/refs.bib', 'Notes/extra.bib'] });
	assert.deepEqual(refs.files, ['Attachments/a b.png', 'Attachments/fig.pdf', 'Sub/x.jpg']);
	assert.deepEqual(refs.bibs, [
		{ rel: 'Library/refs.bib', as: 'refs.bib' },               // the build's first of that name
		{ rel: 'Notes/extra.bib', as: 'extra.bib' },
		{ rel: 'Library/refs.bib', as: 'Library/refs.bib' },       // a path the .tex names, at that path
	]);
	assert.deepEqual(refs.missing, ['Attachments/gone.png', 'nothere.bib']);
	assert.deepEqual(refs.refused, []);
	assert.deepEqual(texReferences({ tex: '\\documentclass{article}', base: 'N', exists }), { files: [], bibs: [], missing: [], refused: [] });
	assert.deepEqual(texReferences({ tex: '\\bibliography{../up}', base: 'N', exists: () => true, bibFiles: [] }).missing, ['../up.bib'], 'never a path out');
});

test('texReferences carries images graphicx typesets and .bib files, never a hidden folder\'s or a hidden file (Clew-boss\'s review of L2)', () => {
	const vault = new Set(['.git/config', '.obsidian/workspace.json', '.clew/vault-settings.json', '.trash/old.png', 'Attachments/.secret.png',
		'Attachments/a.png', 'Attachments/b.svg', 'Attachments/c.gif', 'Attachments/d.webp', 'Notes/x.md', 'notes.txt', '.git/refs.bib', 'Library/refs.bib',
		'Attachments/e.JPG', 'Attachments/f.eps']);
	const exists = (r) => vault.has(r);
	const tex = [
		'\\includegraphics{.git/config}',
		'\\includegraphics{.obsidian/workspace.json}',
		'\\includegraphics{.clew/vault-settings.json}',
		'\\includegraphics{.trash/old.png}',
		'\\includegraphics{Attachments/.secret.png}',
		'\\includegraphics{Attachments/a.png}',
		'\\includegraphics{Attachments/b.svg}',
		'\\includegraphics{Attachments/c.gif}',
		'\\includegraphics{Attachments/d.webp}',
		'\\includegraphics{Notes/x.md}',
		'\\includegraphics{notes.txt}',
		'\\includegraphics{Attachments/e.JPG}',
		'\\includegraphics{Attachments/f}',              // the extension search finds f.eps
		'\\bibliography{refs}',
		'\\addbibresource{.git/refs.bib}',
	].join('\n');
	const refs = texReferences({ tex, base: 'N', exists, bibFiles: ['.git/refs.bib', 'Library/refs.bib'] });
	assert.deepEqual(refs.files, ['Attachments/a.png', 'Attachments/e.JPG', 'Attachments/f.eps'], 'images graphicx typesets, whatever the case of the extension');
	assert.deepEqual(refs.refused, [
		{ rel: '.clew/vault-settings.json', why: 'hidden' },
		{ rel: '.git/config', why: 'hidden' },
		{ rel: '.git/refs.bib', why: 'hidden' },
		{ rel: '.obsidian/workspace.json', why: 'hidden' },
		{ rel: '.trash/old.png', why: 'hidden' },
		{ rel: 'Attachments/.secret.png', why: 'hidden' },
		{ rel: 'Attachments/b.svg', why: 'not-image' },
		{ rel: 'Attachments/c.gif', why: 'not-image' },
		{ rel: 'Attachments/d.webp', why: 'not-image' },
		{ rel: 'Notes/x.md', why: 'not-image' },
		{ rel: 'notes.txt', why: 'not-image' },
	], 'each said as not shared');
	assert.deepEqual(refs.bibs, [], 'a hidden folder\'s .bib is not carried, whether named by name or by path: the build\'s first refs.bib is the hidden one, and it is refused');
	assert.deepEqual(refs.missing, [], 'nothing refused is reported as missing');
});

test('the export worker bundle carries the figure engine\'s library-by-URL patch (scripts/build.js)', () => {
	const bundle = path.join(root, 'dist', 'export-worker.js');
	assert.ok(fs.existsSync(bundle), 'run scripts/build.js first');
	assert.ok(fs.readFileSync(bundle, 'utf8').includes('__clewMpTikzUrl'));
});

const staged = fs.existsSync(path.join(root, 'mptikz-assets', 'index.js'));
const exportNote = (vault, note, ...flags) => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-export-test-'));
	try {
		const summary = JSON.parse(execFileSync(process.execPath, [path.join(root, 'tools', 'export-note.mjs'), vault, note, out, ...flags],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
		const tex = fs.readFileSync(path.join(out, summary.output), 'utf8');
		const read = (rel) => fs.readFileSync(path.join(out, rel));
		return { summary, tex, read };
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
};

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
			assert.deepEqual(summary.references, { files: [], bibs: [], missing: [], refused: [] }, `${label}: nothing of the vault's to carry; its own figures are its own`);
		} finally {
			fs.rmSync(out, { recursive: true, force: true });
		}
	}
});

test('the export worker under Node (L2): image embeds as their vault paths, the bibliography by name, Clew\'s style and the fenced header', { skip: !staged && 'mptikz-assets/ is not staged' }, () => {
	const seed = path.join(root, 'seed-vault');
	const media = exportNote(seed, 'Features/Media Gallery.md');
	assert.ok(media.tex.includes('\\includegraphics[width=\\textwidth]{Attachments/Waterhouse - Ariadne.jpg}'),
		'an embed resolved across the vault, pointed from the .tex at the vault\'s root (exportEmbedPath)');
	assert.deepEqual(media.summary.references.files, ['Attachments/Burne-Jones - Theseus and the Minotaur.jpg', 'Attachments/NASA - Earthrise.jpg', 'Attachments/Waterhouse - Ariadne.jpg']);
	assert.ok(media.summary.warnings.some((w) => /webm.*only images can be embedded/.test(w)), 'a film is not an image: the engine says so');
	assert.match(media.tex, /\\IfFontExistsTF\{EBGaramond-Regular\.otf\}/, 'Clew\'s style (configureExportBuild)');
	assert.match(media.tex, /\[british\]\{babel\}/, 'in the locale\'s language');
	assert.doesNotMatch(media.tex, /Apple Color Emoji|Noto Color Emoji|Segoe UI Emoji/, 'the `ios` platform names no emoji face');
	const plain = exportNote(seed, 'Features/Media Gallery.md', '--style=none');
	assert.doesNotMatch(plain.tex, /EBGaramond|Clew's export style/, '`none`: the user\'s configuration alone');
	const restricted = exportNote(seed, 'Features/Media Gallery.md', '--restricted');
	assert.deepEqual(restricted.summary.references.files, media.summary.references.files, 'a restricted vault\'s embeds resolve inside it alike');

	const cites = exportNote(seed, 'Features/Citations.md');
	assert.match(cites.tex, /\\bibliography\{refs\}/);
	assert.deepEqual(cites.summary.references.bibs, [{ rel: 'Features/refs.bib', as: 'refs.bib' }], 'the note\'s own .bib, beside the .tex');

	// `Header style: fenced` (cdde7df): a first line that looks like a key is
	// the note's text, not a header that swallows it.
	const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-export-vault-'));
	try {
		fs.writeFileSync(path.join(vault, 'Bare.md'), 'Note: remember this.\n\nThe body follows.\n');
		const bare = exportNote(vault, 'Bare.md');
		assert.match(bare.tex, /Note: remember this\./);
		assert.match(bare.tex, /The body follows\./, 'not exported empty');
	} finally {
		fs.rmSync(vault, { recursive: true, force: true });
	}
});
