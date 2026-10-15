/*
	The figure engine: TikZ and MetaPost rendered in-process by mp-tikz-wasm
	(TeX, MetaPost and dvisvgm compiled to WebAssembly) instead of by lualatex,
	dvisvgm, mpost and mptopdf.

	OFF unless the config or a host asks, and then only with a library to load:
	  `Figure engine`: external (the default: the installed tools, as always) |
	                   auto (the library; per figure, the tools when a font the
	                   figure needs cannot be resolved, or a file its TeX does
	                   not have) | wasm (the library only: the tools are never
	                   run, on any path — a figure the library does not draw
	                   is refused by name instead)
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
	output never mixes with the tools' and a new release re-renders cleanly
	(and, given `figureFonts`, by the host's font files, below).
	Fonts: a preamble's \setmainfont{Optima} and the like are found in the
	system's font folders and handed to the library (addFiles) — or in the
	host's own font index, when it passes processFile's `figureFonts` (below);
	a face it still cannot resolve shows in its TeX log: under `auto` that
	figure is drawn by the tools instead, and under `wasm` it is drawn without
	that face; a warning either way. Under `auto` a figure whose TeX needs a
	file the library's bundles leave out (a package such as siunitx or
	tikz-feynman) goes to the tools too: the installed TeX has it.
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

/*
	`wasm` is the library ALONE: the installed lualatex, dvisvgm, mpost and
	mptopdf are never run, on any path — no dist, a library that will not load,
	a library call that throws, a figure no walk filled. A host relies on it
	(Clew's restricted vaults: the installed TeX reads any file the user can).
	It is enforced where the tools are called, not where the fallbacks are
	decided: tikz.js's compile and metapost.js's renderers ask
	figureToolsRefused() first, and a figure the library did not draw becomes
	refuseFigure(name) — a `jmd-refused` marker naming it in HTML, as note code
	refused is (note-code.js), nothing in LaTeX, and a warning. The marker's
	words are for a reader ("[TiKZ figure not drawn]"); the reason is the
	warning's, for the author.
*/
export function figureToolsRefused() {
	return setting() === 'wasm';
}

// How a reader is told which kind of figure is missing.
const FIGURE_WORDS = { TiKZ: 'TiKZ', metapost: 'MetaPost' };

export function refuseFigure(name) {
	warnOnce(`${name} not drawn — \`Figure engine: wasm\` never runs the installed tools`);
	if (global.isLatex) return '';
	return `<div class="jmd-error jmd-refused" data-jmd-refused="${name}">[${FIGURE_WORDS[name] ?? name} figure not drawn]</div>\n`;
}

// What the engine falls back to when the library cannot draw: the tools, or
// under `wasm` nothing.
const fallback = () => (setting() === 'wasm'
	? 'no figure is drawn (`wasm` never runs the installed tools)'
	: 'the installed tools are used');

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
		warnOnce(`Figure engine: ${setting()} needs \`MP-TikZ dist\` (a path to mp-tikz-wasm's dist/) — ${fallback()}`);
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
	if (mp) { mp.dispose(); mp = null; fontsGiven.clear(); filesGiven.clear(); }
	try {
		lib ??= await import(pathToFileURL(path.join(distDir(), 'index.js')).href);
		const bundles = [...lib.DEFAULT_BUNDLES, 'opentype'];
		if (fs.existsSync(path.join(distDir(), 'ghostscript', 'gs.wasm'))) bundles.push('ghostscript');
		mp = await lib.MetaPost.create({ bundles, logLevel: 'silent' });
		compiles = 0;
		return mp;
	} catch (error) {
		lib = false;
		warnOnce(`Figure engine: mp-tikz-wasm would not load from ${distDir()} (${String(error?.message ?? error).split('\n')[0]}) — ${fallback()}`);
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

/*
	A host's own font index: processFile's `figureFonts` — a function family →
	files (Clew's system-fonts.js `familyFiles`), or an object family → files,
	its names matched without regard to case. Whole families, a face per file
	included (Times New Roman, Georgia, Arial: their bold and italic are files
	of their own, which the folder search by file name never finds), and only
	what the host chose: its answer is FINAL, so a family it gives no files for
	gets none, and its size cap stands. Only a host that fails to answer — its
	function throws, or gives back something that is not a list of files —
	falls back to the folder search, with a warning.

	processFile's option ALONE sets it (index.js, every build): never a header,
	a folder's .jmarkdown/config.json or the global config, as with `Figure
	engine`. Nothing here runs under `external`: only the library reads fonts.
*/
let hostFonts = null;
let hostFontsMalformed = false;
const filesGiven = new Set();

/** processFile's `figureFonts`, for this build (absent: the folder search, as always). */
export function setFigureFonts(option) {
	hostFonts = null;
	hostFontsMalformed = false;
	if (typeof option === 'function') {
		hostFonts = option;
	} else if (option && typeof option === 'object') {
		const entries = option instanceof Map ? [...option] : Object.entries(option);
		const table = new Map(entries.map(([family, files]) => [String(family).toLowerCase(), files]));
		hostFonts = (family) => table.get(family.toLowerCase()) ?? [];
	} else if (option != null && option !== false) {
		hostFontsMalformed = true;   // warned where fonts are read, so `external` stays untouched
	}
}

// The files the host gives for a family, as absolute paths (`host: true`); on
// no answer, the folder search's, warned (`host: false`).
async function hostFamilyFiles(name) {
	let answer;
	try {
		answer = await hostFonts(name);
	} catch (error) {
		return folderSearch(name, `threw (${String(error?.message ?? error).split('\n')[0]})`);
	}
	if (typeof answer === 'string') answer = [answer];
	if (!Array.isArray(answer) || !answer.every((f) => typeof f === 'string' && f !== '')) {
		return folderSearch(name, 'gave no list of files');
	}
	return { host: true, files: answer.map((f) => path.resolve(process.cwd(), f)) };
}

function folderSearch(name, why) {
	const file = fontFile(name);
	warnOnce(`Figure engine: the host's \`figureFonts\` ${why} for \`${name}\` — ${file ? `the font folders' ${path.basename(file)} is used` : 'no font folder has it either'}`);
	return { host: false, files: file ? [file] : [] };
}

/**
 * With `figureFonts`: the files the host gives for the families a source
 * names, as `{ files, stamp }` — `stamp` goes into the figure's cache key, so
 * a render made with other files (a regular face alone, before the host's
 * fonts were given) is never reused. A family the folder search answered for
 * adds nothing to it: the same file as without the option, so the same
 * render, under the same key.
 * Without it: null, and the key and the hand-over are as they always were.
 */
async function hostFontsFor(source) {
	if (hostFontsMalformed) warnOnce('Figure engine: `figureFonts` is a function or an object (family → files) — ignored, so the font folders are searched');
	if (!hostFonts) return null;
	const files = [];
	const stamp = [];
	for (const name of namedFonts(source)) {
		const answer = await hostFamilyFiles(name);
		const given = [];
		for (const file of answer.files) {
			let size;
			try { size = fs.statSync(file).size; } catch {
				warnOnce(`Figure engine: the host's \`figureFonts\` gave \`${file}\` for \`${name}\`, which cannot be read — left out`);
				continue;
			}
			given.push(`${path.basename(file)}:${size}`);
			if (!files.includes(file)) files.push(file);
		}
		if (answer.host) stamp.push(`${name}=${given.join(',')}`);
	}
	return { files, stamp: stamp.length ? `\n%figure-fonts ${stamp.join(';')}` : '' };
}

async function giveFonts(engine, source, host) {
	if (host) {
		for (const file of host.files) {
			if (filesGiven.has(file)) continue;
			let bytes;
			try { bytes = fs.readFileSync(file); } catch {
				warnOnce(`Figure engine: the host's \`figureFonts\` gave \`${file}\`, which cannot be read — left out`);
				continue;
			}
			filesGiven.add(file);
			await engine.addFiles({ [path.basename(file)]: bytes });
		}
		return;
	}
	for (const name of namedFonts(source)) {
		if (fontsGiven.has(name)) continue;
		fontsGiven.add(name);
		const file = fontFile(name);
		if (file) await engine.addFiles({ [path.basename(file)]: fs.readFileSync(file) });
	}
}

const FONT_MISS = /Could not resolve font|Font shape [^\n]* undefined/;

// A file the library's TeX does not have: `! LaTeX Error: File `siunitx.sty'
// not found.` (its bundles hold a selection of TeX Live, the tools all of it).
const MISSING_FILE = /! LaTeX Error: File `([^']+)' not found/;

// TeX breaks its log at 79 columns, mid-word, so a long file or font name
// arrives in pieces: a line of exactly 79 characters runs on into the next
// (a missing `/private/tmp/…/outside.txt` was named with a newline inside
// it). The lines are joined before a name is read out of the log.
function unwrapTexLog(log) {
	const lines = String(log || '').split('\n');
	return lines.map((line, i) => line + (line.length === 79 && i < lines.length - 1 ? '' : '\n')).join('');
}

// --- the jobs --------------------------------------------------------------------

// A TiKZ figure sent to the installed tools under `auto`, and a warning that
// says what came of it. The tools can fail too — a font no installed TeX has,
// or no lualatex at all — and the page then shows an error box, which a
// warning saying "drawn by the installed tools" used to sit above.
function toTools(job, why) {
	const failure = job.external();
	const outcome = failure === null ? 'drawn by the installed tools instead'
		: /\bENOENT\b/.test(failure) ? 'and the installed tools are not available, so it is not drawn (see the error box)'
		: 'and the installed tools could not draw it either (see the error box)';
	addWarning(`Figure engine: ${why} — ${outcome}`);
}

const hash = (kind, text) => crypto.createHash('md5').update(`${fingerprint()}|${kind}|${text}`).digest('hex');

// A TiKZ figure: one SVG, `<hash>.svg` in its cache folder.
async function fillTikz(job) {
	const host = await hostFontsFor(job.doc);
	const name = hash('tikz', job.doc + (host?.stamp ?? ''));
	const out = path.join(job.dir, `${name}.svg`);
	if (fs.existsSync(out)) return job.use(path.join(job.dir, `${name}.tex`));
	const engine = await instance();
	if (!engine) return job.external();
	await giveFonts(engine, job.doc, host);
	const optimise = configManager.get('TiKZ optimise');
	const r = await call(() => engine.latex(job.doc, {
		engine: 'lualatex', bbox: 'min',
		dvisvgmArgs: ['--no-fonts=1', ...(optimise ? [`--optimize=${optimise}`] : [])],
	}));
	const log = unwrapTexLog(r.texLog);
	if (setting() === 'auto' && FONT_MISS.test(log)) {
		return toTools(job, 'a TiKZ figure names a font mp-tikz-wasm could not resolve');
	}
	const missing = MISSING_FILE.exec(log);
	if (setting() === 'auto' && missing) {
		return toTools(job, `a TiKZ figure needs \`${missing[1]}\`, which mp-tikz-wasm does not have`);
	}
	const made = r.pages?.length && r.status !== 'error' && r.status !== 'fatal';
	// Under `wasm` nothing falls back, and a face the library cannot resolve
	// used to pass in silence: the figure's bold and italic came out regular.
	if (setting() === 'wasm' && FONT_MISS.test(log)) {
		const faces = [...new Set([...log.matchAll(/Could not resolve font "([^"]+)"/g)].map((m) => m[1]))];
		const named = faces.length ? ` (${faces.join(', ')})` : '';
		addWarning(`Figure engine: a TiKZ figure names a font mp-tikz-wasm could not resolve${named} — ${made ? 'drawn without it' : 'not drawn (see the error box)'}`);
	}
	if (!made) {
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
			warnOnce(`Figure engine: mp-tikz-wasm failed (${String(error?.message ?? error).split('\n')[0]}) — ${fallback()}`);
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
