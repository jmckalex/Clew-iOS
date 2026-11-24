// `@begin(clew-only)`, `@clew-only[…]` and `@clew-only+[…]` on the iPad
// (Clew-app 50c2e2e, c37ce1c: what is for Clew only — an essay's marking
// controls — drawn in reading view and live edit, out of everything that
// leaves Clew). Upstream's tests/clew-only.test.js, through the iPad's own
// engines:
//   - the preview's (dist/engine-worker.js under tools/render-note.mjs, the
//     config src/shim/engine-config.js generates): each form in its
//     `.clew-only` box, which the staged preview.css hides from print — the
//     reading-view PDF, a book's print and a batch's PDFs. Those PDFs are
//     the simulator's (pdftotext of the iPad's own output, the record);
//   - the export host's (dist/export-worker.js under tools/export-note.mjs,
//     which registers EXPORT_ENVIRONMENTS): nothing in the .tex, nothing in
//     a PDF via LaTeX;
//   - the HTML share (src/shim/html-share.js), a snapshot of the drawn page,
//     where print CSS does not apply: the script removes the boxes, and the
//     shim refuses a page that still has one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_SCRIPT, shareLeaks } from '../src/shim/html-share.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const NOTE = [
	'# Essay',
	'',
	'@begin(clew-only)',
	'Marking controls: *SCREEN-BLOCK*',
	'',
	'<button>SCREEN-BUTTON</button>',
	'@end(clew-only)',
	'',
	'The essay text, KEPT-ONE.',
	'',
	'A grade @clew-only[SCREEN-INLINE] in a sentence, KEPT-TWO.',
	'',
	'@clew-only+[SCREEN-PLUS]',
	'',
	'End, KEPT-THREE.',
	'',
].join('\n');
const SCREEN = ['SCREEN-BLOCK', 'SCREEN-BUTTON', 'SCREEN-INLINE', 'SCREEN-PLUS'];
const KEPT = ['KEPT-ONE', 'KEPT-TWO', 'KEPT-THREE'];

const withVault = (body) => {
	const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-only-'));
	try {
		fs.writeFileSync(path.join(vault, 'Note.md'), NOTE);
		return body(vault);
	} finally {
		fs.rmSync(vault, { recursive: true, force: true });
	}
};
const run = (tool, ...args) => execFileSync(process.execPath, [path.join(root, 'tools', tool), ...args],
	{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const body = (html) => html.slice(html.indexOf('<body'), html.lastIndexOf('</body>'));
/** The text inside each `.clew-only` box, in order. */
const boxes = (html) => [...html.matchAll(/<(div|span)[^>]* class="clew-only">([\s\S]*?)<\/\1>/g)].map((m) => m[2].trim());

/** Nothing of the boxes, the sentences around the inline forms whole. */
function assertLeftOut(text, where) {
	for (const s of SCREEN) assert.ok(!text.includes(s), `${where}: "${s}" left out`);
	for (const s of KEPT) assert.ok(text.includes(s), `${where}: "${s}" kept`);
	assert.ok(!text.includes('clew-only'), `${where}: no box`);
	assert.match(text, /A grade\s+in a sentence, KEPT-TWO\./, `${where}: the sentence around the inline form`);
}

test('the iPad\'s preview config names clew-only.js by its bare path, and the worker\'s registry answers it', () => {
	const config = fs.readFileSync(path.join(root, 'src', 'shim', 'engine-config.js'), 'utf8');
	assert.match(config, /^\t+'\/engine-assets\/clew-only\.js',$/m, 'a bare path: its default export, by name');
	const worker = fs.readFileSync(path.join(root, 'src', 'worker', 'engine-worker.js'), 'utf8');
	assert.match(worker, /'\/engine-assets\/clew-only\.js': clewOnly,/);
	assert.match(worker, /import \* as clewOnly from '\.\.\/\.\.\/vendor\/clew\/engine\/clew-only\.js';/, 'the namespace, whose `default` the engine reads');
});

test('the preview\'s engine on the iPad (reading view, live edit\'s blocks, every reading-view PDF): drawn, each form in its box', () => {
	withVault((vault) => {
		const html = body(run('render-note.mjs', vault, 'Note.md'));
		for (const s of [...SCREEN, ...KEPT]) assert.ok(html.includes(s), `"${s}" is drawn`);
		const inside = boxes(html);
		assert.equal(inside.length, 3, 'the block, the inline and the + form');
		assert.match(inside[0], /<strong[^>]*>SCREEN-BLOCK<\/strong>/, 'its body is markdown');
		assert.match(inside[0], /<button>SCREEN-BUTTON<\/button>/, 'its HTML kept');
		assert.equal(inside[1], 'SCREEN-INLINE');
		assert.equal(inside[2], 'SCREEN-PLUS');
		for (const s of KEPT) assert.ok(!inside.join('').includes(s), `"${s}" is outside every box`);
		assert.match(html, /A grade <span class="clew-only">SCREEN-INLINE<\/span> in a sentence, KEPT-TWO\./, 'the inline form stays in its sentence');
	});
});

test('print hides the box: the preview.css the app serves has the rule in its print block', () => {
	const staged = path.join(root, 'dist', 'webroot', 'engine-assets', 'preview.css');
	assert.ok(fs.existsSync(staged), 'run scripts/build.js first');
	const css = fs.readFileSync(staged, 'utf8');
	const print = css.slice(css.indexOf('@media print {'));
	assert.match(print.slice(0, print.indexOf('\n}')), /\.clew-only \{ display: none !important; \}/);
});

const staged = fs.existsSync(path.join(root, 'mptikz-assets', 'index.js'));
test('a LaTeX export on the iPad (the export host): left out', { skip: !staged && 'mptikz-assets/ is not staged' }, () => {
	withVault((vault) => {
		const out = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-only-tex-'));
		try {
			const summary = JSON.parse(run('export-note.mjs', vault, 'Note.md', out));
			const tex = fs.readFileSync(path.join(out, summary.output), 'utf8');
			const doc = tex.slice(tex.indexOf('\\begin{document}'));
			assertLeftOut(doc, 'LaTeX export');
			assert.match(doc, /\{Essay\}[\s\S]*?\n\nThe essay text, KEPT-ONE\./, 'the paragraph after the block starts a paragraph of its own');
		} finally {
			fs.rmSync(out, { recursive: true, force: true });
		}
	});
});

const poppler = ['/opt/homebrew/bin', '/usr/local/bin', '/Library/TeX/texbin'].find((dir) => fs.existsSync(path.join(dir, 'pdftotext')));
const latexDoc = fs.existsSync(path.join(root, 'mptikz-assets', 'bundles', 'latex-doc'));
test('a PDF via LaTeX on the iPad (the export host and its TeX): left out of the PDF\'s text', { skip: (!latexDoc && 'mptikz-assets/ has no latex-doc bundle') || (!poppler && 'no pdftotext') }, () => {
	withVault((vault) => {
		const out = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-only-pdf-'));
		try {
			const summary = JSON.parse(run('export-note.mjs', vault, 'Note.md', out, '--pdf'));
			const text = execFileSync(path.join(poppler, 'pdftotext'), [path.join(out, summary.output), '-'], { encoding: 'utf8' });
			assertLeftOut(text.replace(/\s+/g, ' '), 'PDF via LaTeX');
		} finally {
			fs.rmSync(out, { recursive: true, force: true });
		}
	});
});

test('the HTML share: the snapshot removes every box before anything else; the shim refuses a page that still has one', () => {
	const strip = "for (const el of doc.querySelectorAll('.clew-only')) { stats.clewOnly++; el.remove(); }";
	assert.ok(SNAPSHOT_SCRIPT.includes(strip), 'the boxes go from the inert copy');
	assert.ok(SNAPSHOT_SCRIPT.indexOf(strip) < SNAPSHOT_SCRIPT.indexOf("doc.querySelectorAll('script, noscript"), 'first: no placeholder is made for an embed inside one');
	const page = (inner) => `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><p>The essay, KEPT-ONE.</p>${inner}</body></html>`;
	const named = 'what the note keeps for Clew only';
	for (const box of ['<div class="clew-only"><p>SCREEN</p></div>', '<p>A <span class="clew-only">grade</span>.</p>',
		'<div class=clew-only>x</div>', '<div class="note-x clew-only">x</div>', '<span class=\'clew-only extra\'>x</span>']) {
		assert.ok(shareLeaks(page(box)).includes(named), box);
	}
	for (const prose of ['<p>Write @begin(clew-only) for marking controls.</p>', '<code>.clew-only { display: none }</code>', '<div class="not-clew-only-x">x</div>']) {
		assert.ok(!shareLeaks(page(prose)).includes(named), `not a box: ${prose}`);
	}
});
