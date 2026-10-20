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
//   node tools/export-note.mjs <vault-dir> <note-rel-path> <out-dir> [--restricted] [--style=none]
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

const vaultOptions = (() => {
	try { return JSON.parse(fs.readFileSync(path.join(vaultAbs, '.clew', 'vault-settings.json'), 'utf8')); } catch { return {}; }
})();

// The vault's text files, binaries as names only, `.clew/` aside: what the
// app's render service snapshots (render-service.js#vaultFiles). Dot folders
// other than .clew ride along, as in the app (a vault's .jmarkdown/).
const files = {};
const walk = (dir, rel) => {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (['.clew', '.trash', 'node_modules', '.git'].includes(entry.name)) continue;
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
		else files[`/vault/${childRel}`] = isTextPath(entry.name) ? fs.readFileSync(path.join(dir, entry.name), 'utf8') : '';
	}
};
walk(vaultAbs, '');
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
const job = exportJob({
	noteRel, format: 'latex', files, trusted, vaultOptions,
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
send({ type: 'build', ...job.build, mptikzUrl: pathToFileURL(path.join(root, 'mptikz-assets', 'index.js')).href });
const result = await waiter;
if (result.type !== 'done') {
	realErr('BUILD FAILED:', result.message, '\n', result.stack);
	realExit(1);
}
fs.mkdirSync(outDir, { recursive: true });
for (const { rel, data } of result.outputs) {
	fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
	fs.writeFileSync(path.join(outDir, rel), data);
}
const tex = result.outputs.find((o) => o.rel === path.basename(result.output))?.data;
// The bibliographies a build could use, as the app lists them
// (export-host.js#bibFilesFor), less the vault's jmarkdown config's.
const header = /^Bibliography:\s*(.+)$/mi.exec(files[`/vault/${noteRel}`] ?? '')?.[1];
const noteDir = path.posix.dirname(noteRel);
const bibFiles = [
	...(vaultOptions.bibliography ? [vaultOptions.bibliography] : []),
	...(header ? header.split(',').map((b) => path.posix.normalize(path.posix.join(noteDir, b.trim()))) : []),
];
const summary = {
	output: path.basename(result.output),
	files: result.outputs.map(({ rel, data }) => ({ rel, bytes: typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength })),
	warnings: result.warnings,
	references: texReferences({ tex: typeof tex === 'string' ? tex : '', base: job.base, exists: (r) => `/vault/${r}` in files, bibFiles }),
};
fs.writeFileSync(1, JSON.stringify(summary) + '\n');
realExit(0);
