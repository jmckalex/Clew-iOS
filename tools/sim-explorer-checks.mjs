// The file explorer's indentation, guides and icons in the simulator (Clew-app
// cd39a81 + cfa279b, the owner's ask of 2026-11-12). Headless: simctl only,
// never Simulator.app, never a keystroke. A Debug build's ClewSmokeJS hook
// runs Clew-app's smoke/explorer-icons-scenario.js, its checks as they are,
// on its fixture of generic names, and the Mac screenshots the explorer in
// each theme.
//
//   node tools/sim-explorer-checks.mjs <Clew.app> [--sim <udid>] [--out <dir>]
//
// The fixture is a vault in Documents opened by path (so untrusted; the
// explorer does not care). Checks, as the scenario's:
//   indent   every row's icon exactly 16px right of its folder's, siblings'
//            icons in one column, each name after its icon
//   guides   a row's guide band is its depth × 16px
//   loaded   every icon on screen loaded (webroot/file-icons/ is served)
//   probe    the windowing's measured row height is a real row's
//   light    a light page takes the `_light` variant (page.jinja), a switch
//            back repaints
//   kinds    each fixture file's icon, as the Mac names it
// Writes results.json and explorer-dark.png / explorer-light.png into --out.
// Always ends with the app terminated and uninstalled, its defaults removed
// and the simulator shut down.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileIconName, folderIconName, fileIconUrl } from '../vendor/clew/renderer/lib/file-icons.js';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const appPath = args[0];
if (!appPath || !fs.existsSync(path.join(appPath, 'Info.plist'))) {
	console.error('usage: node tools/sim-explorer-checks.mjs <Clew.app> [--sim <udid>] [--out <dir>]');
	process.exit(2);
}
const SIM = option('--sim', '90DCB612-1B85-4E1A-A17A-DBEB98F6C36D');
const OUT = option('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'clew-sim-explorer-')));
const APP = 'org.jmckalex.clew.ios';
const VAULT_NAME = 'Explorer Checks';
process.env.DEVELOPER_DIR ??= '/Applications/Xcode.app/Contents/Developer';
fs.mkdirSync(OUT, { recursive: true });

const simctl = (...a) => execFileSync('xcrun', ['simctl', ...a], { encoding: 'utf8' }).trim();
const quietly = (...a) => spawnSync('xcrun', ['simctl', ...a], { encoding: 'utf8' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const container = () => simctl('get_app_container', SIM, APP, 'data');
const readKv = (vault) => {
	try { return JSON.parse(fs.readFileSync(path.join(vault, 'clewdata.json'), 'utf8')); } catch { return {}; }
};

/** Clew-app's fixture (smoke/explorer-icons-scenario.js), generic names. */
function writeVault(data) {
	const vault = path.join(data, 'Documents', VAULT_NAME);
	fs.rmSync(vault, { recursive: true, force: true });
	for (const dir of ['Lectures/Week 1', 'Lectures/Week 2', 'Pictures', 'Office', 'Boards', 'Many']) {
		fs.mkdirSync(path.join(vault, dir), { recursive: true });
	}
	fs.writeFileSync(path.join(vault, 'README.md'), '# R\n');
	fs.writeFileSync(path.join(vault, 'Makefile'), 'all:\n');
	fs.writeFileSync(path.join(vault, 'index.php'), '<?php\n');
	for (const f of ['Lectures/Plan.md', 'Lectures/Plan.tex', 'Lectures/Plan.pdf', 'Lectures/Plan.html',
		'Lectures/Week 1/Notes.md', 'Lectures/Week 1/Handout.pdf', 'Lectures/Week 2/Notes.jmd',
		'Pictures/a.png', 'Pictures/b.svg', 'Office/Essay.docx', 'Office/Marks.xlsx', 'Office/Slides.pptx',
		'Boards/Map.canvas', 'Boards/Sketch.excalidraw.md', 'Boards/List.base', 'Boards/page.jinja',
		'refs.bib', 'site.zip']) {
		fs.writeFileSync(path.join(vault, f), 'x\n');
	}
	for (let i = 1; i <= 300; i++) fs.writeFileSync(path.join(vault, 'Many', `item-${String(i).padStart(3, '0')}.md`), 'x\n');
	return vault;
}

/**
 * One launch with `smoke` as its ClewSmokeJS. The smoke publishes phases
 * through the vault's clewdata.json; `shot:<name>` asks the Mac for a
 * screenshot, answered by the smoke waiting a moment before it goes on.
 */
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
		const phase = readKv(vault)['smoke/phase'] ?? null;
		if (phase && !seen.has(phase)) {
			seen.add(phase);
			if (phase.startsWith('shot:')) simctl('io', SIM, 'screenshot', path.join(OUT, `explorer-${phase.slice(5)}.png`));
			if (phase === 'done') break;
		}
		await sleep(100);
	}
	const result = readKv(vault)['smoke/result'] ?? null;
	quietly('spawn', SIM, 'defaults', 'delete', APP, 'ClewSmokeJS');
	quietly('terminate', SIM, APP);
	return { phases: [...seen], result };
}

const frame = (body) => `
const kv = async (key, value) => { await window.__clew.ipc.invoke('clew:kv-set', { key, value }); await window.__clewNative.flush(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(async () => {
	const R = {};
	try {
		for (let i = 0; i < 150 && !window.__clewShim?.services?.vaults; i++) await sleep(100);
		const vaults = window.__clewShim.services.vaults;
		R.vault = vaults.name;
		${body}
	} catch (err) {
		R.error = String(err?.stack ?? err);
	}
	await kv('smoke/result', R);
	await kv('smoke/phase', 'done');
}, 0);
'started';`;

/** smoke/explorer-icons-scenario.js's measures, its console lines as fields of R. */
const CHECKS = `
if (vaults.name !== ${JSON.stringify(VAULT_NAME)}) throw new Error('not the checks vault: ' + vaults.name);
const { settingsStore, workspaceStore } = window.__clew;
workspaceStore.setSidebar('left', { open: true });
await sleep(1500);
const explorer = document.querySelector('clew-file-explorer');
const rows = () => [...explorer.querySelectorAll('.file-tree-sizer > .tree-item')];
const iconOf = (row) => row.querySelector('img.tree-icon');
const base = (src) => src.split('/').pop();
const startTheme = settingsStore.get('theme') ?? 'dark';
R.startTheme = startTheme;
if (startTheme !== 'dark') { settingsStore.set('theme', 'dark'); await sleep(400); }
if (!workspaceStore.collapsedFolders.includes('Many')) {
	explorer.querySelector('.tree-item.is-folder[data-path="Many"]')?.click();
	await sleep(400);
}
await sleep(800);
const drawn = rows().map((row) => {
	const icon = iconOf(row);
	const name = row.querySelector('.tree-name');
	return {
		path: row.dataset.path,
		depth: Number(row.style.getPropertyValue('--tree-depth')),
		iconLeft: icon.getBoundingClientRect().left,
		iconRight: icon.getBoundingClientRect().right,
		iconWidth: icon.getBoundingClientRect().width,
		nameLeft: name.getBoundingClientRect().left,
		guide: parseFloat(getComputedStyle(row, '::before').width) || 0,
		height: row.offsetHeight,
		top: parseFloat(row.style.top),
		src: base(icon.src),
		loaded: icon.complete && icon.naturalWidth > 0,
	};
});
const byPath = new Map(drawn.map((r) => [r.path, r]));
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : null);
const indentBad = [];
for (const r of drawn) {
	const parent = byPath.get(parentOf(r.path));
	if (parent && Math.abs(r.iconLeft - parent.iconLeft - 16) > 0.5) indentBad.push(r.path + ': ' + (r.iconLeft - parent.iconLeft));
	if (!parent && r.depth !== 0) indentBad.push(r.path + ': no parent row');
	if (r.nameLeft < r.iconRight) indentBad.push(r.path + ': name over icon');
}
const columns = new Map();
for (const r of drawn) columns.set(r.depth, [...(columns.get(r.depth) ?? []), r.iconLeft]);
for (const [depth, lefts] of columns) {
	if (new Set(lefts).size !== 1) indentBad.push('depth ' + depth + ': icons at ' + [...new Set(lefts)]);
}
R.rows = drawn.length;
R.indentBad = indentBad;
R.guidesBad = drawn.filter((r) => r.guide !== r.depth * 16).map((r) => r.path + ': ' + r.guide);
R.notLoaded = drawn.filter((r) => !r.loaded).map((r) => r.path);
const step = drawn.length > 1 ? drawn[1].top - drawn[0].top : 0;
R.rowHeight = step;
R.heights = [...new Set(drawn.map((r) => r.height))];
R.probeOk = drawn.every((r) => r.height === step);
R.iconWidths = [...new Set(drawn.map((r) => r.iconWidth))];
R.kinds = Object.fromEntries(drawn.map((r) => [r.path, r.src]));
R.folders = rows().filter((row) => row.classList.contains('is-folder')).map((row) => row.dataset.path);
R.explorerWidth = explorer.getBoundingClientRect().width;
await kv('smoke/phase', 'shot:dark');
await sleep(2500);
const jinja = () => base(iconOf(explorer.querySelector('.tree-item[data-path="Boards/page.jinja"]')).src);
R.darkJinja = jinja();
settingsStore.set('theme', 'light');
await sleep(800);
R.lightJinja = jinja();
R.lightNotLoaded = rows().filter((row) => !(iconOf(row).complete && iconOf(row).naturalWidth > 0)).map((row) => row.dataset.path);
await kv('smoke/phase', 'shot:light');
await sleep(2500);
settingsStore.set('theme', 'dark');
await sleep(800);
R.backJinja = jinja();
if (startTheme !== 'dark') settingsStore.set('theme', startTheme);
`;

const verdicts = [];
const verdict = (name, ok, detail) => {
	verdicts.push({ name, ok: Boolean(ok), detail });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function main() {
	simctl('bootstatus', SIM, '-b');
	quietly('uninstall', SIM, APP);
	simctl('install', SIM, appPath);
	const bundle = path.join(appPath, 'WebRoot', 'file-icons');
	const svgs = fs.existsSync(bundle) ? fs.readdirSync(bundle).filter((n) => n.endsWith('.svg')).length : 0;
	verdict('the app carries the icons beside its page, with the set\'s LICENSE', svgs > 600 && fs.existsSync(path.join(bundle, 'LICENSE')), `${svgs} SVGs in WebRoot/file-icons`);
	// A first launch seeds the demo vault and opens it.
	simctl('launch', SIM, APP);
	let data = container();
	for (let i = 0; i < 300 && !fs.existsSync(path.join(data, 'Documents', 'Demo Vault', 'Welcome.md')); i++) await sleep(100);
	await sleep(3000);
	quietly('terminate', SIM, APP);
	data = container();
	const vault = writeVault(data);
	const openSmoke = frame(`
		if (vaults.name !== ${JSON.stringify(VAULT_NAME)}) {
			await kv('smoke/phase', 'switching');
			await window.__clew.ipc.invoke('clew:vault-open-path', { path: ${JSON.stringify(vault)} });
			await sleep(60000);
		}`);
	let opened = await launch(openSmoke, { vault, seconds: 30 });
	if (opened.result?.vault !== VAULT_NAME) opened = await launch(openSmoke, { vault, seconds: 30 });
	verdict('open the fixture vault', opened.result?.vault === VAULT_NAME, JSON.stringify(opened.result));
	if (opened.result?.vault !== VAULT_NAME) return null;

	const run = await launch(frame(CHECKS), { vault, seconds: 60 });
	const r = run.result ?? {};
	if (r.error) verdict('the smoke itself', false, r.error);
	verdict('indent: each row 16px in from its folder, siblings in one column, each name after its icon', r.rows > 20 && r.indentBad?.length === 0, `${r.rows} rows; ${JSON.stringify(r.indentBad)}`);
	verdict('guides: a row\'s guide band is its depth × 16px', r.guidesBad?.length === 0, JSON.stringify(r.guidesBad));
	verdict('loaded: every icon on screen loaded, in both themes', r.notLoaded?.length === 0 && r.lightNotLoaded?.length === 0, JSON.stringify({ dark: r.notLoaded, light: r.lightNotLoaded }));
	verdict('probe: the measured row height is a real row\'s', r.probeOk === true, `row ${r.rowHeight}px, heights ${JSON.stringify(r.heights)}, icons ${JSON.stringify(r.iconWidths)}px`);
	verdict('light: page.jinja takes jinja_light.svg on a light page, jinja.svg again on a dark one', r.darkJinja === 'jinja.svg' && r.lightJinja === 'jinja_light.svg' && r.backJinja === 'jinja.svg', `${r.darkJinja} → ${r.lightJinja} → ${r.backJinja}`);
	// Each row's icon is the one the lookup gives its name: folders open (Many
	// closed), files by name, the dark page's.
	const closed = new Set(['Many']);
	const wrong = Object.entries(r.kinds ?? {}).filter(([rel, src]) => {
		const name = rel.split('/').pop();
		const folder = (r.folders ?? []).includes(rel);
		const want = (folder ? fileIconUrl(folderIconName(!closed.has(rel)), 'dark') : fileIconUrl(fileIconName(name), 'dark')).split('/').pop();
		return src !== want;
	});
	verdict('kinds: each row\'s icon the one its name gives (folders open, Many closed)', Object.keys(r.kinds ?? {}).length > 20 && wrong.length === 0, JSON.stringify(wrong));
	const shots = ['dark', 'light'].filter((t) => fs.existsSync(path.join(OUT, `explorer-${t}.png`)));
	verdict('screenshots in both themes', shots.length === 2, shots.join(', '));
	return { open: opened.result, checks: r, phases: run.phases };
}

let results = null;
try {
	results = await main();
} catch (err) {
	verdict('the run itself', false, String(err?.stack ?? err));
} finally {
	quietly('spawn', SIM, 'defaults', 'delete', APP, 'ClewSmokeJS');
	quietly('terminate', SIM, APP);
	quietly('uninstall', SIM, APP);
	quietly('shutdown', SIM);
	if (spawnSync('pgrep', ['-x', 'Simulator']).status === 0) spawnSync('killall', ['Simulator']);
	fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ verdicts, results }, null, '\t'));
	const failed = verdicts.filter((v) => !v.ok).length;
	console.log(`${verdicts.length - failed}/${verdicts.length} passed; results and screenshots in ${OUT}`);
	process.exitCode = failed ? 1 : 0;
}
