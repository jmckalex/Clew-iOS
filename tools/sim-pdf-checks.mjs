// PDF via LaTeX in the simulator (UPSTREAM-LATEX-EXPORT-PLAN.md §5, owed
// before P3): what needs the app itself — native's `vault/` route and its
// clamp, a page and an engine per export, the export's time limit. Headless:
// simctl only, never Simulator.app, never a keystroke. A Debug build's
// ClewSmokeJS hook drives the export host (export-host.js#run, the path
// "Export note as PDF (via LaTeX)" takes, less the share sheet); the Mac
// reads each PDF from the app's tmp/clew-export/ while the job still has it.
//
//   node tools/sim-pdf-checks.mjs <Clew.app> [--sim <udid>] [--only texmf,limit,restricted] [--out <dir>]
//
// Everything runs in a vault this device does not trust: a folder in
// Documents, opened by path (Clew-boss's §5 cases are a restricted vault's).
//
//   texmf       In ONE app session, Plant's export writes a file into
//               /texmf-var and has luaotfload cache EB Garamond; Probe's
//               export, next, finds neither. Probe also writes a file of its
//               own on every pass, which its later passes do not find: each
//               pass is an instance of its own (p3f). The Node test shows on
//               one instance that the probe sees a carried file.
//   limit       With the Debug limit at 30 s (ClewExportTimeout), a note whose
//               preamble loops forever, printing a line every half second or
//               so, is stopped by Clew's limit ("took too long"); its page's
//               process is gone and no job folder is left. So is a loop that
//               prints nothing: mp-tikz-wasm's own stall watchdog (in the
//               export host TeX runs in a worker of its own) waits 60 s
//               without a line (typeset.js's SILENCE_MS). With the limit at
//               90 s, the watchdog stops it at 60 s, said in desktop's words.
//   restricted  §5's cases: `\input{/etc/hosts}`; images by a device path;
//               an embed of a link leading out of the vault (not listed);
//               a link that was inside when the vault was listed and leads
//               out by the time of the export (native's route refuses it:
//               VaultStore.resolve); a `LaTeX preamble` naming an absolute
//               path. And a control: a vault image, embedded, IS in its PDF.
//               And the export figure cache: a figure this vault's export
//               draws is never kept (ExportJobs.swift#ExportCache keeps a
//               trusted vault's alone).
//
// Prints PASS or FAIL per check and writes results.json and the PDFs into
// --out. Always ends with the app terminated and uninstalled, its defaults
// removed and the simulator shut down.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const appPath = args[0];
if (!appPath || !fs.existsSync(path.join(appPath, 'Info.plist'))) {
	console.error('usage: node tools/sim-pdf-checks.mjs <Clew.app> [--sim <udid>] [--only texmf,limit,restricted] [--out <dir>]');
	process.exit(2);
}
const SIM = option('--sim', '90DCB612-1B85-4E1A-A17A-DBEB98F6C36D');
const ONLY = option('--only', 'texmf,limit,restricted').split(',');
const OUT = option('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'clew-sim-pdf-')));
const APP = 'org.jmckalex.clew.ios';
const LIMIT = 30;
/** The Debug limit for the launch that lets the watchdog (60 s) stop a silent loop first. */
const WATCHDOG_LIMIT = 90;
const VAULT_NAME = 'PDF Checks';
const MARKER = 'CLEWOUTSIDEMARKER';
process.env.DEVELOPER_DIR ??= '/Applications/Xcode.app/Contents/Developer';
fs.mkdirSync(OUT, { recursive: true });

const simctl = (...a) => execFileSync('xcrun', ['simctl', ...a], { encoding: 'utf8' }).trim();
const quietly = (...a) => spawnSync('xcrun', ['simctl', ...a], { encoding: 'utf8' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const poppler = ['/opt/homebrew/bin', '/usr/local/bin'].find((d) => fs.existsSync(path.join(d, 'pdfimages')));
const pdftool = (name, ...a) => execFileSync(path.join(poppler, name), a, { encoding: 'utf8' });
const imagesIn = (pdf) => pdftool('pdfimages', '-list', pdf).trim().split('\n').length - 2;

// ---- the simulator and the app ---------------------------------------------

/** The app's data container: asked afresh, it moves on every install and boot. */
const container = () => simctl('get_app_container', SIM, APP, 'data');
/** Every simulator WebContent process, pid → resident KB. */
const webContent = () => {
	const out = execFileSync('ps', ['-axo', 'pid=,rss=,command='], { encoding: 'utf8' });
	const procs = new Map();
	for (const line of out.split('\n')) {
		if (!line.includes('com.apple.WebKit.WebContent') || !line.includes('CoreSimulator')) continue;
		const [pid, rss] = line.trim().split(/\s+/);
		procs.set(Number(pid), Number(rss));
	}
	return procs;
};
const readKv = (vault) => {
	try { return JSON.parse(fs.readFileSync(path.join(vault, 'clewdata.json'), 'utf8')); } catch { return {}; }
};

/**
 * One launch with `smoke` as its ClewSmokeJS. The Mac watches the vault's
 * clewdata.json for the smoke's phases: `export:<tag>` (an export starts),
 * `copy:<tag>:<folder>/<file>` (copy that job's PDF out now), `retarget`
 * (repoint late.jpg out of the vault), `done`. Answers the smoke's
 * `smoke/result` (with `marks`: when each export started and ended, by the
 * page's clock, which is the Mac's), when each phase was seen, and the
 * WebContent processes born during the launch: when (seconds from launch,
 * and `bornMs` by the Mac's clock), their peak resident size, when they went.
 */
async function launch(smoke, { vault, seconds, onPhase = () => {} }) {
	quietly('terminate', SIM, APP);
	const kv = readKv(vault);
	for (const key of Object.keys(kv)) if (key.startsWith('smoke/')) delete kv[key];
	if (fs.existsSync(path.join(vault, 'clewdata.json'))) fs.writeFileSync(path.join(vault, 'clewdata.json'), JSON.stringify(kv));
	simctl('spawn', SIM, 'defaults', 'write', APP, 'ClewSmokeJS', '-string', smoke);
	const before = webContent();
	simctl('launch', SIM, APP);
	const born = new Map();
	const phases = {};
	const t0 = Date.now();
	const now = () => Math.round((Date.now() - t0) / 100) / 10;
	let phase = null;
	const sample = () => {
		const procs = webContent();
		for (const [pid, rss] of procs) {
			if (before.has(pid)) continue;
			const p = born.get(pid) ?? { pid, at: now(), bornMs: Date.now(), gone: null, peakMB: 0 };
			p.peakMB = Math.max(p.peakMB, Math.round(rss / 1024));
			born.set(pid, p);
		}
		for (const p of born.values()) if (p.gone === null && !procs.has(p.pid)) p.gone = now();
	};
	while (Date.now() - t0 < seconds * 1000) {
		sample();
		phase = readKv(vault)['smoke/phase'] ?? null;
		if (phase && !(phase in phases)) {
			phases[phase] = now();
			onPhase(phase);
			if (phase === 'done') break;
		}
		await sleep(100);
	}
	for (let i = 0; i < 10; i++) { sample(); await sleep(100); }
	const result = readKv(vault)['smoke/result'] ?? null;
	quietly('spawn', SIM, 'defaults', 'delete', APP, 'ClewSmokeJS');
	quietly('terminate', SIM, APP);
	return { phase, phases, result, procs: [...born.values()] };
}

/**
 * The export host's process for one export: of those born while it ran (the
 * page's marks), the one that grew largest (TeX's).
 */
function hostOf(run, tag) {
	const marks = Object.fromEntries(run.result?.marks ?? []);
	const start = marks[`export:${tag}`];
	const end = marks[`end:${tag}`] ?? Infinity;
	if (start === undefined) return null;
	return run.procs.filter((p) => p.bornMs >= start - 100 && p.bornMs <= end).sort((a, b) => b.peakMB - a.peakMB)[0] ?? null;
}

/** The smoke's frame: wait for the export host, run BODY, publish the result. */
const smokeScript = (body) => `
const kv = async (key, value) => { await window.__clew.ipc.invoke('clew:kv-set', { key, value }); await window.__clewNative.flush(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(async () => {
	const R = { marks: [] };
	try {
		for (let i = 0; i < 150 && !window.__clewShim?.services?.exportHost; i++) await sleep(100);
		const host = window.__clewShim.services.exportHost;
		const vaults = window.__clewShim.services.vaults;
		R.vault = vaults.name;
		R.trusted = vaults.trusted;
		R.refusedLinks = vaults.refusedLinks;
		const exportPdf = async (tag, note) => {
			await kv('smoke/phase', 'export:' + tag);
			const t0 = Date.now();
			R.marks.push(['export:' + tag, t0]);
			try {
				const done = await host.run(note, 'pdf');
				R.marks.push(['end:' + tag, Date.now()]);
				R[tag] = { ok: true, ms: Date.now() - t0, warnings: done.warnings ?? [], trusted: done.trusted };
				await kv('smoke/phase', 'copy:' + tag + ':' + done.folder + '/' + done.output);
				await sleep(1500);
				await host.discard(done.folder);
			} catch (err) {
				R.marks.push(['end:' + tag, Date.now()]);
				R[tag] = { ok: false, ms: Date.now() - t0, error: String(err?.message ?? err) };
			}
			await kv('smoke/result', R);
		};
		${body}
	} catch (err) {
		R.error = String(err?.stack ?? err);
	}
	await kv('smoke/result', R);
	await kv('smoke/phase', 'done');
}, 0);
'started';`;

// ---- the vault ------------------------------------------------------------

const PROBE_LUA = "local function has(p) local f = io.open(p, 'r') if f then f:close() return true end return false end"
	+ " local garamond = 'absent'"
	+ " local function walk(d) for name in lfs.dir(d) do if name ~= '.' and name ~= '..' then local p = d .. '/' .. name"
	+ " if lfs.attributes(p, 'mode') == 'directory' then walk(p) elseif name:find('ebgaramond', 1, true) then garamond = 'present' end end end end"
	+ " walk('/texmf-var')"
	+ " local own = has('/texmf-var/clew-own.txt') and 'present' or 'absent'"
	+ " local f = io.open('/texmf-var/clew-own.txt', 'w') f:write('own') f:close()"
	+ " token.set_macro('clewprobe', 'planted=' .. (has('/texmf-var/clew-planted.txt') and 'present' or 'absent') .. ' garamond=' .. garamond .. ' own=' .. own)";

function writeVault(data) {
	const vault = path.join(data, 'Documents', VAULT_NAME);
	const outside = path.join(data, 'Library', 'clew-outside');
	fs.rmSync(vault, { recursive: true, force: true });
	fs.rmSync(outside, { recursive: true, force: true });
	fs.mkdirSync(vault, { recursive: true });
	fs.mkdirSync(outside, { recursive: true });
	const image = path.join(appPath, 'SeedVault', 'Attachments', 'NASA - Earthrise.jpg');
	fs.writeFileSync(path.join(outside, 'secret.tex'), `${MARKER}\n`);
	fs.copyFileSync(image, path.join(outside, 'secret.jpg'));
	fs.copyFileSync(image, path.join(vault, 'inside.jpg'));
	fs.copyFileSync(image, path.join(vault, 'inside2.jpg'));
	fs.symlinkSync('../../Library/clew-outside/secret.jpg', path.join(vault, 'escape.jpg'));
	// Inside when the vault is listed; the Mac repoints it out before the export.
	fs.symlinkSync('inside2.jpg', path.join(vault, 'late.jpg'));
	const notes = {
		'Plant.md': "---\nLaTeX preamble: \\setmainfont{EBGaramond-Regular.otf}\\directlua{local f = io.open('/texmf-var/clew-planted.txt', 'w') f:write('planted') f:close()}\n---\n# Plant\n\nPlanted.\n",
		'Probe.md': `---\nLaTeX preamble: \\directlua{${PROBE_LUA}}\\AtBeginDocument{\\par\\noindent\\clewprobe\\par}\n---\n# Probe\n\nThe probe's line is above.\n`,
		// Two million additions, then a line, forever: the watchdog sees output.
		'Loop.md': '---\nLaTeX preamble: \\newcount\\clewn\\newcount\\clewk\\def\\clewtick{{\\clewn=0 \\loop\\advance\\clewn by 1 \\ifnum\\clewn<2000000 \\repeat}\\immediate\\write16{tick \\the\\clewk}}\\loop\\advance\\clewk by 1 \\clewtick\\iftrue\\repeat\n---\n# Loop\n\nNever reached.\n',
		'Silent.md': '---\nLaTeX preamble: \\loop\\iftrue\\repeat\n---\n# Silent\n\nNever reached.\n',
		'Input.md': '# Input\n\nBefore.\n\n\\input{/etc/hosts}\n\nAfter.\n',
		'Device.md': `# Device\n\n![outside](${outside}/secret.jpg)\n\n![own, absolute](${vault}/inside.jpg)\n\nThe end.\n`,
		'Link.md': '# Link\n\n![[escape.jpg]]\n\n![md](escape.jpg)\n\nThe end.\n',
		'Late.md': '# Late\n\n![[late.jpg]]\n\nThe end.\n',
		'Preamble.md': `---\nLaTeX preamble: \\input{${outside}/secret.tex}\n---\n# Preamble\n\nThe end.\n`,
		'Inside.md': '# Inside\n\n![[inside.jpg]]\n\nThe end.\n',
		'Figure.md': '# Figure\n\n@begin(metapost)\nbeginfig(1);\ndraw fullcircle scaled 20mm;\nlabel(btex $x$ etex, origin);\nendfig;\n@end(metapost)\n',
	};
	for (const [name, text] of Object.entries(notes)) fs.writeFileSync(path.join(vault, name), text);
	return { vault, outside };
}

// ---- the checks -------------------------------------------------------------

const results = {};
const verdicts = [];
const verdict = (name, ok, detail) => {
	verdicts.push({ name, ok });
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
/** Copies a job's PDF out when the smoke says so. */
const copier = (data, extra = {}) => (phase) => {
	const m = /^copy:([^:]+):(.+)$/.exec(phase);
	if (m) {
		const from = path.join(data, 'tmp', 'clew-export', m[2]);
		if (fs.existsSync(from)) fs.copyFileSync(from, path.join(OUT, `${m[1]}.pdf`));
	}
	extra[phase]?.();
};
const pdf = (tag) => path.join(OUT, `${tag}.pdf`);
const has = (tag) => fs.existsSync(pdf(tag));

async function main() {
	simctl('bootstatus', SIM, '-b');
	quietly('uninstall', SIM, APP);
	simctl('install', SIM, appPath);
	simctl('spawn', SIM, 'defaults', 'write', APP, 'ClewExportTimeout', '-float', String(LIMIT));
	// A first launch seeds the demo vault and opens it.
	simctl('launch', SIM, APP);
	let data = container();
	for (let i = 0; i < 300 && !fs.existsSync(path.join(data, 'Documents', 'Demo Vault', 'Welcome.md')); i++) await sleep(100);
	await sleep(3000);
	quietly('terminate', SIM, APP);
	data = container();
	const { vault } = writeVault(data);

	// Open the checks' vault by path: a fresh page, which the next launches
	// reopen. The smoke runs on every page; it switches only once.
	const demo = path.join(data, 'Documents', 'Demo Vault');
	const openSmoke = smokeScript(`
		if (vaults.name !== ${JSON.stringify(VAULT_NAME)}) {
			await kv('smoke/phase', 'switching');
			await window.__clew.ipc.invoke('clew:vault-open-path', { path: ${JSON.stringify(vault)} });
			await sleep(60000);
		}`);
	let opened = await launch(openSmoke, { vault, seconds: 30 });
	// The switch is a fresh page; when the hook ran only once, the next
	// launch reopens the vault and the same smoke finds it open.
	if (opened.result?.vault !== VAULT_NAME) opened = await launch(openSmoke, { vault, seconds: 30 });
	results.open = opened.result;
	if (opened.result?.vault !== VAULT_NAME || opened.result?.trusted !== false) {
		verdict('open the checks\' vault, untrusted', false, JSON.stringify(opened.result ?? readKv(demo)['smoke/phase']));
		return;
	}
	verdict('open the checks\' vault, untrusted', true, `refused links: ${JSON.stringify(opened.result.refusedLinks)}`);

	if (ONLY.includes('texmf')) {
		const run = await launch(smokeScript(`
			await exportPdf('plant', 'Plant.md');
			await exportPdf('probe', 'Probe.md');`), { vault, seconds: 120, onPhase: copier(data) });
		results.texmf = run;
		const r = run.result ?? {};
		const plantFonts = has('plant') ? pdftool('pdffonts', pdf('plant')) : '';
		const probeText = has('probe') ? pdftool('pdftotext', pdf('probe'), '-') : '';
		const [plantHost, probeHost] = [hostOf(run, 'plant'), hostOf(run, 'probe')];
		results.texmf.hosts = { plant: plantHost, probe: probeHost };
		verdict('texmf: each export its own page and process, the first gone before the second starts',
			plantHost && probeHost && plantHost.pid !== probeHost.pid && plantHost.gone !== null && plantHost.gone <= probeHost.at,
			`plant ${JSON.stringify(plantHost)}, probe ${JSON.stringify(probeHost)}`);
		verdict('texmf: Plant typeset in EB Garamond (its face cached by luaotfload, its file written)', r.plant?.ok && /EBGaramond-Regular/.test(plantFonts), JSON.stringify(r.plant));
		verdict('texmf: Probe, the next export in the same session, finds nothing of Plant\'s, nor any pass of its own of the last',
			r.probe?.ok && /planted=absent garamond=absent own=absent/.test(probeText), probeText.split('\n')[0]);
	}

	if (ONLY.includes('limit')) {
		const run = await launch(smokeScript(`
			await exportPdf('silent', 'Silent.md');
			await exportPdf('loop', 'Loop.md');`), { vault, seconds: 20 + LIMIT + 50, onPhase: copier(data) });
		results.limit = run;
		const exportDir = path.join(data, 'tmp', 'clew-export');
		const left = fs.existsSync(exportDir) ? fs.readdirSync(exportDir).filter((n) => n.startsWith('clew-export-')) : [];
		const loop = run.result?.loop ?? {};
		const loopHost = hostOf(run, 'loop');
		verdict(`limit: a document that never finishes, printing as it goes, is stopped by Clew's limit at ${LIMIT} s`,
			loop.ok === false && new RegExp(`took too long \\(more than ${LIMIT} seconds\\) and was stopped`).test(loop.error ?? '') && loop.ms >= LIMIT * 1000 && loop.ms < (LIMIT + 10) * 1000,
			`${loop.error ?? 'no answer'} after ${((loop.ms ?? NaN) / 1000).toFixed(1)} s`);
		verdict('limit: its page\'s process is gone and no job folder is left',
			loop.ok === false && left.length === 0 && loopHost !== null && loopHost.gone !== null,
			`job folders left: ${left.length}; the export host's process: ${JSON.stringify(loopHost)}`);
		const silent = run.result?.silent ?? {};
		const silentHost = hostOf(run, 'silent');
		verdict(`limit: a loop that prints nothing is stopped by Clew's limit at ${LIMIT} s too (the watchdog waits 60 s); its page goes`,
			silent.ok === false && new RegExp(`took too long \\(more than ${LIMIT} seconds\\) and was stopped`).test(silent.error ?? '') && silent.ms >= LIMIT * 1000 && silent.ms < (LIMIT + 10) * 1000 && silentHost?.gone !== null,
			`${silent.error ?? 'no answer'} after ${((silent.ms ?? NaN) / 1000).toFixed(1)} s; process ${JSON.stringify(silentHost)}`);

		// Clew's limit past the watchdog's: the watchdog stops the silent loop.
		simctl('spawn', SIM, 'defaults', 'write', APP, 'ClewExportTimeout', '-float', String(WATCHDOG_LIMIT));
		const late = await launch(smokeScript(`
			await exportPdf('silent', 'Silent.md');`), { vault, seconds: WATCHDOG_LIMIT + 30, onPhase: copier(data) });
		simctl('spawn', SIM, 'defaults', 'write', APP, 'ClewExportTimeout', '-float', String(LIMIT));
		results.watchdog = late;
		const quiet = late.result?.silent ?? {};
		const quietHost = hostOf(late, 'silent');
		verdict(`limit: with Clew's limit at ${WATCHDOG_LIMIT} s, the watchdog stops a silent loop at 60 s, said in desktop's words; its page goes`,
			quiet.ok === false && /^PDF via LaTeX failed — LuaLaTeX ran \(.*\)\. First error: TeX went 60 seconds without any output and was stopped$/.test(quiet.error ?? '')
				&& quiet.ms >= 60_000 && quiet.ms < WATCHDOG_LIMIT * 1000 && quietHost?.gone !== null,
			`${quiet.error ?? 'no answer'} after ${((quiet.ms ?? NaN) / 1000).toFixed(1)} s; process ${JSON.stringify(quietHost)}`);
	}

	if (ONLY.includes('restricted')) {
		const late = path.join(vault, 'late.jpg');
		const run = await launch(smokeScript(`
			await exportPdf('inside', 'Inside.md');
			await exportPdf('input', 'Input.md');
			await exportPdf('device', 'Device.md');
			await exportPdf('link', 'Link.md');
			await kv('smoke/phase', 'retarget');
			await sleep(1000);
			await exportPdf('late', 'Late.md');
			await exportPdf('preamble', 'Preamble.md');
			await exportPdf('figure', 'Figure.md');`), {
			vault, seconds: 180,
			onPhase: copier(data, { retarget: () => { fs.rmSync(late); fs.symlinkSync('../../Library/clew-outside/secret.jpg', late); } }),
		});
		results.restricted = run;
		const r = run.result ?? {};
		const images = (tag) => (has(tag) ? imagesIn(pdf(tag)) : null);
		verdict('restricted, control: a vault image embedded is in the PDF (the route serves this untrusted vault)', r.inside?.ok && images('inside') === 1, `${images('inside')} image(s)`);
		verdict('restricted: `\\input{/etc/hosts}` fails with TeX\'s own "not found"',
			r.input?.ok === false && /First error: ! LaTeX Error: File `\/etc\/hosts\.tex' not found/.test(r.input.error ?? ''), r.input?.error);
		verdict('restricted: images by a device path (outside the vault; the vault\'s own, absolute) are not in the PDF',
			r.device?.ok && images('device') === 0, `${images('device')} image(s); warnings ${JSON.stringify(r.device?.warnings)}`);
		verdict('restricted: an embed of a link leading out of the vault is not listed, and the PDF goes without it, said',
			r.link?.ok && images('link') === 0 && (r.refusedLinks ?? []).includes('escape.jpg') && r.link.warnings.includes('escape.jpg is named by the .tex but is not in this vault'),
			`${images('link')} image(s); warnings ${JSON.stringify(r.link?.warnings)}`);
		const refusedByRoute = (r.late?.warnings ?? []).includes('late.jpg could not be read from the vault, so the PDF goes without it');
		const rescanned = (r.late?.warnings ?? []).includes('late.jpg is named by the .tex but is not in this vault');
		verdict(`restricted: a link repointed out of the vault after it was listed is refused by native's route${rescanned ? ' (INCONCLUSIVE: a rescan dropped it first)' : ''}`,
			r.late?.ok && images('late') === 0 && refusedByRoute, `${images('late')} image(s); warnings ${JSON.stringify(r.late?.warnings)}`);
		const cacheFiles = (() => {
			const found = [];
			const walk = (dir) => { for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) (e.isDirectory() ? walk(path.join(dir, e.name)) : found.push(path.join(dir, e.name))); };
			walk(path.join(data, 'Library', 'Caches', 'export-cache'));
			return found;
		})();
		verdict('restricted: a figure this vault\'s export draws is in its PDF, and never kept in the export figure cache',
			r.figure?.ok && cacheFiles.length === 0, `figure export ${r.figure?.ok ? 'ok' : r.figure?.error}; cached files: ${cacheFiles.length}`);
		verdict('restricted: a `LaTeX preamble` naming an absolute path fails with TeX\'s "not found", the file\'s text nowhere',
			r.preamble?.ok === false && /secret\.tex' not found/.test(r.preamble.error ?? '') && !String(r.preamble.error).includes(MARKER), r.preamble?.error);
	}
}

try {
	await main();
} catch (err) {
	verdict('the run itself', false, String(err?.stack ?? err));
} finally {
	quietly('spawn', SIM, 'defaults', 'delete', APP, 'ClewSmokeJS');
	quietly('spawn', SIM, 'defaults', 'delete', APP, 'ClewExportTimeout');
	quietly('terminate', SIM, APP);
	quietly('uninstall', SIM, APP);
	quietly('shutdown', SIM);
	if (spawnSync('pgrep', ['-x', 'Simulator']).status === 0) spawnSync('killall', ['Simulator']);
	fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ verdicts, results }, null, '\t'));
	const failed = verdicts.filter((v) => !v.ok).length;
	console.log(`${verdicts.length - failed}/${verdicts.length} passed; results and PDFs in ${OUT}`);
	process.exitCode = failed ? 1 : 0;
}
