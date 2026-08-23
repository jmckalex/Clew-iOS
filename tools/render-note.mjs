// Drive dist/engine-worker.js under plain Node: emulate the Worker global
// surface, snapshot a real vault directory into the vfs, render one note,
// print the HTML to stdout. Used by tests/engine-worker.test.js (spawned as
// a child process — the bundle installs its own `process` global, which
// must not clobber the test runner's) and handy as a dev CLI:
//
//   node tools/render-note.mjs <vault-dir> <note-rel-path> [--fragment]
//
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [vaultDir, noteRel, ...flags] = process.argv.slice(2);
const fragment = flags.includes('--fragment');
if (!vaultDir || !noteRel) {
	console.error('usage: node tools/render-note.mjs <vault-dir> <note-rel-path> [--fragment]');
	process.exit(2);
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vaultAbs = path.resolve(vaultDir);
const realExit = process.exit.bind(process);
const realErr = (...a) => console.error(...a);

// ---- snapshot the vault's text files -------------------------------------

const TEXT_EXT = /\.(md|jmd|bib|canvas|json|css|js|txt|csl|xml|yaml|yml|svg|html|gpx|geojson)$/i;
const files = {};
const walk = (dir, rel) => {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.') || ['node_modules', '.trash'].includes(entry.name)) continue;
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
		else if (TEXT_EXT.test(entry.name)) {
			files[`/vault/${childRel}`] = fs.readFileSync(path.join(dir, entry.name), 'utf8');
		} else {
			// Binary files exist in the tree (wikilink resolution needs their
			// names) but their bytes never enter the worker.
			files[`/vault/${childRel}`] = '';
		}
	}
};
walk(vaultAbs, '');

// ---- engine config + template assets (mirrors render-service.js) ---------

files['/vault/.clew/engine/.jmarkdown/config.json'] = JSON.stringify({
	'File inclusion': false,
	'Header style': 'fenced',
	'Template': '/engine/clew-template.html',
	'Extensions': [
		'wikiembed, wikilink from /engine-assets/wikilinks.js',
		'mermaidFence, leafletFence from /engine-assets/obsidian-fences.js',
		'queryFence, tasksFence, kanbanFence from /engine-assets/query-fences.js',
	],
	'MathJax': { 'src': '/__clew_assets__/mathjax/tex-svg.js' },
	'Mermaid': '/__clew_assets__/mermaid/mermaid.min.js',
	'Fontawesome': '/__clew_assets__/fontawesome/all.min.js',
	'Highlight src': '/__clew_assets__/highlight/atom-one-dark.min.css',
}, null, 2);

for (const [target, source] of Object.entries({
	'/engine/default-template.html.mustache': 'vendor/jmarkdown/src/default-template.html.mustache',
	'/engine/default-template.tex.mustache': 'vendor/jmarkdown/src/default-template.tex.mustache',
	'/engine/Biblify.js.mustache': 'vendor/jmarkdown/src/Biblify.js.mustache',
	'/engine/jmarkdown.css': 'vendor/jmarkdown/src/jmarkdown.css',
	'/engine/clew-template.html': 'vendor/clew/engine/clew-template.html',
})) {
	files[target] = fs.readFileSync(path.join(root, source), 'utf8');
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
	env: { CLEW_VAULT_ROOT: '/vault', CLEW_SESSION_ID: 's1' },
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
