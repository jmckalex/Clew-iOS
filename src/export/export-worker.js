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
// desktop's restrictedExportDir(). And as that worker does (L2), it hands
// the engine its Obsidian links — an image embed resolved as the preview
// resolves one (vault-files.js#resolveFileTarget, clamped in a restricted
// vault), pointed from the file the export writes
// (export-config.js#exportEmbedPath); a [[link]] prints as its text — and
// sets Clew's configuration for the build on the engine's own configManager
// (export-config.js#configureExportBuild: the fenced header, LaTeX's own
// title, Clew's LaTeX style when the job says so).
//
// Protocol (postMessage):
//   → {type:'init', files, env, cwd}                      as the render worker
//   ← {type:'ready'}
//   → {type:'build', file, options, latexStyle, biblify, pdf, bibFiles, token, mptikzUrl}
//   ← {type:'done', output, warnings, outputs:[{rel, data}]} | {type:'error', message, stack}

import '../worker/shims/globals.js';
import '../worker/shims/require-registry.js';
import { vfs } from '../worker/shims/vfs.js';
import { applyCustomCallouts } from '../../vendor/jmarkdown/src/callout-table.js';
import { getWarnings } from '../../vendor/jmarkdown/src/warnings.js';
import { configureExportBuild, exportEmbedPath, EXPORT_EXTENSIONS } from '../../vendor/clew/engine/export-config.js';
import { mathFontOnlyWithMaths } from '../../vendor/clew/engine/latex-style.js';
import { resolveFileTarget } from '../../vendor/clew/engine/vault-files.js';
import { exportOutputs } from './outputs.js';
import { typeset, settleBeforeTex } from './typeset.js';
import { texReferences } from '../shim/export-references.js';

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
let configPromise = null;

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
	// Clew's own rules, which the preview's config loads and the user's does
	// not (export-config.js#EXPORT_EXTENSIONS: Obsidian's %% comments):
	// after the engine's, as there, and as desktop's export-worker.mjs does.
	(await import('../../vendor/jmarkdown/src/utils.js')).registerExtensions(EXPORT_EXTENSIONS);
	// The engine's own configuration (the module index.js loaded, so the
	// user's config files are read already): configureExportBuild sets on it.
	configPromise = import('../../vendor/jmarkdown/src/config-manager.js');
	await configPromise;
	self.postMessage({ type: 'ready' });
}

/**
 * A vault file the .tex names, for TeX (an image graphicx typesets, never a
 * hidden one: export-references.js decided which), from native's export
 * route for this job's token (ExportHost.swift, `vault/<token>/<rel>`), which
 * checks the same and clamps it to the vault. The Node harness hands its own
 * reader in (__clewVaultFile).
 */
async function vaultFile(rel, token) {
	if (typeof globalThis.__clewVaultFile === 'function') return globalThis.__clewVaultFile(rel);
	const path = rel.split('/').map(encodeURIComponent).join('/');
	const response = await fetch(`/__clew_export__/vault/${token}/${path}`);
	if (!response.ok) return null;
	return new Uint8Array(await response.arrayBuffer());
}

/**
 * A trusted vault's export figure cache (ExportJobs.swift#ExportCache): the
 * figures its earlier exports drew, installed under the build's cache folder
 * as files read only when the figure engine wants one (vfs.lazy, a
 * synchronous read of native's `cache/` route, as mp-tikz-wasm reads its
 * own). Native lists none for a restricted vault's job: its figures stay in
 * the worker. The Node harness hands its own in (__clewExportCache).
 * Answers the paths installed, `<kind>/<file>`.
 */
async function installFigureCache(cacheDir, token) {
	const hook = globalThis.__clewExportCache;
	let files = [];
	try {
		files = hook ? hook.list() : ((await (await fetch(`/__clew_export__/cache/${token}`)).json()).files ?? []);
	} catch { files = []; }
	for (const { rel, bytes } of files) {
		vfs.lazy(`${cacheDir}/${rel}`, bytes, () => {
			if (hook) return hook.read(rel);
			const xhr = new XMLHttpRequest();
			xhr.open('GET', `/__clew_export__/cache/${token}/${rel.split('/').map(encodeURIComponent).join('/')}`, false);
			xhr.responseType = 'arraybuffer';
			xhr.send(null);
			if (xhr.status !== 200) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${cacheDir}/${rel}'`), { code: 'ENOENT' });
			return new Uint8Array(xhr.response);
		});
	}
	return new Set(files.map((f) => f.rel));
}

/** A cached figure's path, `<kind>/<file>`: never a compile's `.run-*` folder, nor a mark. */
const isFigurePath = (rel) => rel.split('/').length === 2 && rel.split('/').every((seg) => seg !== '' && !seg.startsWith('.'));

/**
 * Hand native what the build drew into the cache folder, for the vault's next
 * export, and mark the cached figures this one used (the prune keeps them
 * longest). Native keeps them only for a trusted vault's job.
 */
async function keepFigures(cacheDir, token, drawn, used) {
	const hook = globalThis.__clewExportCache;
	// A figure not kept is drawn again next time: nothing here fails the export.
	const post = async (url, body) => { try { await fetch(url, { method: 'POST', body }); } catch { /* not kept */ } };
	for (const rel of drawn) {
		const data = vfs.writes.get(`${cacheDir}/${rel}`);
		if (hook) hook.store?.(rel, data);
		else await post(`/__clew_export__/cache/${token}?rel=${encodeURIComponent(rel)}`, data);
	}
	if (hook) hook.used?.(used);
	else if (used.length) await post(`/__clew_export__/cacheused/${token}`, JSON.stringify(used));
}

async function build({ file, options, latexStyle = null, biblify = null, pdf = false, bibFiles = [], token = '', mptikzUrl }) {
	try {
		// Read by the figure engine's library import (the build's patch of
		// figure-engine.js#instance): the app's mp-tikz-wasm, by URL.
		globalThis.__clewMpTikzUrl = mptikzUrl ?? null;
		const { processFile } = await enginePromise;
		const { configManager, DEFAULT_CONFIG } = await configPromise;
		// An image embed resolved as the preview resolves one, then pointed
		// from the file this export writes. The vfs has no links, so no
		// realpath is handed in.
		const resolveEmbed = (name, { file: from } = {}) => {
			const rel = resolveFileTarget(String(name));
			if (!rel) return null;
			const { output, to, chapters } = options;
			return exportEmbedPath({ abs: `${process.env.CLEW_VAULT_ROOT}/${rel}`, output, to, chapters, file: from });
		};
		// Code coloured by the build, set with fvextra (jmarkdown's `LaTeX
		// highlighter: highlight.js`, the owner's (2a)), for every iPad LaTeX
		// build, the .tex as the PDF: minted runs Python from TeX, which the
		// iPad's TeX cannot, and a .tex shared from here compiles anywhere
		// without shell escape. A header's own key still wins.
		configManager.set('LaTeX highlighter', 'highlight.js');
		if (pdf) {
			// The owner's (a), for the iPad's TeX: the .tex itself is written for
			// LuaLaTeX — fontspec, so Latin Modern OpenType text — unless the
			// note's header asks for pdfLaTeX (merged later, it wins); then its
			// T1 text is in lmodern's Type 1 fonts, never cm-super's, which this
			// TeX lacks (bitmaps). Never a .tex built for pdfLaTeX run through
			// LuaLaTeX: Unicode prints wrongly (– as nothing, × as Œ).
			configManager.set('LaTeX engine', 'lualatex');
			configManager.set('LaTeX T1 fonts', 'lmodern');
		}
		configureExportBuild(configManager, { to: options.to, latexStyle, biblify, defaults: DEFAULT_CONFIG });
		const cacheDir = options.cacheDir ?? null;
		const cached = cacheDir ? await installFigureCache(cacheDir, token) : new Set();
		const { outFile } = await processFile(file, { ...options, obsidianLinks: { resolveEmbed, resolveLink: () => null } });
		const built = Date.now();
		// Clew's style loads Garamond-Math only for a document with maths
		// (latex-style.js#mathFontOnlyWithMaths, the owner's C4): the .tex the
		// share carries and the one TeX is handed alike, as desktop rewrites it.
		if (options.to === 'latex' && vfs.files.has(outFile)) {
			const written = String(vfs.read(outFile));
			const kept = mathFontOnlyWithMaths(written);
			if (kept !== written) vfs.write(outFile, kept);
		}
		let outputs = exportOutputs(vfs.writes, outFile);
		// What the figure engine drew (new in the cache folder), and the
		// cached figures the output uses (its `<base>-figures/` copies).
		const figuresPrefix = `${outFile.slice(outFile.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')}-figures/`;
		const drawn = cacheDir ? [...vfs.writes.keys()]
			.filter((abs) => abs.startsWith(`${cacheDir}/`)).map((abs) => abs.slice(cacheDir.length + 1))
			.filter((rel) => isFigurePath(rel) && !cached.has(rel)) : [];
		const used = outputs.map((o) => o.rel).filter((rel) => rel.startsWith(figuresPrefix))
			.map((rel) => rel.slice(figuresPrefix.length)).filter(isFigurePath);
		if (cacheDir) await keepFigures(cacheDir, token, drawn, used);
		let output = outFile;
		const extra = [];
		let typesetting = null;
		if (pdf) {
			// PDF via LaTeX: the .tex typeset here, and only the PDF goes out.
			const texRel = outFile.slice(outFile.lastIndexOf('/') + 1);
			const dir = outFile.slice(0, outFile.lastIndexOf('/'));
			const base = texRel.replace(/\.tex$/, '');
			const tex = String(outputs.find((o) => o.rel === texRel)?.data ?? '');
			const inputs = Object.fromEntries(outputs.filter((o) => o.rel !== texRel).map((o) => [o.rel, o.data]));
			const refs = texReferences({ tex, base, exists: (r) => vfs.files.has(`${dir}/${r}`), bibFiles });
			for (const { rel, as } of refs.bibs) inputs[as] = String(vfs.files.get(`${dir}/${rel}`)?.data ?? '');
			for (const rel of refs.files) {
				const bytes = await vaultFile(rel, token);
				if (bytes) inputs[rel] = bytes;
				else extra.push(`${rel} could not be read from the vault, so the PDF goes without it`);
			}
			for (const name of refs.missing) extra.push(`${name} is named by the .tex but is not in this vault`);
			for (const { rel } of refs.refused) extra.push(`${rel} is named by the .tex but is not an image TeX can typeset, or is hidden, so TeX was not given it`);
			const lib = await import(mptikzUrl);
			// The figure engine's worker goes before TeX's starts (typeset.js
			// #settleBeforeTex); the vault reads above count towards the wait.
			const wait = settleBeforeTex(drawn.length) - (Date.now() - built);
			if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
			typesetting = await typeset({ lib, tex, inputs });
			extra.push(...typesetting.warnings);
			outputs = [{ rel: `${base}.pdf`, data: typesetting.pdf }];
			output = `${dir}/${base}.pdf`;
		}
		// Each figure's bytes are its own buffer (the fs shim copies on write);
		// a Set all the same, since a buffer listed twice cannot be transferred.
		const transfer = [...new Set(outputs.map((o) => o.data).filter((d) => d instanceof Uint8Array).map((d) => d.buffer))];
		const stats = typesetting && { engine: typesetting.engine, passes: typesetting.passes, bibtex: typesetting.bibtex, makeindex: typesetting.makeindex, ms: typesetting.ms };
		self.postMessage({ type: 'done', output, warnings: [...getWarnings(), ...extra], outputs, stats, figures: { drawn: drawn.length, used: used.length } }, transfer);
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
