// Drive dist/export-worker.js under plain Node, as tools/render-note.mjs
// drives the render worker: snapshot a real vault directory, build the SAME
// job the app builds (src/shim/export-job.js), run it with mp-tikz-wasm from
// the staged mptikz-assets/, and write the outputs into a folder. Prints a
// JSON summary: { output, files: [{ rel, bytes }], warnings, references }
// (references: what the share would carry beside the .tex,
// src/shim/export-references.js). Used by tests/export-host.test.js (spawned
// as a child process: the bundle installs its own `process` global) and
// handy as a dev CLI:
//
//   node tools/export-note.mjs <vault-dir> <note-rel-path> <out-dir> [--restricted] [--style=none] [--pdf] [--spy] [--cache <dir>]
//
// With --pdf, the job is PDF via LaTeX: the worker typesets the .tex with
// mp-tikz-wasm (src/export/typeset.js) and writes the PDF alone; the vault's
// images come from the folder, as native's route gives them in the app.
// The folder is read as native reads a vault: a link leaving it is not
// listed (VaultStore.walk) and not read (VaultStore.resolve), and the
// route answers only an image graphicx typesets, nothing hidden
// (ExportJobs.mayRead). With --spy, the summary also has `vaultReads` (what
// the job asked the route for) and `texRuns` (each TeX run: the files it was
// handed, by name, its status and log, tools/mptikz-spy.mjs), and a failed
// build prints `{ error, vaultReads, texRuns }` before exiting 1.
// With --cache <dir>, the folder is the export figure cache as native keeps
// it (ExportJobs.swift#ExportCache): listed and read by a trusted vault's
// export, added to and marked used; a restricted vault's export gets none.
// The summary's `figures` says what the figure engine drew and what the
// output used, and `cache` what the folder gave and took.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { engineEnv, isTextPath, ENGINE_CSL_FILES } from '../src/shim/engine-config.js';
import { exportJob } from '../src/shim/export-job.js';
import { texReferences } from '../src/shim/export-references.js';

const [vaultDir, noteRel, outDir, ...flags] = process.argv.slice(2);
if (!vaultDir || !noteRel || !outDir) {
	console.error('usage: node tools/export-note.mjs <vault-dir> <note-rel-path> <out-dir> [--restricted] [--style=none]');
	process.exit(2);
}
const trusted = !flags.includes('--restricted');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vaultAbs = path.resolve(vaultDir);
const realExit = process.exit.bind(process);
const realErr = (...a) => console.error(...a);
const spy = flags.includes('--spy');
const vaultReal = fs.realpathSync(vaultAbs);
const inVault = (real) => real === vaultReal || real.startsWith(`${vaultReal}/`);
/** A path's real path, or null (missing, dangling). */
const realOf = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

const vaultOptions = (() => {
	try { return JSON.parse(fs.readFileSync(path.join(vaultAbs, '.clew', 'vault-settings.json'), 'utf8')); } catch { return {}; }
})();

// The vault's text files, binaries as names only, `.clew/` aside: what the
// app's render service snapshots (render-service.js#vaultFiles). Dot folders
// other than .clew ride along, as in the app (a vault's .jmarkdown/). A link
// is followed only while it stays inside the vault; one leaving it, or
// dangling, is skipped (VaultStore.walk's refusedLinks).
const files = {};
const refusedLinks = [];
const walk = (dir, rel, seen) => {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (['.clew', '.trash', 'node_modules', '.git'].includes(entry.name)) continue;
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		let abs = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) {
			const real = realOf(abs);
			if (!real) continue;
			if (!inVault(real)) { refusedLinks.push(childRel); continue; }
			abs = real;
		}
		if (fs.statSync(abs).isDirectory()) {
			const real = realOf(abs);
			if (!seen.has(real)) walk(abs, childRel, new Set([...seen, real]));
		} else {
			files[`/vault/${childRel}`] = isTextPath(entry.name) ? fs.readFileSync(abs, 'utf8') : '';
		}
	}
};
walk(vaultAbs, '', new Set([vaultReal]));
for (const [target, source] of Object.entries({
	'/engine/default-template.html.mustache': 'vendor/jmarkdown/src/default-template.html.mustache',
	'/engine/default-template.tex.mustache': 'vendor/jmarkdown/src/default-template.tex.mustache',
	'/engine/Biblify.js.mustache': 'vendor/jmarkdown/src/Biblify.js.mustache',
	'/engine/jmarkdown.css': 'vendor/jmarkdown/src/jmarkdown.css',
	'/engine/clew-template.html': 'vendor/clew/engine/clew-template.html',
})) {
	files[target] = fs.readFileSync(path.join(root, source), 'utf8');
}
for (const name of ENGINE_CSL_FILES) {
	files[`/engine/csl/${name}`] = fs.readFileSync(path.join(root, 'vendor/jmarkdown/src/csl', name), 'utf8');
}

const access = { trusted, plugins: [], dataviewJs: false };
const style = flags.find((f) => f.startsWith('--style='))?.slice('--style='.length) ?? 'clew';
const pdf = flags.includes('--pdf');
// The bibliographies a build could use, as the app lists them
// (export-host.js#bibFilesFor), less the vault's jmarkdown config's.
const header = /^Bibliography:\s*(.+)$/mi.exec(files[`/vault/${noteRel}`] ?? '')?.[1];
const noteDir = path.posix.dirname(noteRel);
const bibFiles = [
	...(vaultOptions.bibliography ? [vaultOptions.bibliography] : []),
	...(header ? header.split(',').map((b) => path.posix.normalize(path.posix.join(noteDir, b.trim()))) : []),
];
// Native's `vault/<token>/<rel>` route: ExportJobs.mayRead, then
// VaultStore.resolve's clamp by real path.
const GRAPHIC = new Set(['pdf', 'png', 'jpg', 'jpeg', 'jbig2', 'jb2', 'eps', 'mps']);
const vaultReads = [];
// The export figure cache: none unless --cache names a folder, and never
// for a restricted vault (native lists it none).
const cacheAt = flags.indexOf('--cache');
const cacheRoot = cacheAt !== -1 && trusted ? path.resolve(flags[cacheAt + 1]) : null;
const cacheLog = { listed: 0, read: [], stored: [], used: [] };
globalThis.__clewExportCache = {
	list() {
		if (!cacheRoot) return [];
		const out = [];
		for (const kind of fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot) : []) {
			for (const name of fs.readdirSync(path.join(cacheRoot, kind))) out.push({ rel: `${kind}/${name}`, bytes: fs.statSync(path.join(cacheRoot, kind, name)).size });
		}
		cacheLog.listed = out.length;
		return out;
	},
	read(rel) { cacheLog.read.push(rel); return new Uint8Array(fs.readFileSync(path.join(cacheRoot, rel))); },
	store(rel, data) {
		if (!cacheRoot) return;
		cacheLog.stored.push(rel);
		fs.mkdirSync(path.dirname(path.join(cacheRoot, rel)), { recursive: true });
		fs.writeFileSync(path.join(cacheRoot, rel), data);
	},
	used(rels) { if (cacheRoot) cacheLog.used.push(...rels); },
};
globalThis.__clewVaultFile = (rel) => {
	vaultReads.push(rel);
	const segments = rel.split('/');
	if (rel.startsWith('/') || segments.some((seg) => seg === '' || seg === '.' || seg === '..' || seg.startsWith('.'))) return null;
	if (!GRAPHIC.has(path.extname(rel).slice(1).toLowerCase())) return null;
	const real = realOf(path.join(vaultAbs, rel));
	if (!real || !inVault(real)) return null;
	try { return new Uint8Array(fs.readFileSync(real)); } catch { return null; }
};
const job = exportJob({
	noteRel, format: pdf ? 'pdf' : 'latex', files, trusted, vaultOptions, bibFiles,
	env: engineEnv({ vaultRoot: '/vault', sessionId: 's1', vaultOptions, access }),
	settings: { latexExportStyle: style, latexEngine: 'auto' }, locale: 'en-GB',
});

// ---- emulate the Worker global surface -----------------------------------

let resolveMessage;
globalThis.self = globalThis;
globalThis.postMessage = (msg) => resolveMessage?.(msg);
const nextMessage = () => new Promise((resolve) => { resolveMessage = resolve; });
// The bundle shows mp-tikz-wasm a browser worker's `process` (the app's
// case: it loads over fetch). Here it runs under Node, from the staged
// folder, so Node's own `process` goes back on the global for it; the
// engine inside the bundle keeps its shim either way.
const nodeProcess = globalThis.process;
await import(path.join(root, 'dist', 'export-worker.js'));
globalThis.process = nodeProcess;
const send = (msg) => self.onmessage({ data: msg });

let waiter = nextMessage();
send({ type: 'init', ...job.init });
const ready = await waiter;
if (ready.type !== 'ready') {
	realErr('INIT FAILED:', ready.message, '\n', ready.stack);
	realExit(1);
}
waiter = nextMessage();
const mptikzUrl = pathToFileURL(path.join(root, 'mptikz-assets', 'index.js')).href;
const spyUrl = () => {
	const url = pathToFileURL(path.join(root, 'tools', 'mptikz-spy.mjs'));
	url.searchParams.set('real', mptikzUrl);
	return url.href;
};
send({ type: 'build', ...job.build, mptikzUrl: spy ? spyUrl() : mptikzUrl });
const result = await waiter;
const texRuns = () => globalThis.__clewTexRuns ?? [];
if (result.type !== 'done') {
	if (spy) fs.writeFileSync(1, JSON.stringify({ error: result.message, refusedLinks, vaultReads, texRuns: texRuns() }) + '\n');
	realErr('BUILD FAILED:', result.message, '\n', result.stack);
	realExit(1);
}
fs.mkdirSync(outDir, { recursive: true });
for (const { rel, data } of result.outputs) {
	fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
	fs.writeFileSync(path.join(outDir, rel), data);
}
const tex = result.outputs.find((o) => o.rel === path.basename(result.output))?.data;
const summary = {
	output: path.basename(result.output),
	files: result.outputs.map(({ rel, data }) => ({ rel, bytes: typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength })),
	warnings: result.warnings,
	references: texReferences({ tex: typeof tex === 'string' ? tex : '', base: job.base, exists: (r) => `/vault/${r}` in files, bibFiles }),
	stats: result.stats ?? null,
	figures: result.figures ?? null,
	cache: cacheLog,
	refusedLinks,
	...(spy ? { vaultReads, texRuns: texRuns() } : {}),
};
fs.writeFileSync(1, JSON.stringify(summary) + '\n');
realExit(0);
