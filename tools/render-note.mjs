// Drive dist/engine-worker.js under plain Node: emulate the Worker global
// surface, snapshot a real vault directory into the vfs, render one note,
// print the HTML to stdout. Used by tests/engine-worker.test.js (spawned as
// a child process — the bundle installs its own `process` global, which
// must not clobber the test runner's) and handy as a dev CLI:
//
//   node tools/render-note.mjs <vault-dir> <note-rel-path> [--fragment]
//                              [--vault-options '<json>'] [--global-fragments '<json>']
//
// The engine config and the text-file rule come from src/shim/engine-config.js
// — the SAME module the app's render service uses. They used to be hand-copied
// here, and the copy went stale silently: notes rendered without the
// extensions the app loads, and the battery still reported green.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineConfig, engineEnv, isTextPath, ENGINE_CSL_FILES } from '../src/shim/engine-config.js';
import { engineExtensionEntries } from '../vendor/clew/main/plugins.js';

const [vaultDir, noteRel, ...flags] = process.argv.slice(2);
const fragment = flags.includes('--fragment');
const optionsAt = flags.indexOf('--vault-options');
// The app-level `texFragments` list (global scope), for the CLEW_TEX_FRAGMENTS
// arc: `--global-fragments '[{"name":…,"text":…}]'`.
const fragmentsAt = flags.indexOf('--global-fragments');
const globalTexFragments = fragmentsAt !== -1 ? JSON.parse(flags[fragmentsAt + 1] ?? '[]') : [];
if (!vaultDir || !noteRel) {
	console.error('usage: node tools/render-note.mjs <vault-dir> <note-rel-path> [--fragment]');
	process.exit(2);
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vaultAbs = path.resolve(vaultDir);

// Per-vault settings (dataviewJs, pandocCitations, bibliography, plugins…):
// the vault's own .clew/vault-settings.json by default — the file the app
// reads, so a battery run exercises the config the app would actually use —
// with --vault-options REPLACING it when a case needs a specific gate.
const vaultOptions = optionsAt !== -1
	? JSON.parse(flags[optionsAt + 1] ?? '{}')
	: (() => {
		try {
			return JSON.parse(fs.readFileSync(
				path.join(vaultAbs, '.clew', 'vault-settings.json'), 'utf8'));
		} catch { return {}; }
	})();
const realExit = process.exit.bind(process);
const realErr = (...a) => console.error(...a);

// ---- snapshot the vault's text files -------------------------------------

const files = {};
const walk = (dir, rel) => {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.') || ['node_modules', '.trash'].includes(entry.name)) continue;
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
		else if (isTextPath(entry.name)) {
			files[`/vault/${childRel}`] = fs.readFileSync(path.join(dir, entry.name), 'utf8');
		} else {
			// Binary files exist in the tree (wikilink resolution needs their
			// names) but their bytes never enter the worker.
			files[`/vault/${childRel}`] = '';
		}
	}
};
walk(vaultAbs, '');

// Enabled plugins' engine surfaces, exactly as the app snapshots them:
// entries are computed over the real vault dir (manifest validation lives
// in vendor/clew/main/plugins.js), then re-rooted onto the vfs, and the
// named files ride in the snapshot — the only .clew content that does.
const engineExtensions = [];
for (const entry of engineExtensionEntries(vaultAbs, vaultOptions)) {
	const at = entry.indexOf(' from ');
	const real = entry.slice(at + ' from '.length);
	const vfsPath = '/vault/' + path.relative(vaultAbs, real).split(path.sep).join('/');
	files[vfsPath] = fs.readFileSync(real, 'utf8');
	engineExtensions.push(entry.slice(0, at) + ' from ' + vfsPath);
}

// ---- engine config + template assets (mirrors render-service.js) ---------

files['/vault/.clew/engine/.jmarkdown/config.json'] = JSON.stringify(
	engineConfig({ vaultRoot: '/vault', vaultOptions, engineExtensions }), null, 2);

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

// ---- emulate the Worker global surface -----------------------------------

const results = [];
let resolveMessage;
globalThis.self = globalThis;
globalThis.postMessage = (msg) => {
	results.push(msg);
	resolveMessage?.(msg);
};
const nextMessage = () => new Promise((resolve) => { resolveMessage = resolve; });

await import(path.join(root, 'dist', 'engine-worker.js'));

const send = (msg) => self.onmessage({ data: msg });

let waiter = nextMessage();
send({
	type: 'init',
	files,
	cwd: '/vault/.clew/engine',
	env: engineEnv({ vaultRoot: '/vault', sessionId: 's1', vaultOptions, globalTexFragments }),
});
const ready = await waiter;
if (ready.type !== 'ready') {
	realErr('INIT FAILED:', ready.message, '\n', ready.stack);
	realExit(1);
}

waiter = nextMessage();
send({
	type: 'build',
	file: `/vault/${noteRel}`,
	options: {
		to: 'html',
		output: `/vault/.clew/cache/html/out.html`,
		...(fragment ? { fragment: true } : {}),
	},
});
const result = await waiter;
if (result.type !== 'done') {
	realErr('BUILD FAILED:', result.message, '\n', result.stack);
	realExit(1);
}
// Synchronous write to fd 1: piped stdout is async in Node, and exiting
// right after console.log truncates the document mid-flight.
fs.writeFileSync(1, result.html + '\n');
realExit(0);
