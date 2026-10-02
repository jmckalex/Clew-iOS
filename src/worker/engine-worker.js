// The iOS render worker: jmarkdown inside a Web Worker.
//
// Mirrors the desktop pipeline exactly (render-service.js forks the engine's
// watch-worker.js), with the process boundary swapped for a Worker boundary:
//
//   desktop: fork(watch-worker.js, {cwd: <vault>/.clew/engine}) + real fs
//   iOS:     new Worker(engine-worker.js, {type:'module'}) + vfs snapshot
//
// Same one-shot discipline: ONE build per worker, then the host terminates
// it (a build dirties the marked singleton, `global`, and String.prototype —
// the reason the desktop app never reuses a worker either). The host keeps a
// pre-warmed standby, so worker startup cost is off the critical path.
//
// Protocol (postMessage):
//   → {type:'init', files, env, cwd}   install vfs snapshot, import engine
//   ← {type:'ready'}
//   → {type:'build', file, options, files?}  options: {to, output, fragment, normalSyntax}
//   ← {type:'done', output, html} | {type:'error', message, stack}
//
// `files` maps absolute posix paths to text: the note, every vault text
// file wikiembeds/queries may read, `<cwd>/.jmarkdown/config.json`, and the
// template assets under /engine. Binary vault content never enters the
// worker — media renders as URLs the preview iframe resolves.
//
// Clew's engine extensions are pre-bundled here and served to the engine's
// config-driven loader through __jmdExtensionRegistry (the build patches
// metadata-header.js to consult it before dynamic import). The config the
// host generates references exactly these paths.

import './shims/globals.js';
// Before figures.js: its module body registers a MetaPost grammar on the
// engine's highlight.js through createRequire(), which the shim answers
// from this registry — so the registry must exist when that body runs.
import './shims/require-registry.js';
import { vfs } from './shims/vfs.js';
import * as wikilinks from '../../vendor/clew/engine/wikilinks.js';
import * as obsidianFences from '../../vendor/clew/engine/obsidian-fences.js';
import * as queryFences from '../../vendor/clew/engine/query-fences.js';
import * as blockRefs from '../../vendor/clew/engine/block-refs.js';
import * as dataview from '../../vendor/clew/engine/dataview.js';
import * as bases from '../../vendor/clew/engine/bases.js';
import * as admonitions from '../../vendor/clew/engine/admonitions.js';
import * as metaBind from '../../vendor/clew/engine/meta-bind.js';
import * as kanbanBoard from '../../vendor/clew/engine/kanban-board.js';
import * as figures from '../../vendor/clew/engine/figures.js';
// Callouts are the engine's (jmarkdown a7de8c6); a host hands it custom
// types through CLEW_CALLOUTS — see init.
import { applyCustomCallouts } from '../../vendor/jmarkdown/src/callout-table.js';
import * as revealEmbed from '../../vendor/clew/engine/reveal-embed.js';
import * as tabbing from '../../vendor/clew/engine/tabbing.js';

// One entry per file the generated config NAMES; each module's own imports
// (dataview's dv-expr/dv-functions/dataview-js/vault-model, bases' share of
// the same) resolve through the bundler, never through the registry.
globalThis.__jmdExtensionRegistry = {
	'/engine-assets/wikilinks.js': wikilinks,
	'/engine-assets/obsidian-fences.js': obsidianFences,
	'/engine-assets/query-fences.js': queryFences,
	'/engine-assets/block-refs.js': blockRefs,
	'/engine-assets/dataview.js': dataview,
	'/engine-assets/bases.js': bases,
	'/engine-assets/admonitions.js': admonitions,
	'/engine-assets/meta-bind.js': metaBind,
	'/engine-assets/kanban-board.js': kanbanBoard,
	// Both the Extensions line (fences + directive) and the Environments
	// line (@begin handlers) name this one file.
	'/engine-assets/figures.js': figures,
	// @reveal[…]: an Environments-only entry (inline, block and @begin forms
	// from the one definition).
	'/engine-assets/reveal-embed.js': revealEmbed,
	// ```tabbing (Extensions) and @begin(tabbing) (Environments) name this
	// one file, as figures.js does.
	'/engine-assets/tabbing.js': tabbing,
};

// Enabled vault plugins' engine surfaces: the config names them by absolute
// vault path and the host snapshots their source into the vfs. The build's
// __jmdImport helper (the metadata-header patch) asks here before falling
// back to a real dynamic import — a Worker has no disk to import from.
globalThis.__jmdImportSource = (p) => {
	const entry = vfs.files.get(p);
	return typeof entry?.data === 'string' && entry.data !== '' ? entry.data : null;
};

let enginePromise = null;

async function init({ files, env, cwd }) {
	vfs.reset();
	vfs.install(files);
	Object.assign(process.env, env);
	// The engine's callout table reads CLEW_CALLOUTS when it LOADS — but in
	// this bundle it loads at worker start (admonitions.js's top-level
	// import), before this message set the env. So it is applied here, every
	// init: the resolved custom types (the shim's calloutsEnv), or none.
	try {
		applyCustomCallouts(env?.CLEW_CALLOUTS ? JSON.parse(env.CLEW_CALLOUTS) : null);
	} catch {
		applyCustomCallouts(null); // a table that does not parse is no table
	}
	process.chdir(cwd);
	// Importing the engine loads the module graph and reads ./.jmarkdown/
	// config.json (relative to cwd) — which is why the snapshot and cwd must
	// land first. Nothing builds until processFile().
	// The build pins import.meta.url to file:///engine/… so the engine's
	// 'Jmarkdown app directory' (recomputed per build) resolves template and
	// css reads into the vfs's /engine directory.
	enginePromise = import('../../vendor/jmarkdown/src/index.js');
	await enginePromise;
	self.postMessage({ type: 'ready' });
}

async function build({ file, options, files, replaceVault }) {
	try {
		if (replaceVault) {
			// The build carries the authoritative current vault: drop the
			// warmup snapshot's vault entries first so deletions since this
			// worker spawned don't linger in wikilink/query resolution.
			const root = process.env.CLEW_VAULT_ROOT ?? '/vault';
			for (const abs of [...vfs.files.keys()]) {
				if (abs.startsWith(root + '/')) vfs.files.delete(abs);
			}
		}
		if (files) vfs.install(files);
		const { processFile } = await enginePromise;
		const { outFile } = await processFile(file, options);
		const html = vfs.writes.get(outFile) ?? vfs.read(outFile);
		self.postMessage({ type: 'done', output: outFile, html: String(html) });
	} catch (err) {
		self.postMessage({
			type: 'error',
			message: String(err?.message ?? err),
			stack: err?.stack,
		});
	}
	// One-shot: the host terminates this worker after the result lands.
}

self.onmessage = (event) => {
	const msg = event.data;
	if (msg?.type === 'init') init(msg).catch((err) => self.postMessage({
		type: 'error', message: `engine failed to load: ${String(err?.message ?? err)}`, stack: err?.stack,
	}));
	if (msg?.type === 'build') build(msg);
};
