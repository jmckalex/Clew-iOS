/*
	The figure engine: TikZ and MetaPost rendered in-process by mp-tikz-wasm
	(TeX, MetaPost and dvisvgm compiled to WebAssembly) instead of by lualatex,
	dvisvgm, mpost and mptopdf.

	OFF unless the config or a host asks, and then only with a library to load:
	  `Figure engine`: external (the default: the installed tools, as always) |
	                   auto (the library; per figure, the tools when a font the
	                   figure needs cannot be resolved) | wasm (the library only)
	  `MP-TikZ dist`:  the path to a release's dist/ folder (mp-tikz-wasm is no
	                   npm package; its release tarball holds dist/)
	— processFile's `figureEngine` / `mpTikzDist`, the CLI's --figure-engine /
	--mp-tikz-dist. Never from a document header: what the build runs is the
	host's to say (config-manager.js). Off, nothing here is loaded and nothing
	changes: no import, no async parse, the tools exactly as before.

	On, index.js parses asynchronously (one line), and this module's walkTokens
	hook fills each figure before rendering, from the real lexed tokens: the
	TiKZ tokenizer and the MetaPost renderer find a `figureJob` on their token
	instead of compiling, and read what it made. A job left unfilled (markdown
	a script parses through marked_copy, which is synchronous) falls back to the
	tools, as before.

	Cache: the same folders (figure-cache.js cacheDir) and references, but a
	library render is keyed by its source AND the library's fingerprint, so its
	output never mixes with the tools' and a new release re-renders cleanly.
	Fonts: a preamble's \setmainfont{Optima} and the like are found in the
	system's font folders and handed to the library (addFiles); a face it still
	cannot resolve shows in its TeX log, and under `auto` that figure is drawn by
	the tools instead, with a warning.
*/

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { pathToFileURL } from 'url';
import { configManager } from './config-manager.js';
import { addWarning, getWarnings } from './warnings.js';
import { compileInRunDir } from './figure-cache.js';
import { marked } from './utils.js';

const RECREATE_EVERY = 100;   // compiles per instance (the library's memory advice)

function warnOnce(message) {
	if (!getWarnings().some((w) => w.endsWith(message))) addWarning(message);
}

/** The configured engine: 'external' (default), 'auto' or 'wasm'. */
function setting() {
	const v = String(configManager.get('Figure engine') ?? 'external').trim().toLowerCase();
	return v === 'auto' || v === 'wasm' ? v : 'external';
}

function distDir() {
	const d = configManager.get('MP-TikZ dist');
	return d ? path.resolve(process.cwd(), String(d)) : null;
}

/**
 * Whether this build renders figures with the library: a setting other than
 * external AND a dist to load it from. Read by index.js (the async parse) and
 * the tokenizers. A setting with no dist is warned, and the tools are used.
 */
export function figureEngineWanted() {
	if (setting() === 'external') return false;
	if (!distDir()) {
		warnOnce(`Figure engine: ${setting()} needs \`MP-TikZ dist\` (a path to mp-tikz-wasm's dist/) — the installed tools are used`);
		return false;
	}
	return true;
}

// --- the library -------------------------------------------------------------

let lib = null;          // the imported module, or false when it would not load
let mp = null;           // the live instance
let compiles = 0;
let fingerprintCache = null;
const fontsGiven = new Set();

/** What a library render's cache key carries: index.js and the files' sizes, so a new release re-renders. */
function fingerprint() {
	if (fingerprintCache) return fingerprintCache;
	const dist = distDir();
	const h = crypto.createHash('sha1');
	try {
		h.update(fs.readFileSync(path.join(dist, 'index.js')));
		for (const name of fs.readdirSync(dist).sort()) {
			const st = fs.statSync(path.join(dist, name));
			if (st.isFile()) h.update(`${name}:${st.size}\n`);
		}
	} catch { h.update('unreadable'); }
	fingerprintCache = `mp-tikz-wasm ${h.digest('hex').slice(0, 12)}`;
	return fingerprintCache;
}

async function instance() {
	if (lib === false) return null;
	if (mp && compiles < RECREATE_EVERY) return mp;
	if (mp) { mp.dispose(); mp = null; fontsGiven.clear(); }
	try {
		lib ??= await import(pathToFileURL(path.join(distDir(), 'index.js')).href);
		const bundles = [...lib.DEFAULT_BUNDLES, 'opentype'];
		if (fs.existsSync(path.join(distDir(), 'ghostscript', 'gs.wasm'))) bundles.push('ghostscript');
		mp = await lib.MetaPost.create({ bundles, logLevel: 'silent' });
		compiles = 0;
		return mp;
	} catch (error) {
		lib = false;
		warnOnce(`Figure engine: mp-tikz-wasm would not load from ${distDir()} (${String(error?.message ?? error).split('\n')[0]}) — the installed tools are used`);
		return null;
	}
}

// One call into the library: counted (for recreation), and process.exitCode
// kept as it was (an engine run once left its status there).
async function call(fn) {
	const code = process.exitCode;
	try { return await fn(); }
	finally { compiles++; process.exitCode = code; }
}

// --- fonts -----------------------------------------------------------------------

const FONT_DIRS = [
	'/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts',
	path.join(os.homedir(), 'Library/Fonts'),
	'/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.fonts'),
	path.join(os.homedir(), '.local/share/fonts'),
];

// The font families a TeX source names through fontspec.
function namedFonts(source) {
	const names = new Set();
	const re = /\\(?:set(?:main|sans|mono|math)font|newfontfamily\s*\\[A-Za-z@]+|fontspec)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
	for (const m of String(source).matchAll(re)) names.add(m[1].trim());
	return [...names];
}

// A family's file in the system's font folders: `<name>.ttc|.otf|.ttf`, with
// or without its spaces, any case. Null when there is none.
function fontFile(name) {
	const wanted = new Set([name, name.replace(/\s+/g, '')].map((n) => n.toLowerCase()));
	for (const dir of FONT_DIRS) {
		let entries;
		try { entries = fs.readdirSync(dir); } catch { continue; }
		for (const e of entries) {
			const m = /^(.*)\.(ttc|otf|ttf)$/i.exec(e);
			if (m && wanted.has(m[1].toLowerCase())) return path.join(dir, e);
		}
	}
	return null;
}

async function giveFonts(engine, source) {
	for (const name of namedFonts(source)) {
		if (fontsGiven.has(name)) continue;
		fontsGiven.add(name);
		const file = fontFile(name);
		if (file) await engine.addFiles({ [path.basename(file)]: fs.readFileSync(file) });
	}
}

const FONT_MISS = /Could not resolve font|Font shape [^\n]* undefined/;

// --- the jobs --------------------------------------------------------------------

const hash = (kind, text) => crypto.createHash('md5').update(`${fingerprint()}|${kind}|${text}`).digest('hex');

// A TiKZ figure: one SVG, `<hash>.svg` in its cache folder.
async function fillTikz(job) {
	const name = hash('tikz', job.doc);
	const out = path.join(job.dir, `${name}.svg`);
	if (fs.existsSync(out)) return job.use(path.join(job.dir, `${name}.tex`));
	const engine = await instance();
	if (!engine) return job.external();
	await giveFonts(engine, job.doc);
	const optimise = configManager.get('TiKZ optimise');
	const r = await call(() => engine.latex(job.doc, {
		engine: 'lualatex', bbox: 'min',
		dvisvgmArgs: ['--no-fonts=1', ...(optimise ? [`--optimize=${optimise}`] : [])],
	}));
	if (setting() === 'auto' && FONT_MISS.test(r.texLog || '')) {
		addWarning('Figure engine: a TiKZ figure names a font mp-tikz-wasm could not resolve — drawn by the installed tools instead');
		return job.external();
	}
	if (!r.pages?.length || r.status === 'error' || r.status === 'fatal') {
		return job.fail(r.texLog || r.log || r.diagnostics?.map((d) => d.message).join('\n') || 'mp-tikz-wasm made no figure');
	}
	compileInRunDir(job.dir, (run) => { fs.writeFileSync(path.join(run, `${name}.svg`), r.pages[0]); return [`${name}.svg`]; });
	return job.use(path.join(job.dir, `${name}.tex`));
}

// A MetaPost block: one file per figure, `<hash>-N.svg` (HTML) or `<hash>-N.pdf`
// (LaTeX: each figure through the library's TeX, eps in, PDF out).
async function fillMetapost(job) {
	const pdf = job.format === 'pdf';
	const name = hash(pdf ? 'metapost-pdf' : 'metapost-svg', job.body);
	const ext = pdf ? 'pdf' : 'svg';
	const re = new RegExp(`^${name}-\\d+\\.${ext}$`);
	const cached = () => fs.readdirSync(job.dir).filter((f) => re.test(f)).sort();
	if (cached().length) return job.use(cached());
	const engine = await instance();
	if (!engine) return job.external();
	const r = await call(() => engine.run(job.body, { format: pdf ? 'eps' : 'svg' }));
	if (r.status === 'error' || r.status === 'fatal' || !r.figures?.length) {
		return job.fail(r.log || r.diagnostics?.map((d) => d.message).join('\n') || 'mp-tikz-wasm made no figure');
	}
	const files = [];
	for (const [i, fig] of r.figures.entries()) {
		let bytes = fig.svg;
		if (pdf) {
			const p = await call(() => engine.latex(
				'\\documentclass{standalone}\\usepackage{graphicx}\\begin{document}\\includegraphics{fig.mps}\\end{document}',
				{ output: 'pdf', files: { 'fig.mps': fig.eps } }));
			if (!p.pdf) return job.fail(p.texLog || p.log || 'mp-tikz-wasm made no PDF');
			bytes = p.pdf;
		}
		// Named by the figure's own beginfig(N), as the tools' outputtemplate
		// "%j-%c" names theirs.
		files.push({ file: `${name}-${fig.charcode ?? i + 1}.${ext}`, bytes });
	}
	compileInRunDir(job.dir, (run) => {
		for (const f of files) fs.writeFileSync(path.join(run, f.file), f.bytes);
		return files.map((f) => f.file);
	});
	return job.use(cached());
}

// The jobs of this parse, run once the walk has seen them all (so a MetaPost
// `empty-cache` empties its folder BEFORE any figure is filled, as the tools'
// render-time emptying never managed for figures above it).
let pending = [];
let running = null;

async function runAll() {
	await new Promise((resolve) => setImmediate(resolve));
	const jobs = pending;
	pending = [];
	running = null;
	for (const job of jobs) if (job.emptyFirst) job.emptyFirst();
	for (const job of jobs) {
		try {
			if (job.kind === 'tikz') await fillTikz(job);
			else await fillMetapost(job);
		} catch (error) {
			warnOnce(`Figure engine: mp-tikz-wasm failed (${String(error?.message ?? error).split('\n')[0]}) — the installed tools are used`);
			job.external();
		}
	}
}

/** Dispose of the library once the parse is done (a live instance keeps Node running). */
export async function withFigureEngine(parse) {
	try { return await parse(); }
	finally { if (mp) { mp.dispose(); mp = null; } }
}

// Job factories for @begin environments that compile at RENDER time (MetaPost):
// the module that owns the environment registers how to make its job, so this
// module imports none of them. (TiKZ compiles at tokenize time and makes its
// own job there.)
const factories = new Map();

/** Register `factory(token)` → a job, for `@begin(<name>)` tokens, used only when the engine is on. */
export function figureJobFor(name, factory) { factories.set(name, factory); }

// The walk: queue each figure's job; marked awaits what this returns (async mode).
function figureWalk(token) {
	if (!token.figureJob && token.type === 'beginEnd' && factories.has(token.name) && figureEngineWanted()) {
		token.figureJob = factories.get(token.name)(token);
	}
	const job = token.figureJob;
	if (!job || job.queued) return undefined;
	job.queued = true;
	pending.push(job);
	running ??= runAll();
	return running;
}

marked.use({ walkTokens: figureWalk });
