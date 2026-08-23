/*
	One-shot warm build worker for `jmarkdown watch` (see watch.js).

	Forked by the watcher. On start it imports index.js — which loads the heavy
	module graph (marked, cheerio, citation-js, mathjs, …) and registers nothing
	until processFile() is called — then reports `ready` and waits. On the first
	`build` message it runs EXACTLY ONE build, reports the output path and the
	files it read, and exits.

	Why one-shot: a process that has built a file is "dirty" — it has accumulated
	additive marked.use() registrations on the shared singleton, polluted the
	real `global` (and String.prototype) via script blocks, and populated the ESM
	import cache. Reusing it would reintroduce exactly the cross-document state
	bleed JMarkdown's one-shot CLI design avoids. So the watcher keeps a fresh,
	pre-warmed standby instead of ever reusing a worker.
*/
import path from 'path';
import fs from 'fs';
import { getDeps, resetDeps } from './dep-tracker.js';
import { getWarnings } from './warnings.js';
import { configManager } from './config-manager.js';

// Normalise a metadata list value to a flat array of ref strings. CSS/Script come
// as one array entry per header line; a comma-separated `Watch` line arrives as a
// single string — so split on commas and flatten either way.
function toRefList(v) {
	if (v == null) return [];
	return (Array.isArray(v) ? v : [v])
		.flatMap((s) => String(s).split(','))
		.map((s) => s.trim())
		.filter(Boolean);
}

// A ref is "local" (watchable / injectable) only if it isn't an absolute URL,
// protocol-relative (`//cdn/…`), or a data: URI.
function isLocalRef(ref) {
	return !/^([a-z][a-z0-9+.-]*:)?\/\//i.test(ref) && !/^data:/i.test(ref);
}

// Collect the local CSS/JS files the live preview should track. Linked assets
// (`CSS`/`Script`) resolve the way the browser resolves them: relative to the
// served document (the output dir). `Watch` extras — files not directly linked
// (an @imported partial, a module a linked script imports) — resolve relative to
// the markdown source dir, and are classified by extension. The watcher decides
// what to DO with each (the worker just reports what exists on disk).
function collectAssets(outFile, sourceFile) {
	const outDir = path.dirname(outFile);
	const srcDir = path.dirname(sourceFile);
	const cssLinked = [];
	const jsLinked = [];
	const watchExtra = [];

	for (const href of toRefList(configManager.get('CSS'))) {
		if (!isLocalRef(href)) continue;
		const file = path.resolve(outDir, href.split(/[?#]/)[0]);
		if (fs.existsSync(file)) cssLinked.push({ file, href });
	}
	for (const src of toRefList(configManager.get('Script'))) {
		if (!isLocalRef(src)) continue;
		const file = path.resolve(outDir, src.split(/[?#]/)[0]);
		if (fs.existsSync(file)) jsLinked.push({ file });
	}
	for (const entry of toRefList(configManager.get('Watch'))) {
		const clean = entry.split(/[?#]/)[0];
		const file = path.resolve(srcDir, clean);
		if (!fs.existsSync(file)) continue;
		watchExtra.push({ file, kind: /\.css$/i.test(clean) ? 'css' : 'reload' });
	}
	return { cssLinked, jsLinked, watchExtra };
}

// File reads are recorded by the CJS preload (watch-fs-preload.cjs, applied via
// -r when this worker is forked); resetDeps() before the build clears the
// warm-up reads so the reported set is just the build's.

// WARM UP: importing index.js runs only its (file-independent) module-load —
// the guard in index.js keeps it from parsing argv or building anything.
const { processFile } = await import('./index.js');

if (process.send) process.send({ type: 'ready' });

process.once('message', async (msg) => {
	if (!msg || msg.type !== 'build') return;
	resetDeps();
	try {
		const { outFile } = await processFile(msg.file, msg.options);
		// warnings: build-quality nags (unresolved refs, duplicate labels) the
		// watcher shows in the browser as an amber banner.
		// assets: local CSS/JS files to live-track (read from the merged config
		// after the build — the build references but never reads these files, so
		// they never enter the fs dep set).
		const assets = collectAssets(outFile, msg.file);
		if (process.send) process.send({ type: 'done', output: outFile, deps: getDeps(), warnings: getWarnings(), assets });
	} catch (err) {
		if (process.send) process.send({
			type: 'error',
			message: String((err && err.message) || err),
			stack: err && err.stack,
			deps: getDeps(),
		});
	} finally {
		process.exit(0); // one-shot: die so accumulated state can't bleed into a reuse
	}
});
