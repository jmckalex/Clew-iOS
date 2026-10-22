// The export host's JS halves (UPSTREAM-LATEX-EXPORT-PLAN.md §3, L1 and L2):
// the job the app page builds (src/shim/export-job.js), the outputs the
// worker hands back (src/export/outputs.js), what a .tex needs beside it in
// the share (src/shim/export-references.js), and the export worker itself,
// run under Node by tools/export-note.mjs over the demo vault with the staged
// mp-tikz-wasm: a MetaPost figure in a .tex is a PDF beside it, an image
// embed an \includegraphics of its vault path, Clew's style in the preamble.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { exportJob, EXPORT_RESTRICTED_CWD } from '../src/shim/export-job.js';
import { exportOutputs, isSafeExportPath } from '../src/export/outputs.js';
import { texReferences } from '../src/shim/export-references.js';
import { typeset, DOCUMENT_BUNDLES, MAX_PASSES, SILENCE_MS, LUA_GC } from '../src/export/typeset.js';

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
	const pdf = exportJob({ noteRel: 'A.md', format: 'pdf', files, env, trusted: true, bibFiles: ['refs.bib'] });
	assert.equal(pdf.build.pdf, true, 'PDF via LaTeX: the worker typesets');
	assert.equal(pdf.build.options.to, 'latex');
	assert.deepEqual(pdf.build.bibFiles, ['refs.bib']);
	assert.equal(trusted.build.pdf, false);
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

// PDF via LaTeX under Node (UPSTREAM-LATEX-EXPORT-PLAN.md §4, L3): the iPad's
// path — the .tex written for LuaLaTeX (or lmodern under a header's
// pdfLaTeX), typeset by the staged mp-tikz-wasm 0.5.0 with default + opentype
// + otf-fonts + latex-doc — read back with poppler's pdftotext and pdffonts.
// The Clew-styled cases take ~15 s each; CLEW_PDF_SLOW=1 runs them.
const poppler = (() => {
	for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/Library/TeX/texbin']) {
		if (fs.existsSync(path.join(dir, 'pdffonts')) && fs.existsSync(path.join(dir, 'pdftotext'))) return dir;
	}
	return null;
})();
const latexDoc = fs.existsSync(path.join(root, 'mptikz-assets', 'bundles', 'latex-doc'));
const pdfSkip = (!latexDoc && 'mptikz-assets/ has no latex-doc bundle (0.5.0)') || (!poppler && 'no pdftotext/pdffonts');
const exportPdf = (vault, note, ...flags) => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-pdf-test-'));
	try {
		const summary = JSON.parse(execFileSync(process.execPath, [path.join(root, 'tools', 'export-note.mjs'), vault, note, out, '--pdf', ...flags],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
		const file = path.join(out, summary.output);
		const tool = (name, ...args) => execFileSync(path.join(poppler, name), [...args, file, ...(name === 'pdftotext' ? ['-'] : [])], { encoding: 'utf8' });
		return { summary, text: tool('pdftotext'), fonts: tool('pdffonts'), head: fs.readFileSync(file).subarray(0, 5).toString('latin1') };
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
};
const withVault = (notes, body) => {
	const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-pdf-vault-'));
	try {
		for (const [name, text] of Object.entries(notes)) fs.writeFileSync(path.join(vault, name), text);
		return body(vault);
	} finally {
		fs.rmSync(vault, { recursive: true, force: true });
	}
};

test('PDF via LaTeX (L3): an unstyled note is LuaLaTeX in Latin Modern, its Unicode intact; a header\'s pdfLaTeX gets lmodern, no Type 3; unicode-math falls back to LatinModernMath', { skip: pdfSkip }, () => {
	withVault({
		'Unicode.md': '# Signs\n\nAn en dash – in 1–2, a times sign 3 × 4, “curly quotes” and ‘single’, ÿ é ß Œ.\n',
		'Forced.md': '---\nLaTeX engine: pdflatex\n---\n# Forced\n\nAn en dash – and 3 × 4 and “quotes”.\n',
		'UMaths.md': '---\nPackages: unicode-math\n---\n# Maths\n\nEuler: $e^{i\\pi} + 1 = 0$.\n',
	}, (vault) => {
		const uni = exportPdf(vault, 'Unicode.md', '--style=none');
		assert.equal(uni.head, '%PDF-');
		assert.equal(uni.summary.stats.engine, 'lualatex', 'no engine forced: LuaLaTeX (the owner\'s (a))');
		assert.ok(uni.text.includes('An en dash – in 1–2, a times sign 3 × 4, “curly quotes” and ‘single’'), `the characters come back: ${uni.text}`);
		assert.ok(uni.text.includes('ÿ é ß Œ'));
		assert.match(uni.fonts, /LMRoman10-Regular\s+CID Type 0C/, 'Latin Modern OpenType');
		assert.doesNotMatch(uni.fonts, /Type 3/);

		const forced = exportPdf(vault, 'Forced.md', '--style=none');
		assert.equal(forced.summary.stats.engine, 'pdflatex', 'the header\'s engine wins');
		assert.ok(forced.text.includes('An en dash – and 3 × 4 and “quotes”'), `pdfLaTeX's T1 text intact: ${forced.text}`);
		assert.match(forced.fonts, /LMRoman10-Regular\s+Type 1 /, 'lmodern\'s Type 1 (`LaTeX T1 fonts: lmodern`)');
		assert.doesNotMatch(forced.fonts, /Type 3/, 'no bitmap fallback: no cm-super needed');

		const umaths = exportPdf(vault, 'UMaths.md', '--style=none');
		assert.match(umaths.fonts, /LatinModernMath-Regular/, 'unicode-math with no maths font named: otf-fonts\' latinmodern-math');
		assert.doesNotMatch(umaths.fonts, /CMMI/);
	});
});

test('PDF via LaTeX (L3), Clew\'s style: maths in Garamond-Math; a header\'s own preamble falls back to LatinModernMath; BibTeX\'s references', { skip: pdfSkip || (!process.env.CLEW_PDF_SLOW && 'CLEW_PDF_SLOW=1 runs the styled cases (~50 s)') }, () => {
	withVault({
		'Maths.md': '# Maths\n\nEuler: $e^{i\\pi} + 1 = 0$, and\n\n$$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$\n',
		'Own.md': '---\nLaTeX preamble: \\newcommand{\\R}{\\mathbb{R}}\n---\n# Own preamble\n\nIn $\\R^n$, $e^{i\\pi} + 1 = 0$.\n',
	}, (vault) => {
		const maths = exportPdf(vault, 'Maths.md');
		assert.match(maths.fonts, /EBGaramond-Regular/);
		assert.match(maths.fonts, /Garamond-Math/, 'latex-doc carries Garamond-Math (Clew-boss\'s correction of §4 P1)');
		assert.doesNotMatch(maths.fonts, /LatinModernMath|CMMI/);
		const own = exportPdf(vault, 'Own.md');
		assert.match(own.fonts, /LatinModernMath-Regular/, 'the style\'s packages load, its \\setmathfont does not: otf-fonts\' latinmodern-math');
		assert.doesNotMatch(own.fonts, /CMMI/);
	});
	const cites = exportPdf(path.join(root, 'seed-vault'), 'Features/Citations.md');
	assert.equal(cites.summary.stats.bibtex, true, 'BibTeX ran');
	assert.match(cites.text, /Lewis \[1969\]/);
	assert.match(cites.text, /David Lewis\. Convention: A Philosophical Study\. Harvard University Press/);
	assert.doesNotMatch(cites.fonts, /Type 3/);
});

// A NEW instance per pass (§4 P2, mp-tikz-wasm's sandbox review; per pass
// since p3f): what one export leaves in /texmf-var is not there for the
// next. One instance keeps /texmf-var from run to run
// (core.js#collectTexmfVar, luaotfload's warm cache), and a document's Lua
// may write there. PLANT writes a file and has luaotfload cache EB Garamond,
// a face PROBE never loads; PROBE prints what it finds, and writes a file of
// its own on every pass, which its later passes no longer find (until p3f
// one export's passes shared an instance, and did).
const PLANT = String.raw`\documentclass{article}\usepackage{fontspec}\setmainfont{EBGaramond-Regular.otf}
\directlua{local f = io.open('/texmf-var/clew-planted.txt', 'w') f:write('planted') f:close()}
\begin{document}Planted.\end{document}`;
const PROBE = String.raw`\documentclass{article}\usepackage{fontspec}
\begin{document}
\directlua{
  local function has(p) local f = io.open(p, 'r') if f then f:close() return true end return false end
  local garamond = 'absent'
  local function walk(d)
    for name in lfs.dir(d) do
      if name ~= '.' and name ~= '..' then
        local p = d .. '/' .. name
        if lfs.attributes(p, 'mode') == 'directory' then walk(p) elseif name:find('ebgaramond', 1, true) then garamond = 'present' end
      end
    end
  end
  walk('/texmf-var')
  local own = has('/texmf-var/clew-own.txt') and 'present' or 'absent'
  local f = io.open('/texmf-var/clew-own.txt', 'w') f:write('own') f:close()
  tex.sprint('planted=' .. (has('/texmf-var/clew-planted.txt') and 'present' or 'absent') .. ' garamond=' .. garamond .. ' own=' .. own)
}
\end{document}`;

test('PDF via LaTeX: each pass a NEW instance — a file one export\'s Lua left in /texmf-var, and luaotfload\'s cache of its face, are not there for the next export, nor a pass\'s for the next pass', { skip: pdfSkip }, async () => {
	const lib = await import(pathToFileURL(path.join(root, 'mptikz-assets', 'index.js')).href);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-texmf-var-'));
	const text = (pdf, name) => {
		fs.writeFileSync(path.join(dir, name), pdf);
		return execFileSync(path.join(poppler, 'pdftotext'), [path.join(dir, name), '-'], { encoding: 'utf8' });
	};
	try {
		// The probe sees what one instance carries: run on ONE instance, after
		// PLANT, it finds both.
		const mp = await lib.MetaPost.create({ bundles: [...lib.DEFAULT_BUNDLES, ...DOCUMENT_BUNDLES], logLevel: 'silent' });
		try {
			await mp.latex(PLANT, { engine: 'lualatex', output: 'pdf', jobName: 'doc', date: 'fixed', files: {} });
			const carried = await mp.latex(PROBE, { engine: 'lualatex', output: 'pdf', jobName: 'doc', date: 'fixed', files: {} });
			assert.match(text(carried.pdf, 'carried.pdf'), /planted=present garamond=present own=absent/, 'one instance carries /texmf-var: what typeset must never share');
		} finally {
			mp.dispose();
		}

		const alone = await typeset({ lib, tex: PROBE, date: 'fixed' });
		assert.match(text(alone.pdf, 'alone.pdf'), /planted=absent garamond=absent own=absent/, 'its own passes no longer share one (p3f)');
		const planted = await typeset({ lib, tex: PLANT, date: 'fixed' });
		assert.equal(planted.engine, 'lualatex');
		const after = await typeset({ lib, tex: PROBE, date: 'fixed' });
		assert.match(text(after.pdf, 'after.pdf'), /planted=absent garamond=absent own=absent/, 'the export after PLANT finds nothing of it');
		assert.ok(Buffer.from(after.pdf).equals(Buffer.from(alone.pdf)), 'and typesets byte for byte as it does with nothing before it');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// §5's security cases (3): PDF via LaTeX in a vault this device does not
// trust (the export worker as the app runs it, a restricted job, TeX
// recorded by tools/mptikz-spy.mjs). Each names something that EXISTS on this
// machine, outside the vault or by an absolute path: /etc/hosts, a file
// whose text is a marker, an image, the vault's own image by its absolute
// path, a link leading out. TeX's file system is mp-tikz-wasm's own, and is
// handed only what the job gives it (§4 P2, "the files handed in"), so each
// is TeX's own "not found", and its content is in no run's log. Desktop
// refuses PDF via LaTeX in such a vault outright (latexPdfRefusal); the iPad
// typesets, the owner's (3), because nothing outside reaches its TeX.
const MARKER = 'CLEWOUTSIDEMARKER';
const withOutside = (notes, body) => {
	const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clew-restricted-')));
	try {
		const outside = path.join(top, 'outside');
		const vault = path.join(top, 'vault');
		fs.mkdirSync(outside);
		fs.mkdirSync(vault);
		const image = path.join(root, 'seed-vault', 'Attachments', 'NASA - Earthrise.jpg');
		fs.writeFileSync(path.join(outside, 'secret.tex'), `${MARKER}\n`);
		fs.copyFileSync(image, path.join(outside, 'secret.jpg'));
		fs.copyFileSync(image, path.join(vault, 'inside.jpg'));
		fs.symlinkSync('../outside/secret.jpg', path.join(vault, 'escape.jpg'));
		for (const [name, text] of Object.entries(notes(top))) fs.writeFileSync(path.join(vault, name), text);
		return body(vault, top);
	} finally {
		fs.rmSync(top, { recursive: true, force: true });
	}
};
/** A restricted PDF export with TeX recorded: `{ ok, summary | error, texRuns, vaultReads, refusedLinks, images }`. */
const restrictedPdf = (vault, note) => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-pdf-test-'));
	try {
		const run = spawnSync(process.execPath, [path.join(root, 'tools', 'export-note.mjs'), vault, note, out, '--pdf', '--restricted', '--style=none', '--spy'],
			{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
		const answer = JSON.parse(run.stdout);
		if (run.status !== 0) return { ok: false, ...answer };
		const file = path.join(out, answer.output);
		// `pdfimages -list`: two header lines, then one line per image.
		const images = execFileSync(path.join(poppler, 'pdfimages'), ['-list', file], { encoding: 'utf8' }).trim().split('\n').length - 2;
		return { ok: true, ...answer, images, bytes: fs.statSync(file).size };
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
};
/** Only what TeX makes for itself between passes (doc.aux, doc.out…): never a file of the device's. */
const onlyOwnArtifacts = (texRuns) => texRuns.every((r) => r.files.every((f) => /^doc\.[a-z]+$/.test(f)));
const restrictedSkip = pdfSkip || (!fs.existsSync(path.join(poppler ?? '', 'pdfimages')) && 'no pdfimages');

test('PDF via LaTeX in a restricted vault: `\\input{/etc/hosts}` in a note fails with TeX\'s own "not found"; nothing of the file reaches TeX', { skip: restrictedSkip }, () => {
	const hosts = fs.readFileSync('/etc/hosts', 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
	assert.ok(hosts.length, '/etc/hosts has entries on this machine');
	withOutside(() => ({ 'Input.md': '# Input\n\nBefore.\n\n\\input{/etc/hosts}\n\nAfter.\n' }), (vault) => {
		const r = restrictedPdf(vault, 'Input.md');
		assert.equal(r.ok, false, 'no PDF');
		assert.match(r.error, /^PDF via LaTeX failed — LuaLaTeX ran .*First error: ! LaTeX Error: File `\/etc\/hosts\.tex' not found\./, 'in desktop\'s words (pdfViaLatexFailure)');
		assert.deepEqual(r.texRuns[0].files, [], 'TeX was handed nothing');
		assert.equal(r.texRuns.length, 1, 'the first pass wrote no PDF: no second or third');
		assert.ok(onlyOwnArtifacts(r.texRuns));
		assert.deepEqual(r.vaultReads, []);
		for (const line of hosts) assert.ok(r.texRuns.every((run) => !run.log.includes(line)), `no log holds "${line}"`);
	});
});

test('PDF via LaTeX in a restricted vault: an image by a device path (outside the vault, or the vault\'s own by its absolute path) is left out, TeX\'s "not found"; the PDF has no image', { skip: restrictedSkip }, () => {
	withOutside((top) => ({ 'Device.md': `# Device\n\n![outside](${top}/outside/secret.jpg)\n\n![own, absolute](${top}/vault/inside.jpg)\n\nThe end.\n` }), (vault, top) => {
		const r = restrictedPdf(vault, 'Device.md');
		assert.equal(r.ok, true, 'desktop\'s rule: a PDF with errors is still the PDF (nonstopmode)');
		assert.deepEqual(r.vaultReads, [], 'an absolute path is not a vault path: the job asks the route for nothing');
		assert.ok(onlyOwnArtifacts(r.texRuns), 'TeX was handed none of them');
		// TeX's log wraps at 79 columns: read it unwrapped.
		const log = r.texRuns.at(-1).log.replace(/\n/g, '');
		for (const name of [`${top}/outside/secret.jpg`, `${top}/vault/inside.jpg`]) {
			assert.ok(log.includes(`File \`${name}' not found`), `TeX's own "not found" for ${name}`);
		}
		assert.equal(r.images, 0, 'no image in the PDF');
		assert.ok(r.bytes < 100_000, `a PDF without the 311 KB image (${r.bytes} bytes)`);
	});
});

test('PDF via LaTeX in a restricted vault: an embed of a link leading out of the vault is not listed, not read, not handed to TeX; the PDF goes without it, said', { skip: restrictedSkip }, () => {
	withOutside(() => ({ 'Link.md': '# Link\n\n![[escape.jpg]]\n\n![md](escape.jpg)\n\nThe end.\n' }), (vault) => {
		const r = restrictedPdf(vault, 'Link.md');
		assert.equal(r.ok, true);
		assert.deepEqual(r.refusedLinks, ['escape.jpg'], 'the vault\'s listing skips it (VaultStore.walk)');
		assert.deepEqual(r.vaultReads, [], 'so the job never asks for it');
		assert.ok(r.warnings.includes('escape.jpg is named by the .tex but is not in this vault'), 'and says so');
		assert.ok(onlyOwnArtifacts(r.texRuns));
		assert.ok(r.texRuns.at(-1).log.includes('File `escape.jpg\' not found'));
		assert.equal(r.images, 0, 'no image in the PDF');
	});
});

test('PDF via LaTeX in a restricted vault: a `LaTeX preamble` header naming an absolute path fails with TeX\'s "not found"; the file\'s text is in no log', { skip: restrictedSkip }, () => {
	withOutside((top) => ({ 'Preamble.md': `---\nLaTeX preamble: \\input{${top}/outside/secret.tex}\n---\n# Preamble\n\nThe end.\n` }), (vault, top) => {
		assert.equal(fs.readFileSync(path.join(top, 'outside', 'secret.tex'), 'utf8'), `${MARKER}\n`, 'the file is there on this machine');
		const r = restrictedPdf(vault, 'Preamble.md');
		assert.equal(r.ok, false, 'no PDF');
		assert.match(r.error, /First error: ! LaTeX Error: File `.*secret\.tex' not found\./s);
		assert.ok(r.texRuns[0].log.replace(/\n/g, '').includes(`File \`${top}/outside/secret.tex' not found`), 'TeX looked for that very path');
		assert.equal(r.texRuns.length, 1, 'the first pass wrote no PDF: no second or third');
		assert.ok(onlyOwnArtifacts(r.texRuns), 'and was handed nothing of the device\'s');
		assert.ok(r.texRuns.every((run) => !run.log.includes(MARKER)), 'the marker is in no log');
		assert.ok(!r.error.includes(MARKER));
	});
});

// The PDFs of p3f's passes (an instance each, the eager-GC line) against
// p3e's (one instance per export): the same pages, images, fonts and text,
// for five notes, styled and unstyled. tests/fixtures/pdf-via-latex.json
// holds p3e's, recorded with CLEW_PDF_RECORD=1 at 0e7d8af's typeset.js.
// Long and Many are the simulator's (UPSTREAM-LATEX-EXPORT-PLAN.md §4): 40
// sections with maths, and 40 MetaPost figures with TeX labels.
const LONG_SENTENCES = 'Conventions arise when agents with a common interest in coordination settle on one of several equilibria; the stability of the outcome depends on expectations, not on any intrinsic merit of the choice. Suppose each agent receives a payoff $u_i(s) = \\sum_{j \\ne i} a_{ij} x_j - c\\,x_i^2$ – a quadratic cost – and adjusts by the replicator dynamic “in continuous time”. ';
const LONG_DISPLAY = '$$\\dot x_i = x_i\\left(f_i(x) - \\bar f(x)\\right), \\quad \\bar f(x) = \\sum_j x_j f_j(x)$$';
const LONG_NOTE = `# A long note\n\n${Array.from({ length: 40 }, (_, i) => `## Section ${i + 1}\n\n${LONG_SENTENCES}${LONG_SENTENCES}\n\n${LONG_DISPLAY}\n\n${LONG_SENTENCES}\n\n`).join('')}`.replace(/\n$/, '');
const MANY_NOTE = `# Many figures\n\n${Array.from({ length: 40 }, (_, i) => `@begin(metapost)\nbeginfig(${i + 1});\nfor k=0 upto ${20 + i}: draw (k*3,0)--(0,k*3); endfor;\nlabel(btex $\\sum_{n=1}^{${i + 2}} n^2$ etex, (30,30));\nendfig;\n@end(metapost)\n\n`).join('')}`.replace(/\n$/, '');
const PDF_GOLDENS = path.join(root, 'tests', 'fixtures', 'pdf-via-latex.json');

/** What a PDF is, for comparing two builds: pages, each image's size and colour, each font's name and type, the text's hash. */
const pdfFacts = (vault, note, style) => {
	const out = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-pdf-facts-'));
	try {
		const summary = JSON.parse(execFileSync(process.execPath, [path.join(root, 'tools', 'export-note.mjs'), vault, note, out, '--pdf', `--style=${style}`],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }));
		const file = path.join(out, summary.output);
		const tool = (name, ...args) => execFileSync(path.join(poppler, name), [...args, file, ...(name === 'pdftotext' ? ['-'] : [])], { encoding: 'utf8' });
		const pages = Number(/^Pages:\s+(\d+)/m.exec(tool('pdfinfo'))[1]);
		const images = tool('pdfimages', '-list').trim().split('\n').slice(2).map((l) => l.trim().split(/\s+/)).map((c) => `${c[3]}x${c[4]} ${c[5]} ${c[8]}`);
		const fontLines = tool('pdffonts').split('\n');
		const fonts = [...new Set(fontLines.slice(2).filter(Boolean).map((l) => `${l.slice(0, 36).trim().replace(/^[A-Z]{6}\+/, '')} (${l.slice(37, 54).trim()})`))].sort();
		const text = tool('pdftotext').replace(/[ \t]+$/gm, '');
		return { pages, images, fonts, text: createHash('sha256').update(text).digest('hex'), chars: text.length };
	} finally {
		fs.rmSync(out, { recursive: true, force: true });
	}
};

test('PDF via LaTeX (p3f): a pass an instance and the eager-GC line change nothing — Citations, Long, Media Gallery, Diagrams and 40 figures, styled and unstyled, as p3e made them', { skip: pdfSkip || (!process.env.CLEW_PDF_SLOW && 'CLEW_PDF_SLOW=1 runs it (~2 min)') }, () => {
	const seed = path.join(root, 'seed-vault');
	const facts = {};
	withVault({ 'Long.md': LONG_NOTE, 'Many.md': MANY_NOTE }, (vault) => {
		for (const style of ['clew', 'none']) {
			for (const [name, dir, note] of [['Citations', seed, 'Features/Citations.md'], ['Long', vault, 'Long.md'], ['Media Gallery', seed, 'Features/Media Gallery.md'], ['Diagrams', seed, 'Features/Diagrams.md'], ['Many', vault, 'Many.md']]) {
				facts[`${name}, ${style}`] = pdfFacts(dir, note, style);
			}
		}
	});
	if (process.env.CLEW_PDF_RECORD) {
		fs.mkdirSync(path.dirname(PDF_GOLDENS), { recursive: true });
		fs.writeFileSync(PDF_GOLDENS, `${JSON.stringify(facts, null, '\t')}\n`);
		return;
	}
	const golden = JSON.parse(fs.readFileSync(PDF_GOLDENS, 'utf8'));
	assert.deepEqual(Object.keys(facts).sort(), Object.keys(golden).sort());
	for (const [key, want] of Object.entries(golden)) assert.deepEqual(facts[key], want, key);
	assert.equal(golden['Many, clew'].pages, 9, 'the figures are there: 40 of them, 9 pages');
	assert.ok(golden['Media Gallery, clew'].images.length === 3, 'and the images');
});

// typeset() against a stand-in library: what it asks mp-tikz-wasm for, in what
// order, and what it refuses — without TeX.
const fakeLib = ({ aux = '', idx = false, rerun = 0, pdf = true, status = 'ok', firstFails = false, stall = false } = {}) => {
	const calls = [];
	let runs = 0;
	const lib = {
		DEFAULT_BUNDLES: ['core'],
		MetaPost: {
			create: async (options) => {
				calls.push(['create', options.bundles.join(','), options.timeoutMs]);
				return {
					latex: async (tex, o) => {
						runs += 1;
						calls.push(['latex', o.engine, Object.keys(o.files).sort().join(','), tex]);
						if (stall) throw new Error('mp-tikz-wasm: latex made no progress for 60000 ms; worker terminated');
						const artifacts = { 'doc.aux': new TextEncoder().encode(aux + `%pass${runs}`) };
						if (idx) artifacts['doc.idx'] = new Uint8Array(1);
						if (firstFails) return { status: 'fatal', pdf: undefined, artifacts, texLog: '! LaTeX Error: File `/etc/hosts.tex\' not found.\n\nType X to quit or <RETURN> to proceed,\n' };
						return { status, pdf: pdf ? new Uint8Array([37, 80, 68, 70]) : undefined, artifacts,
							texLog: runs <= 2 + rerun ? (runs > 2 ? 'Rerun to get cross-references right' : '') : '' };
					},
					bibtex: async (o) => { calls.push(['bibtex', Object.keys(o.files).sort().join(',')]); return { artifacts: { 'doc.bbl': 'bbl' }, diagnostics: [{ message: 'warning$ -- empty year' }] }; },
					makeindex: async (o) => { calls.push(['makeindex', o.input]); return { artifacts: { 'doc.ind': 'ind' }, diagnostics: [] }; },
					dispose: () => calls.push(['dispose']),
				};
			},
		},
	};
	return { lib, calls };
};

test('typeset: latexmk\'s passes, each over a NEW instance, the last disposed before the next is made, each handed the inputs; BibTeX and makeindex only when asked; reruns capped; XeLaTeX refused in words', async () => {
	const tex = '\\documentclass{article}\\usepackage{fontspec}\\begin{document}x\\end{document}';
	const PASS = ['create', 'latex', 'dispose'];
	let { lib, calls } = fakeLib();
	const plain = await typeset({ lib, tex, inputs: { 'N-figures/f.pdf': new Uint8Array(1) } });
	assert.deepEqual(calls.map((c) => c[0]), [...PASS, ...PASS, ...PASS], 'three passes, an instance each, each gone before the next (p3f)');
	assert.equal(calls[0][1], ['core', ...DOCUMENT_BUNDLES].join(','), 'default + opentype + otf-fonts + latex-doc');
	assert.equal(calls[1][1], 'lualatex', 'fontspec: LuaLaTeX (chooseLatexEngine)');
	assert.equal(calls[1][2], 'N-figures/f.pdf', 'the first pass sees the inputs alone');
	assert.deepEqual(calls.filter((c) => c[0] === 'latex').map((c) => c[2].split(',')[0]), ['N-figures/f.pdf', 'N-figures/f.pdf', 'N-figures/f.pdf'],
		'every pass is handed the inputs again: a new instance has none');
	assert.deepEqual([plain.engine, plain.passes, plain.bibtex, plain.makeindex], ['lualatex', 3, false, false]);

	({ lib, calls } = fakeLib({ aux: '\\bibdata{refs}', idx: true }));
	const cited = await typeset({ lib, tex: '\\documentclass{article}\\begin{document}\\end{document}', inputs: { 'refs.bib': '@book{a,}' } });
	assert.deepEqual(calls.map((c) => c[0]), ['create', 'latex', 'bibtex', 'makeindex', 'dispose', ...PASS, ...PASS], 'BibTeX and makeindex on the first pass\'s instance');
	assert.equal(calls[1][1], 'latex', 'nothing Unicode: pdfLaTeX');
	assert.equal(calls[2][1], 'doc.aux,doc.idx,refs.bib', 'BibTeX is handed the artifacts and the bibliography');
	assert.match(calls[6][2], /doc\.bbl.*doc\.ind.*refs\.bib/, 'the second pass reads the .bbl and the .ind');
	assert.match(calls[9][2], /doc\.bbl.*doc\.ind.*refs\.bib/, 'and so does the third: a run returns only what TeX wrote, and a new instance keeps nothing');
	assert.deepEqual(cited.warnings, ['BibTeX: warning$ -- empty year']);

	({ lib, calls } = fakeLib({ rerun: 10 }));
	const capped = await typeset({ lib, tex });
	assert.equal(capped.passes, MAX_PASSES, 'a log that keeps asking stops at five passes');
	assert.equal(calls.filter((c) => c[0] === 'create').length, MAX_PASSES);

	({ lib, calls } = fakeLib({ pdf: false }));
	await assert.rejects(typeset({ lib, tex }), /PDF via LaTeX failed — LuaLaTeX ran \(the document needs a Unicode engine/);
	assert.equal(calls.at(-1)[0], 'dispose', 'a failure disposes too');

	({ lib, calls } = fakeLib());
	await assert.rejects(typeset({ lib, tex: '\\usepackage{xeCJK}' }), /needs XeLaTeX .* which the iPad's TeX does not have/);
	assert.equal(calls.length, 0, 'refused before any engine starts');
});

test('typeset: under LuaLaTeX, TeX is handed the .tex behind the eager-GC line, on its first line; under pdfLaTeX, the .tex as it is', async () => {
	const lualatex = '\\documentclass{article}\\usepackage{fontspec}\n\\begin{document}x\\end{document}';
	let { lib, calls } = fakeLib();
	await typeset({ lib, tex: lualatex });
	const sources = calls.filter((c) => c[0] === 'latex').map((c) => c[3]);
	assert.equal(sources.length, 3);
	assert.ok(sources.every((s) => s === LUA_GC + lualatex), 'every LuaLaTeX pass, the line in front, the .tex otherwise untouched');
	assert.equal(sources[0].split('\n').length, lualatex.split('\n').length, 'no line number moves');
	assert.match(LUA_GC, /^\\directlua\{collectgarbage\("setpause", 100\) collectgarbage\("setstepmul", 400\)\}$/);

	const pdflatex = '\\documentclass{article}\n\\begin{document}x\\end{document}';
	({ lib, calls } = fakeLib());
	await typeset({ lib, tex: pdflatex });
	assert.ok(calls.filter((c) => c[0] === 'latex').every((c) => c[1] === 'latex' && c[3] === pdflatex), 'pdfLaTeX: never the line');
});

test('typeset: mp-tikz-wasm\'s stall watchdog at 60 s, a safety net under Clew\'s limit; its stop said in desktop\'s words', async () => {
	const tex = '\\documentclass{article}\\usepackage{fontspec}\\begin{document}x\\end{document}';
	let { lib, calls } = fakeLib();
	await typeset({ lib, tex });
	assert.equal(SILENCE_MS, 60_000, 'past a slow iPad\'s silent stretch, well inside Clew\'s three minutes');
	assert.equal(calls[0][2], SILENCE_MS, 'the instance is made with it (`timeoutMs`)');

	({ lib, calls } = fakeLib({ stall: true }));
	await assert.rejects(typeset({ lib, tex }), (err) => {
		assert.match(err.message, /^PDF via LaTeX failed — LuaLaTeX ran \(the document needs a Unicode engine.*\)\. First error: TeX went 60 seconds without any output and was stopped$/);
		assert.doesNotMatch(err.message, /mp-tikz-wasm|worker terminated/, 'not the library\'s words');
		return true;
	});
	assert.deepEqual(calls.map((c) => c[0]), ['create', 'latex', 'dispose'], 'and the instance goes');
});

test('typeset: a first pass that writes no PDF ends it, said from its log; one that writes a PDF despite errors goes on (desktop\'s nonstopmode rule)', async () => {
	const tex = '\\documentclass{article}\\usepackage{fontspec}\\begin{document}\\input{/etc/hosts}\\end{document}';
	let { lib, calls } = fakeLib({ firstFails: true });
	await assert.rejects(typeset({ lib, tex }), /PDF via LaTeX failed — LuaLaTeX ran .*First error: ! LaTeX Error: File `\/etc\/hosts\.tex' not found\./);
	assert.deepEqual(calls.map((c) => c[0]), ['create', 'latex', 'dispose'], 'one pass, not three');

	({ lib, calls } = fakeLib({ status: 'error' }));
	const kept = await typeset({ lib, tex });
	assert.equal(kept.passes, 3, 'errors with a PDF: the passes go on, and the PDF is the result');
	assert.deepEqual(calls.map((c) => c[0]), ['create', 'latex', 'dispose', 'create', 'latex', 'dispose', 'create', 'latex', 'dispose']);
});
