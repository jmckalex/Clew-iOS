// Run one of Clew-app's smoke scenarios (or one of this port's) in the
// simulator, on a fixture vault of its own. Headless: simctl only, never
// Simulator.app, never a keystroke.
//
//   node tools/sim-smoke.mjs <Clew.app> <scenario.js> [--fixture <dir>]
//        [--name <vault name>] [--seconds <n>] [--sim <udid>] [--out <dir>]
//        [--collect <dir>]…
//
// The fixture folder is copied into the app's Documents as the vault (an
// empty one without --fixture) and opened by path, so it is untrusted, as
// Clew-app's smoke vaults are. The scenario runs as the app page's ClewSmokeJS
// (top-level await allowed), as Clew-app's own runs under CLEW_SMOKE:
//   - its `console.log('smoke-…')` lines are its results; they are collected
//     here and printed, in order;
//   - `await window.__clewSmokeShot('name')` screenshots the simulator into
//     --out as name.png (the Mac polls every 100 ms; the call returns after
//     2.5 s, the shot long taken);
//   - `window.__clewSmokeData` is the data container's Documents path, for a
//     scenario that checks what the app wrote.
// --collect copies a folder of the app's data container (`tmp`, where a
// share sheet's file is written; `Documents/Exports`) into --out/collected/
// before the app goes: what the app made, read on the Mac (pdftotext).
// Writes lines.json (and the shots) into --out. Always ends with the app
// terminated and uninstalled, its defaults removed and the simulator shut
// down. Exit status 0 when the scenario finished, 1 otherwise; whether its
// lines say what they should is the caller's to judge.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const [appPath, scenarioPath] = args;
if (!appPath || !fs.existsSync(path.join(appPath, 'Info.plist')) || !scenarioPath || !fs.existsSync(scenarioPath)) {
	console.error('usage: node tools/sim-smoke.mjs <Clew.app> <scenario.js> [--fixture <dir>] [--name <vault>] [--seconds <n>] [--sim <udid>] [--out <dir>]');
	process.exit(2);
}
const SIM = option('--sim', '90DCB612-1B85-4E1A-A17A-DBEB98F6C36D');
const OUT = option('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'clew-sim-smoke-')));
const FIXTURE = option('--fixture', null);
const VAULT_NAME = option('--name', 'Smoke Vault');
const SECONDS = Number(option('--seconds', '90'));
const COLLECT = args.flatMap((a, i) => (a === '--collect' ? [args[i + 1]] : []));
const APP = 'org.jmckalex.clew.ios';
process.env.DEVELOPER_DIR ??= '/Applications/Xcode.app/Contents/Developer';
fs.mkdirSync(OUT, { recursive: true });

const simctl = (...a) => execFileSync('xcrun', ['simctl', ...a], { encoding: 'utf8' }).trim();
const quietly = (...a) => spawnSync('xcrun', ['simctl', ...a], { encoding: 'utf8' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const container = () => simctl('get_app_container', SIM, APP, 'data');
const readKv = (vault) => {
	try { return JSON.parse(fs.readFileSync(path.join(vault, 'clewdata.json'), 'utf8')); } catch { return {}; }
};

/** One launch with `smoke` as ClewSmokeJS; `shot:<name>` phases are screenshots. */
async function launch(smoke, { vault, seconds }) {
	quietly('terminate', SIM, APP);
	const kv = readKv(vault);
	for (const key of Object.keys(kv)) if (key.startsWith('smoke/')) delete kv[key];
	if (fs.existsSync(path.join(vault, 'clewdata.json'))) fs.writeFileSync(path.join(vault, 'clewdata.json'), JSON.stringify(kv));
	simctl('spawn', SIM, 'defaults', 'write', APP, 'ClewSmokeJS', '-string', smoke);
	simctl('launch', SIM, APP);
	const t0 = Date.now();
	const seen = new Set();
	while (Date.now() - t0 < seconds * 1000) {
		const now = readKv(vault);
		const phase = now['smoke/phase'] ?? null;
		if (phase && !seen.has(phase)) {
			seen.add(phase);
			if (phase.startsWith('shot:')) {
				const name = phase.slice(5).split('#')[0];
				simctl('io', SIM, 'screenshot', path.join(OUT, `${name}.png`));
			}
			if (phase === 'done') break;
		}
		await sleep(100);
	}
	const kvEnd = readKv(vault);
	quietly('spawn', SIM, 'defaults', 'delete', APP, 'ClewSmokeJS');
	quietly('terminate', SIM, APP);
	return { phases: [...seen], lines: kvEnd['smoke/lines'] ?? null, error: kvEnd['smoke/error'] ?? null };
}

// The frame: waits for the shim, opens the fixture vault if another is open
// (a fresh page follows; this launch ends there), and otherwise runs the
// scenario with console.log('smoke-…') collected.
const frame = (body, { vault, documents }) => `
const kv = async (key, value) => { await window.__clew.ipc.invoke('clew:kv-set', { key, value }); await window.__clewNative.flush(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(async () => {
	const lines = [];
	const log = console.log;
	console.log = (...a) => { const s = a.map(String).join(' '); if (s.startsWith('smoke-')) lines.push(s); return log.apply(console, a); };
	let shots = 0;
	window.__clewSmokeShot = async (name) => {
		const phase = 'shot:' + name + '#' + (++shots);
		await kv('smoke/lines', lines);
		await kv('smoke/phase', phase);
		await sleep(2500);
	};
	window.__clewSmokeData = ${JSON.stringify(documents)};
	try {
		for (let i = 0; i < 150 && !window.__clewShim?.services?.vaults; i++) await sleep(100);
		const vaults = window.__clewShim.services.vaults;
		for (let i = 0; i < 150 && !window.__clew?.vaultStore?.vault; i++) await sleep(100);
		if (vaults.name !== ${JSON.stringify(VAULT_NAME)}) {
			await window.__clew.ipc.invoke('clew:vault-open-path', { path: ${JSON.stringify(vault)} });
			await sleep(60000);
			return;
		}
		await (async () => {
${body}
		})();
	} catch (err) {
		await kv('smoke/error', String(err?.stack ?? err));
	}
	await kv('smoke/lines', lines);
	await kv('smoke/phase', 'done');
}, 0);
'started';`;

let exitCode = 1;
try {
	simctl('bootstatus', SIM, '-b');
	quietly('uninstall', SIM, APP);
	simctl('install', SIM, appPath);
	// A first launch seeds the demo vault and opens it.
	simctl('launch', SIM, APP);
	let data = container();
	for (let i = 0; i < 300 && !fs.existsSync(path.join(data, 'Documents', 'Demo Vault', 'Welcome.md')); i++) await sleep(100);
	await sleep(3000);
	quietly('terminate', SIM, APP);
	data = container();
	const documents = path.join(data, 'Documents');
	const vault = path.join(documents, VAULT_NAME);
	fs.rmSync(vault, { recursive: true, force: true });
	if (FIXTURE) fs.cpSync(FIXTURE, vault, { recursive: true });
	else fs.mkdirSync(vault, { recursive: true });
	const body = fs.readFileSync(scenarioPath, 'utf8');
	// The first launch switches to the fixture vault; the second runs.
	await launch(frame('', { vault, documents }), { vault, seconds: 20 });
	const run = await launch(frame(body, { vault, documents }), { vault, seconds: SECONDS });
	if (run.error) console.log(`ERROR ${run.error}`);
	for (const line of run.lines ?? []) console.log(line);
	fs.writeFileSync(path.join(OUT, 'lines.json'), JSON.stringify(run, null, '\t'));
	for (const rel of COLLECT) {
		const from = path.join(container(), rel);
		if (fs.existsSync(from)) fs.cpSync(from, path.join(OUT, 'collected', rel), { recursive: true });
	}
	exitCode = run.phases.includes('done') && !run.error ? 0 : 1;
	if (!run.phases.includes('done')) console.log(`the scenario did not finish in ${SECONDS} s (phases ${JSON.stringify(run.phases)})`);
} catch (err) {
	console.log(`the run itself failed: ${err?.stack ?? err}`);
} finally {
	quietly('spawn', SIM, 'defaults', 'delete', APP, 'ClewSmokeJS');
	quietly('terminate', SIM, APP);
	quietly('uninstall', SIM, APP);
	quietly('shutdown', SIM);
	if (spawnSync('pgrep', ['-x', 'Simulator']).status === 0) spawnSync('killall', ['Simulator']);
	console.log(`results in ${OUT}`);
	process.exitCode = exitCode;
}
