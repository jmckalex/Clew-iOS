// @begin(clew-only) on the iPad, measured in the simulator (Clew-app
// 50c2e2e, c37ce1c; Clew-boss's ask: prove each PDF by the iPad's own
// output, never by reading the CSS). Runs tools/sim-scenarios/
// clew-only-scenario.js through tools/sim-smoke.mjs on a fixture of its own,
// then reads what the app wrote for the share sheet:
//   reading  the note's reading-view document draws three boxes, every form
//   live     live edit draws the block under its "Clew only" head
//   pdf      Export note as PDF (reading view): pdftotext has the essay and
//            none of what is for Clew only
//   book     Book as PDF (reading view), a chapter with the block: the same
//   html     Export as HTML (the snapshot): the same, and no box
//
//   node tools/sim-clew-only-checks.mjs <Clew.app> [--out <dir>]
// Headless; ends with the app uninstalled and the simulator shut down.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const appPath = args[0];
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : fs.mkdtempSync(path.join(os.tmpdir(), 'clew-sim-clew-only-'));
if (!appPath) {
	console.error('usage: node tools/sim-clew-only-checks.mjs <Clew.app> [--out <dir>]');
	process.exit(2);
}
const pdftotext = ['/opt/homebrew/bin', '/usr/local/bin', '/Library/TeX/texbin'].map((d) => path.join(d, 'pdftotext')).find((f) => fs.existsSync(f));

const SCREEN = ['SCREEN-BLOCK', 'SCREEN-BUTTON', 'SCREEN-INLINE', 'SCREEN-PLUS'];
const KEPT = ['KEPT-ONE', 'KEPT-TWO', 'KEPT-THREE'];
const NOTE = [
	'# Essay', '',
	'@begin(clew-only)', 'Marking controls: *SCREEN-BLOCK*', '', '<button>SCREEN-BUTTON</button>', '@end(clew-only)', '',
	'The essay text, KEPT-ONE.', '',
	'A grade @clew-only[SCREEN-INLINE] in a sentence, KEPT-TWO.', '',
	'@clew-only+[SCREEN-PLUS]', '',
	'End, KEPT-THREE.', '',
].join('\n');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-only-fixture-'));
fs.writeFileSync(path.join(fixture, 'Note.md'), NOTE);
fs.mkdirSync(path.join(fixture, 'Book'));
fs.writeFileSync(path.join(fixture, 'Book', 'Book.md'), '---\nbook: true\ntitle: "A Book"\nchapters:\n  - "[[Chapter One]]"\n---\n\nThe front matter, BOOK-FRONT.\n');
fs.writeFileSync(path.join(fixture, 'Book', 'Chapter One.md'), NOTE.replace('# Essay', '# Chapter One'));

const run = spawnSync(process.execPath, [path.join(root, 'tools', 'sim-smoke.mjs'), appPath, path.join(root, 'tools', 'sim-scenarios', 'clew-only-scenario.js'),
	'--fixture', fixture, '--name', 'Clew Only', '--seconds', '150', '--out', OUT, '--collect', 'tmp'], { encoding: 'utf8' });
fs.rmSync(fixture, { recursive: true, force: true });
process.stdout.write(run.stdout);
const lines = run.stdout.split('\n').filter((l) => l.startsWith('smoke-clewonly: ')).map((l) => l.slice(16));
const line = (head) => lines.find((l) => l.startsWith(head + ' ')) ?? '';

const verdicts = [];
const verdict = (name, ok, detail) => {
	verdicts.push({ name, ok: Boolean(ok), detail });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
/** Text out of the app: the essay kept, nothing for Clew only. */
const leftOut = (text) => SCREEN.every((s) => !text.includes(s)) && KEPT.every((s) => text.includes(s));
const tmp = path.join(OUT, 'collected', 'tmp');
const read = (name, how) => {
	const file = path.join(tmp, name);
	if (!fs.existsSync(file)) return null;
	return how === 'pdf' ? execFileSync(pdftotext, [file, '-'], { encoding: 'utf8' }) : fs.readFileSync(file, 'utf8');
};

verdict('reading: three boxes, every form drawn', line('reading') === 'reading boxes=3 drawn=true', line('reading'));
verdict('live: the block under its "Clew only" head, every form drawn', line('live') === 'live head=true drawn=true', line('live'));
const pdf = read('Note.pdf', 'pdf');
verdict('pdf: the reading-view PDF has the essay and nothing for Clew only (pdftotext)', line('pdf').startsWith('pdf ok') && pdf && leftOut(pdf),
	pdf ? JSON.stringify(pdf.replace(/\s+/g, ' ').trim()) : line('pdf'));
const book = read('Book (reading view).pdf', 'pdf');
verdict('book: the book\'s print has the chapter and nothing for Clew only (pdftotext)', line('book').startsWith('book ok') && book && leftOut(book) && book.includes('BOOK-FRONT'),
	book ? JSON.stringify(book.replace(/\s+/g, ' ').trim()) : line('book'));
const html = read('Note.html', 'text');
verdict('html: the HTML share has the essay, nothing for Clew only, and no box', line('html').startsWith('html ok') && html && leftOut(html) && !/class="[^"]*clew-only/.test(html),
	html ? `${html.length} bytes; ${line('html')}` : line('html'));
const failed = verdicts.filter((v) => !v.ok).length;
fs.writeFileSync(path.join(OUT, 'verdicts.json'), JSON.stringify(verdicts, null, '\t'));
console.log(`${verdicts.length - failed}/${verdicts.length} passed; results in ${OUT}`);
process.exitCode = failed ? 1 : 0;
