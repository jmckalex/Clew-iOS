// "Export notes as PDF (reading view)" on the iPad, measured in the
// simulator (Clew-app 393d482; Clew-boss: prove the batch's PDFs by their
// text). Runs tools/sim-scenarios/export-notes-scenario.js through
// tools/sim-smoke.mjs on a fixture vault: Essays/ with three notes (one in
// a subfolder, each with marking controls in @begin(clew-only)) and a
// drawing, and PDFs/Ann.pdf already there. The batch goes into PDFs/ (in the
// vault) with Keep Both. Then, on the Mac:
//   menu     the Essays folder's long-press menu offers the export
//   sheet    upstream's sheet, the folder's notes ticked
//   report   "Exported 3 PDFs to PDFs.", and Show in Files
//   kept     PDFs/Ann.pdf byte for byte as it was
//   pdfs     Ann 2.pdf, Bob.pdf and Week 2/Cy.pdf: each its note's text
//            (pdftotext), none of what is for Clew only; no drawing's PDF
//   explorer the new PDFs in the explorer at once (the rescan)
//   files    Show in Files opened the Files app
//
//   node tools/sim-export-notes-checks.mjs <Clew.app> [--out <dir>]
// Headless; ends with the app uninstalled and the simulator shut down.
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const appPath = args[0];
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : fs.mkdtempSync(path.join(os.tmpdir(), 'clew-sim-export-notes-'));
if (!appPath) {
	console.error('usage: node tools/sim-export-notes-checks.mjs <Clew.app> [--out <dir>]');
	process.exit(2);
}
const pdftotext = ['/opt/homebrew/bin', '/usr/local/bin', '/Library/TeX/texbin'].map((d) => path.join(d, 'pdftotext')).find((f) => fs.existsSync(f));
const VAULT = 'Export Notes';
const essay = (who) => [
	`# ${who}'s essay`, '',
	'@begin(clew-only)', `Marked: SCREEN-${who.toUpperCase()}-TOGGLE · Grade: SCREEN-${who.toUpperCase()}-GRADE`, '@end(clew-only)', '',
	`The essay by ${who}, KEPT-${who.toUpperCase()}.`, '',
	`A comment @clew-only[SCREEN-${who.toUpperCase()}-INLINE] in a sentence.`, '',
].join('\n');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-export-notes-fixture-'));
fs.mkdirSync(path.join(fixture, 'Essays', 'Week 2'), { recursive: true });
fs.mkdirSync(path.join(fixture, 'PDFs'));
fs.writeFileSync(path.join(fixture, 'Essays', 'Ann.md'), essay('Ann'));
fs.writeFileSync(path.join(fixture, 'Essays', 'Bob.md'), essay('Bob'));
fs.writeFileSync(path.join(fixture, 'Essays', 'Week 2', 'Cy.md'), essay('Cy'));
fs.copyFileSync(path.join(root, 'seed-vault', 'Attachments', 'Round Trip.excalidraw.md'), path.join(fixture, 'Essays', 'Sketch.excalidraw.md'));
const oldAnn = fs.readFileSync(path.join(root, 'seed-vault', 'Attachments', 'sample.pdf'));
fs.writeFileSync(path.join(fixture, 'PDFs', 'Ann.pdf'), oldAnn);
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

const run = spawnSync(process.execPath, [path.join(root, 'tools', 'sim-smoke.mjs'), appPath, path.join(root, 'tools', 'sim-scenarios', 'export-notes-scenario.js'),
	'--fixture', fixture, '--name', VAULT, '--seconds', '240', '--out', OUT,
	'--collect', `Documents/${VAULT}/PDFs`,
	'--default', `ClewSmokeExportDir=${VAULT}/PDFs`, '--default', 'ClewSmokeExisting=keep'], { encoding: 'utf8' });
fs.rmSync(fixture, { recursive: true, force: true });
process.stdout.write(run.stdout);
const lines = run.stdout.split('\n').filter((l) => l.startsWith('smoke-notes: ')).map((l) => l.slice(13));
const line = (head) => lines.find((l) => l.startsWith(head + ' ')) ?? '';

const verdicts = [];
const verdict = (name, ok, detail) => {
	verdicts.push({ name, ok: Boolean(ok), detail });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const pdfs = path.join(OUT, 'collected', 'Documents', VAULT, 'PDFs');
const text = (rel) => (fs.existsSync(path.join(pdfs, rel)) ? execFileSync(pdftotext, [path.join(pdfs, rel), '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ').trim() : null);

verdict('menu: the Essays folder\'s long-press menu offers the export', line('menu').includes('"Export notes as PDF (reading view)…"'), line('menu'));
verdict('sheet: upstream\'s sheet, the folder\'s notes ticked', /title="Export notes in \\"Essays\\" as PDF \(reading view\)"/.test(line('sheet'))
	&& ['Essays/Ann.md', 'Essays/Bob.md', 'Essays/Week 2/Cy.md'].every((p) => line('sheet').includes(p)), line('sheet'));
verdict('report: "Exported 3 PDFs to PDFs.", and Show in Files', line('report').startsWith('report state=done') && line('report').includes('Exported 3 PDFs to PDFs.')
	&& line('buttons') === 'buttons ["Show in Files","Done"]', `${line('report')}; ${line('buttons')}`);
const kept = fs.existsSync(path.join(pdfs, 'Ann.pdf')) && md5(fs.readFileSync(path.join(pdfs, 'Ann.pdf'))) === md5(oldAnn);
verdict('kept: the PDF already there, byte for byte', kept, fs.existsSync(path.join(pdfs, 'Ann.pdf')) ? `md5 ${md5(fs.readFileSync(path.join(pdfs, 'Ann.pdf')))} vs ${md5(oldAnn)}` : 'gone');
for (const [rel, who] of [['Ann 2.pdf', 'Ann'], ['Bob.pdf', 'Bob'], ['Week 2/Cy.pdf', 'Cy']]) {
	const t = text(rel);
	const up = who.toUpperCase();
	verdict(`pdf: ${rel} has ${who}'s essay and nothing for Clew only (pdftotext)`, t && t.includes(`KEPT-${up}`) && t.includes('A comment in a sentence.') && !t.includes('SCREEN-'),
		JSON.stringify(t));
}
const all = fs.existsSync(pdfs) ? fs.readdirSync(pdfs, { recursive: true }).map(String).sort() : [];
verdict('pdfs: the drawing is not a PDF, and nothing else was written', JSON.stringify(all) === JSON.stringify(['Ann 2.pdf', 'Ann.pdf', 'Bob.pdf', 'Week 2', 'Week 2/Cy.pdf']), JSON.stringify(all));
verdict('explorer: the new PDFs in the vault at once', line('explorer') === 'explorer has [true,true,true,true,false]', line('explorer'));
verdict('files: Show in Files opened the Files app', line('revealed') === 'revealed visibility=hidden', `${line('revealed')}; ${line('platform')}`);
const failed = verdicts.filter((v) => !v.ok).length;
fs.writeFileSync(path.join(OUT, 'verdicts.json'), JSON.stringify(verdicts, null, '\t'));
console.log(`${verdicts.length - failed}/${verdicts.length} passed; results in ${OUT}`);
process.exitCode = failed ? 1 : 0;
