// The export worker: one note's LaTeX export (and, from the PDF phase, its
// TeX), inside the export host's page (src/export/host.js), never the app
// page's. UPSTREAM-LATEX-EXPORT-PLAN.md §3, L1.
//
// It is the render worker's engine (src/worker/engine-worker.js: the same
// shims, the same vfs snapshot, the same one-shot discipline) with what an
// export needs and a preview never does:
//   - the figure engine, `wasm` only: a MetaPost figure in a .tex is a PDF
//     made by mp-tikz-wasm, loaded from the app's own copy
//     (__clew_assets__/mptikz/, the URL the build message names). WebAssembly
//     runs here because the host page is a clew-preview document, whose CSP
//     allows it; the app page's does not, so the render worker cannot.
//   - binary outputs: the .tex and its `-figures/` folder go back as data
//     (src/export/outputs.js), for the host to hand to native.
//
// Like desktop's engine/export-worker.mjs, the engine reads the vault's own
// jmarkdown configuration (the build's cwd), never the preview's generated
// one; a restricted vault's cwd holds `Run note code: false` alone, as
// desktop's restrictedExportDir().
//
// Protocol (postMessage):
//   → {type:'init', files, env, cwd}                      as the render worker
//   ← {type:'ready'}
//   → {type:'build', file, options, mptikzUrl}
//   ← {type:'done', output, warnings, outputs:[{rel, data}]} | {type:'error', message, stack}

import '../worker/shims/globals.js';
import '../worker/shims/require-registry.js';
import { vfs } from '../worker/shims/vfs.js';
import { applyCustomCallouts } from '../../vendor/jmarkdown/src/callout-table.js';
import { getWarnings } from '../../vendor/jmarkdown/src/warnings.js';
import { exportOutputs } from './outputs.js';

// mp-tikz-wasm decides where it runs from the GLOBAL `process`: Node when it
// has `versions.node` (its index.js#isNode), and its Emscripten modules
// unless `type` is 'renderer'. globals.js makes that global a Node
// look-alike, which this worker is not: the library then reaches for
// `process.binding` and `require('fs')` and fails to load (measured). The
// engine's own `process` is the shim esbuild binds at build time, untouched
// by this; the global, which only code loaded at run time reads, now says
// what this is: a browser worker.
globalThis.process = Object.create(process, { versions: { value: {} }, type: { value: 'renderer' } });

// The figure engine yields with setImmediate between parsing and filling its
// jobs (figure-engine.js#runAll), which a worker does not have. A macrotask,
// never a microtask (the ef5f7f2 lesson: a microtask yields to nothing).
if (typeof globalThis.setImmediate !== 'function') {
	const channel = new MessageChannel();
	const queue = [];
	channel.port1.onmessage = () => queue.shift()?.();
	globalThis.setImmediate = (fn, ...args) => {
		queue.push(() => fn(...args));
		channel.port2.postMessage(0);
	};
}

// A vault's own jmarkdown configuration may name extension files; the
// metadata-header patch (scripts/build.js#enginePatches) asks here for their
// source, as the render worker does.
globalThis.__jmdImportSource = (p) => {
	const entry = vfs.files.get(p);
	return typeof entry?.data === 'string' && entry.data !== '' ? entry.data : null;
};

let enginePromise = null;

async function init({ files, env, cwd }) {
	vfs.reset();
	vfs.install(files);
	Object.assign(process.env, env);
	try {
		applyCustomCallouts(env?.CLEW_CALLOUTS ? JSON.parse(env.CLEW_CALLOUTS) : null);
	} catch {
		applyCustomCallouts(null);
	}
	process.chdir(cwd);
	enginePromise = import('../../vendor/jmarkdown/src/index.js');
	await enginePromise;
	self.postMessage({ type: 'ready' });
}

async function build({ file, options, mptikzUrl }) {
	try {
		// Read by the figure engine's library import (the build's patch of
		// figure-engine.js#instance): the app's mp-tikz-wasm, by URL.
		globalThis.__clewMpTikzUrl = mptikzUrl ?? null;
		const { processFile } = await enginePromise;
		const { outFile } = await processFile(file, options);
		const outputs = exportOutputs(vfs.writes, outFile);
		// Each figure's bytes are its own buffer (the fs shim copies on write);
		// a Set all the same, since a buffer listed twice cannot be transferred.
		const transfer = [...new Set(outputs.map((o) => o.data).filter((d) => d instanceof Uint8Array).map((d) => d.buffer))];
		self.postMessage({ type: 'done', output: outFile, warnings: getWarnings(), outputs }, transfer);
	} catch (err) {
		self.postMessage({ type: 'error', message: String(err?.message ?? err), stack: err?.stack });
	}
}

self.onmessage = (event) => {
	const msg = event.data;
	if (msg?.type === 'init') init(msg).catch((err) => self.postMessage({
		type: 'error', message: `engine failed to load: ${String(err?.message ?? err)}`, stack: err?.stack,
	}));
	if (msg?.type === 'build') build(msg);
};
