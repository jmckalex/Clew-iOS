// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The jmarkdown render service: turns vault notes into full HTML documents
// for reading mode / previews.
//
// The engine must never run in Clew's own process (a build mutates the marked
// singleton, `global`, String.prototype, and the import cache, and some error
// paths call process.exit). So this service adopts jmarkdown's own watch-mode
// architecture: fork the engine's one-shot warm worker (watch-worker.js,
// reused verbatim), keep exactly one pre-warmed standby, consume it per build
// while the replacement warms, and drop stale results via a generation guard.
import { fork } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CH } from '../shared/channels.js';
import { paths } from './paths.js';
import { readNoteFonts } from './note-fonts.js';
import { settings } from './settings.js';
import { engineExtensionEntries } from './plugins.js';
import { inlineScriptHashes } from './preview-csp.js';
import { writeFileAtomic } from './fs-utils.js';
import { isDependentFragment } from '../shared/fragment-deps.js';
import { citationHeader, bookCitationHeader, noteBibFiles } from './citation-header.js';
import { refusedNames } from '../shared/refused-names.js';
import { calloutsEnv } from './callout-types.js';
import { iconTable } from './callout-files.js';

const WORKER_PATH = paths.engineWorker;

const REBUILD_DEBOUNCE_MS = 300;

// TikZ/MetaPost/mermaid-cli shell out to latex/dvisvgm/mpost by name; a
// dock-launched app's PATH lacks the usual tool locations, so append them.
// (Windows installers put TeX on PATH themselves; the delimiter there is
// ';' and the Unix directories don't apply.)
export function toolchainPath() {
	const extras = process.platform === 'win32'
		? []
		: ['/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin'];
	const current = (process.env.PATH ?? '').split(path.delimiter);
	return [...current, ...extras.filter((dir) => !current.includes(dir))].join(path.delimiter);
}

/**
 * `fork`, with the one failure that needs explaining translated. The render
 * worker is a fork, and a fork needs descriptors: past ~10,240 held by the
 * process libuv refuses with EBADF (and with EMFILE at the true ceiling).
 * The cause is almost always the vault watcher on a vault full of library
 * files — vault.js keeps a budget to prevent it, so reaching this means
 * something ELSE is holding descriptors, and "spawn EBADF" in a preview
 * tells the reader nothing at all.
 */
function spawnWorker(workerPath, options) {
	try {
		return fork(workerPath, [], options);
	} catch (err) {
		if (err?.code === 'EBADF' || err?.code === 'EMFILE') {
			throw new Error('Clew could not start its render worker: too many files are open '
				+ `(${err.code}). This usually means a vault with a very large folder in it is `
				+ 'being watched. Close other vault windows, or move the folder out of the vault.');
		}
		throw err;
	}
}

export class RenderService {
	vaultRoot = null;
	engineDir = null;
	cacheDir = null;
	/** Owning session's id — media URLs in rendered HTML embed it. */
	sessionId = null;
	/** @type {(channel: string, payload: any) => void} */
	send = () => {};

	#standby = null; // {child, ready: Promise<child>}
	#generation = 0;
	/** Per-vault rendering options (.clew/vault-settings.json). */
	#vaultOptions = {};
	/** May this vault's notes make the engine run code (the engine's `Run
	 *  note code`)? The DEVICE's answer (vault-trust.js), set by the session
	 *  before openVault — deliberately not one of #vaultOptions, which are
	 *  read from a file the vault carries. Closed until someone says. */
	#noteCode = false;
	/** What else the device lets this vault run (vault-trust.js#
	 *  effectiveAccess): the enabled plugins' engine surfaces, dataviewJs.
	 *  Never read from #vaultOptions — those keys are only the vault's
	 *  request now (frame-bridge.md §4.2). */
	#access = { trusted: false, plugins: [], dataviewJs: false };
	/** What the engine refused while #noteCode is off: path → names. */
	#refused = new Map();
	/** vault-relative note paths with an open preview (rendered eagerly on change) */
	#subscribed = new Map(); // path -> subscriber count
	/** Injected by the session (which owns both services): the notes that
	 *  transclude a given path. Standalone renders have no index — hence a
	 *  default that claims nothing rather than a hard dependency. */
	embeddersOf = () => [];
	/** per-path render bookkeeping: {mtimeMs, htmlFile, inflight: Promise|null, dirty} */
	#notes = new Map();
	#rebuildTimers = new Map();
	/** fragment cache: key → html string (canvas cards, live-edit blocks; bounded) */
	#fragments = new Map();
	#blockSources = new Map();   // block key → the note it was rendered for
	#books = new Map();          // master → its whole-book document (renderBook)
	#fragmentInflight = new Map();
	/** Bumped on every file change: a DEPENDENT fragment's key carries it, so
	 *  a cached render of `![[Note]]` is never served after Note changed. */
	#fragmentEpoch = 0;
	/** Bumped on every reconfigure: in EVERY fragment key, so a block whose
	 *  rendering changed with the config (normalSyntax, a TeX fragment, a
	 *  plugin) gets a NEW hash — a caller comparing hashes sees the change. */
	#configGeneration = 0;

	/** dist/ directory (engine assets: wikilinks.js, clew-template.html). */
	constructor(distDir) {
		this.distDir = distDir;
	}

	openVault(vaultRoot) {
		this.closeVault();
		this.vaultRoot = vaultRoot;
		this.engineDir = path.join(vaultRoot, '.clew', 'engine');
		this.cacheDir = path.join(vaultRoot, '.clew', 'cache', 'html');
		fs.mkdirSync(path.join(this.engineDir, '.jmarkdown'), { recursive: true });
		fs.mkdirSync(this.cacheDir, { recursive: true });
		try {
			this.#vaultOptions = JSON.parse(
				fs.readFileSync(path.join(vaultRoot, '.clew', 'vault-settings.json'), 'utf8'));
		} catch {
			this.#vaultOptions = {};
		}
		this.#writeEngineConfig();
		this.#spawnStandby();
	}

	/**
	 * Trust changed (the banner, Settings) or a vault is about to open:
	 * whether the engine may run its notes' code. An open vault is
	 * reconfigured, which re-renders every open preview under the new answer.
	 */
	setNoteCode(allowed) {
		this.setAccess({ ...this.#access, trusted: allowed === true });
	}

	/**
	 * The session's effective access changed (trust, an enablement) or a
	 * vault is about to open. Note code follows trust; the engine config
	 * carries the enabled plugins' engine surfaces and the worker's
	 * dataviewJs switch — so a change reconfigures, which re-renders every
	 * open preview under the new answer.
	 */
	setAccess(access) {
		const next = {
			trusted: access?.trusted === true,
			plugins: Array.isArray(access?.plugins) ? [...access.plugins] : [],
			dataviewJs: access?.dataviewJs === true,
		};
		if (JSON.stringify(next) === JSON.stringify(this.#access)) return;
		const trustChanged = next.trusted !== this.#noteCode;
		this.#access = next;
		this.#noteCode = next.trusted;
		if (trustChanged) this.#refused.clear();
		if (this.vaultRoot) this.reconfigure({});
	}

	/** One of the vault's render options as this service holds it. */
	vaultOption(key) {
		return this.#vaultOptions[key];
	}

	/** Every construct refused so far, by name — for a window that reloads. */
	refusedNames() {
		return [...new Set([...this.#refused.values()].flat())];
	}

	// A restricted vault's render: note what the engine refused, by the
	// names on its `data-jmd-refused` markers (jmarkdown note-code.js), and
	// tell the window — whose banner offers trust only once there is
	// something to trust.
	#noteRefusals(key, html, path = key) {
		if (this.#noteCode) return;
		const names = refusedNames(html);
		if (names.length === 0) {
			this.#refused.delete(key);
			return;
		}
		this.#refused.set(key, names);
		this.send(CH.EV_NOTE_CODE_REFUSED, { path, names });
	}

	/**
	 * Vault-level render options changed (e.g. the jmarkdown-project toggle):
	 * rewrite the engine config, discard the standby worker (it imported the
	 * old config), forget cached renders, and re-render open previews.
	 */
	reconfigure(options) {
		Object.assign(this.#vaultOptions, options);
		if (!this.vaultRoot) return;
		this.#writeEngineConfig();
		this.#standby?.child.kill();
		this.#spawnStandby();
		this.#notes.clear();
		this.#books.clear();
		this.#fragments.clear();
		this.#fragmentEpoch++;
		this.#configGeneration++;
		for (const relPath of this.#subscribed.keys()) {
			this.render(relPath).catch(() => {});
		}
	}

	closeVault() {
		this.#standby?.child.kill();
		this.#standby = null;
		this.vaultRoot = null;
		this.#subscribed.clear();
		this.#notes.clear();
		this.#books.clear();
		this.#fragments.clear();
		this.#fragmentInflight.clear();
		this.#refused.clear();
		for (const timer of this.#rebuildTimers.values()) clearTimeout(timer);
		this.#rebuildTimers.clear();
		this.#generation++;
	}

	// The engine reads ./.jmarkdown/config.json relative to the worker's cwd at
	// import time — which is why the worker's cwd is <vault>/.clew/engine/, a
	// Clew-owned directory (vault roots stay clean; a vault-level .jmarkdown/
	// config for CLI use is untouched and simply not consulted here).
	#writeEngineConfig() {
		const engineAssets = paths.engineAssets;
		const config = {
			// "jmarkdown project" vaults (the book manuscript case) re-enable
			// the engine's own-line [[file.md]] inclusion in previews.
			'File inclusion': this.#vaultOptions.jmarkdownProject === true,
			// Pandoc-style [@key] / @key citations. Off unless the vault asks:
			// @ is the engine's directive sigil, so with this on a bare @word
			// that is not a registered directive becomes a citation key. The
			// engine exposes it as a config key precisely for a host like Clew,
			// rendering notes that carry no metadata header of their own.
			'Pandoc citations': this.#vaultOptions.pandocCitations === true,
			'Header style': 'fenced',
			// Whether a note may make the engine run code: script blocks,
			// Math.…(…) and calc(…) in prose, math.…(, Mathematica, and the
			// Load …/Extension … header keys. Off, each is refused by name in
			// place (jmarkdown note-code.js). The device's decision, never the
			// vault's (main/vault-trust.js) — the interim guard, which covers
			// these engine paths only; vault scripts, plugins, dataviewJs and
			// the Note API come with the full trust design.
			'Run note code': this.#noteCode,
			'Template': path.join(engineAssets, 'clew-template.html'),
			'Extensions': [
				`wikiembed, wikilink from ${path.join(engineAssets, 'wikilinks.js')}`,
				`mermaidFence, leafletFence from ${path.join(engineAssets, 'obsidian-fences.js')}`,
				// TikZ, MetaPost, LaTeX and plain TeX typeset by wasm in the
				// preview, so a figure needs no TeX installation: the ```tikz /
				// ```metapost / ```latex / ```tex fences and the :::TiKZ
				// directive. Listed here, i.e. loaded
				// after the engine's own rules, which is what lets the
				// directive win — see src/engine/figures.js.
				`tikzFence, metapostFence, latexFence, texFence, tikzDirective from ${path.join(engineAssets, 'figures.js')}`,
				`queryFence, tasksFence, kanbanFence from ${path.join(engineAssets, 'query-fences.js')}`,
				// (```tabbing and @begin(tabbing) are the ENGINE's since jmarkdown
				// 4ab3d6a — registered there after callouts; preview-client/
				// tabbing.js lays them out with the engine's own layoutTabbing.)
				`tableBeforeAnchor, blockAnchorLine, blockAnchor from ${path.join(engineAssets, 'block-refs.js')}`,
				// Obsidian's Dataview, for vaults that arrive carrying it.
				`dataviewFence, dataviewJsFence, dataviewInline from ${path.join(engineAssets, 'dataview.js')}`,
				// Obsidian Bases. The `![[X.base]]` embed path lives in
				// wikilinks.js; this registers the inline ```base fence.
				`baseFence from ${path.join(engineAssets, 'bases.js')}`,
				// The Admonition plugin's ```ad-* fences (pre-callout vaults),
				// mapped onto callout tokens so the engine's callouts render them.
				`admonitionFence from ${path.join(engineAssets, 'admonitions.js')}`,
				// Meta Bind's INPUT[…]/VIEW[…] widgets — editable cells that
				// live in prose, on the same field-edit write path.
				`metaBindInline, metaBindFence from ${path.join(engineAssets, 'meta-bind.js')}`,
				// (Callouts are the ENGINE's since jmarkdown a7de8c6 — callouts.js,
				// registered after its own GFM-alert rule; Clew hands it the custom
				// types through CLEW_CALLOUTS.)
				// After callouts (so it is offered first): a note whose
				// frontmatter declares `kanban-plugin` IS a board, and this
				// claims the whole body before any other rule can render it
				// as prose. Inert for every other note.
				`kanbanBoard from ${path.join(engineAssets, 'kanban-board.js')}`,
				// Enabled vault plugins' engine surfaces (custom syntax).
				...engineExtensionEntries(this.vaultRoot, this.#access, paths.globalPlugins),
			],
			// @begin(TiKZ) / @begin(metapost) are block ENVIRONMENTS, not
			// marked extensions: the engine keys them by name in a registry,
			// and this line is loaded after its own registrations, so these
			// handlers replace the ones that shell out to a local TeX. Only
			// ever in an HTML build — a LaTeX export runs with the user's own
			// config, where the native handlers still stand (export.js).
			'Environments': [
				`TiKZ, metapost from ${path.join(engineAssets, 'figures.js')}`,
				// @reveal[…] — a presentation in an iframe. One registry entry
				// serves the inline, block and @begin forms (reveal-embed.js).
				`reveal from ${path.join(engineAssets, 'reveal-embed.js')}`,
				// @app[…] — an app in a note (app-embed.js marks the place;
				// main resolves it as the document is served).
				`app from ${path.join(engineAssets, 'app-embed.js')}`,
			],
			...this.#biblifyConfig(),
			// dvisvgm needs ghostscript to convert MetaPost EPS output (and
			// PS specials in TikZ). Homebrew's stable opt symlink survives
			// upgrades; the engine's own default is only a fallback.
			...(() => {
				const libgs = ['/opt/homebrew/opt/ghostscript/lib/libgs.dylib',
					'/usr/local/opt/ghostscript/lib/libgs.dylib'].find((p) => fs.existsSync(p));
				return libgs ? { 'TiKZ libgs': libgs } : {};
			})(),
			'MathJax': { 'src': '/__clew_assets__/mathjax/tex-svg.js' },
			'Mermaid': '/__clew_assets__/mermaid/mermaid.min.js',
			'Fontawesome': '/__clew_assets__/fontawesome/all.min.js',
			'Highlight src': '/__clew_assets__/highlight/atom-one-dark.min.css',
		};
		writeFileAtomic(
			path.join(this.engineDir, '.jmarkdown', 'config.json'),
			JSON.stringify(config, null, 2),
		);
	}

	// Vault-wide bibliography (vault-settings `bibliography` +
	// `bibliographyStyle`): written into the generated config as absolute
	// paths, so every note resolves citations without per-note properties.
	// Per-note `Bibliography:` / `Bibliography style:` metadata still wins —
	// the engine processes metadata headers after the config file.
	#biblifyConfig() {
		const bib = String(this.#vaultOptions.bibliography ?? '').trim();
		if (!bib) return {};
		const abs = (p) => (path.isAbsolute(p) ? p : path.join(this.vaultRoot, p));
		const biblify = { 'bibliography': abs(bib), 'resolve': true };
		const style = String(this.#vaultOptions.bibliographyStyle ?? '').trim();
		if (style) {
			// The engine's named styles (three from @citation-js/plugin-csl,
			// five bundled as CSL files in its own csl/ directory); anything
			// else is a custom .csl file the engine registers by basename.
			const named = ['apa', 'chicago', 'harvard1', 'vancouver', 'bjps', 'ajp', 'econometrica', 'ergo'];
			if (named.includes(style)) {
				biblify['bibliography style'] = style;
			} else {
				const file = abs(style);
				const name = path.basename(file, '.csl');
				biblify['bibliography style'] = name;
				biblify['template'] = { name, file };
			}
		}
		return { 'Biblify': biblify };
	}

	/** Rendered HTML for a note (rendered on demand) — the References panel's feed. */
	async renderedHtml(relPath) {
		const htmlFile = await this.ensureRendered(relPath);
		return fs.readFileSync(htmlFile, 'utf8');
	}

	#spawnStandby() {
		if (!this.vaultRoot) return;
		const child = spawnWorker(WORKER_PATH, {
			cwd: this.engineDir,
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
			env: {
				...process.env,
				PATH: toolchainPath(),
				CLEW_VAULT_ROOT: this.vaultRoot,
				// Where the vault ends (engine/vault-bounds.js): a restricted
				// vault's links are not followed out of it by the extensions.
				CLEW_VAULT_RESTRICTED: this.#access.trusted ? '' : '1',
				CLEW_SESSION_ID: this.sessionId ?? '',
				// Per-vault opt-in for running ```dataviewjs — the DEVICE's
				// enablement, gated by trust; 'restricted' makes the block's
				// refusal say why (engine/dataview.js). Safe as spawn-time env
				// because reconfigure() discards the warm standby whenever the
				// vault's options or access change.
				CLEW_DATAVIEW_JS: this.#access.dataviewJs ? '1' : (this.#access.trusted ? '' : 'restricted'),
				// The note's typeface, face → file name, for the `font=note`
				// wrapper (engine/figures.js#noteFontPreamble). App-global
				// (main/note-fonts.js prepared it before any vault opened).
				CLEW_NOTE_FONTS: JSON.stringify(readNoteFonts(paths.noteFonts)?.faces ?? {}),
				// Named TeX fragments for `clew-fragments=` (engine/figures.js):
				// both scopes as they are stored, because engine/tex-fragments.js
				// owns the rule that a vault fragment shadows a global one — main
				// resolving it here would be a second copy of that rule. Editing
				// either list reconfigures, which is what re-typesets the figures
				// using it (their source changes, so their fig-key does).
				CLEW_TEX_FRAGMENTS: JSON.stringify({
					global: settings.get('texFragments') ?? [],
					vault: this.#vaultOptions.texFragments ?? [],
				}),
				// Custom callout types, both scopes RESOLVED (callout-types.js):
				// names, titles, colours and only the icon paths they use. Empty
				// when none are defined — and then the icon table is never read.
				CLEW_CALLOUTS: calloutsEnv(settings.get('callouts'), this.#vaultOptions.callouts, () => iconTable(paths.faIcons)),
				// Engine console chatter goes to the pipes; keep them from filling.
			},
		});
		child.stdout.on('data', () => {});
		child.stderr.on('data', (chunk) => {
			if (process.env.CLEW_DEV) process.stderr.write(`[render-worker] ${chunk}`);
		});
		const ready = new Promise((resolve, reject) => {
			const onMessage = (msg) => {
				if (msg?.type === 'ready') {
					child.off('message', onMessage);
					resolve(child);
				}
			};
			child.on('message', onMessage);
			child.once('exit', () => reject(new Error('render worker died during warm-up')));
			child.once('error', reject);
		});
		ready.catch(() => {});
		this.#standby = { child, ready };
	}

	#takeStandby() {
		const standby = this.#standby;
		this.#spawnStandby(); // replacement warms while the taken worker builds
		return standby;
	}

	htmlPathFor(relPath) {
		const hash = crypto.createHash('sha1').update(relPath).digest('hex').slice(0, 16);
		return path.join(this.cacheDir, `${hash}.html`);
	}

	/** Render if the cached HTML is missing or stale; resolves to the html file. */
	async ensureRendered(relPath) {
		const abs = path.join(this.vaultRoot, relPath);
		const mtimeMs = fs.statSync(abs).mtimeMs;
		const entry = this.#notes.get(relPath);
		if (entry?.inflight) return entry.inflight;
		if (entry && entry.mtimeMs >= mtimeMs && fs.existsSync(entry.htmlFile)) {
			return entry.htmlFile;
		}
		return this.render(relPath);
	}

	/** Unconditional render (coalesced: concurrent calls share one build). */
	async render(relPath) {
		let entry = this.#notes.get(relPath);
		if (entry?.inflight) {
			entry.dirty = true; // re-render once the current build lands
			return entry.inflight;
		}
		if (!entry) {
			entry = { mtimeMs: 0, htmlFile: this.htmlPathFor(relPath), inflight: null, dirty: false };
			this.#notes.set(relPath, entry);
		}
		entry.inflight = this.#build(relPath, entry).finally(() => {
			entry.inflight = null;
			if (entry.dirty) {
				entry.dirty = false;
				this.render(relPath).catch(() => {});
			}
		});
		return entry.inflight;
	}

	/** One build on a warm worker: the worker's `done` or `error` message. */
	async #workerBuild(file, options) {
		const standby = this.#takeStandby();
		const child = await standby.ready;
		return new Promise((resolve) => {
			const onMessage = (msg) => {
				if (msg?.type === 'done' || msg?.type === 'error') resolve(msg);
			};
			child.on('message', onMessage);
			child.once('exit', (code) => {
				resolve({ type: 'error', message: `render worker exited (code ${code}) without a result` });
			});
			child.send({ type: 'build', file, options });
		});
	}

	async #build(relPath, entry) {
		const generation = this.#generation;
		const abs = path.join(this.vaultRoot, relPath);
		const mtimeMs = fs.statSync(abs).mtimeMs;
		const result = await this.#workerBuild(abs, {
			to: 'html',
			output: entry.htmlFile,
			// Standard-Markdown vaults: the engine keeps its extensions but
			// reverts *em*/**strong** etc. to normal marked semantics.
			normalSyntax: this.#vaultOptions.normalSyntax === true,
		});

		if (generation !== this.#generation) throw new Error('stale render (vault closed)');

		if (result.type === 'done') {
			entry.mtimeMs = mtimeMs;
			// Notes holding query fences re-render on ANY vault change; notes
			// citing a .bib re-render when THAT .bib changes (onFileChanged).
			try {
				const text = fs.readFileSync(abs, 'utf8');
				entry.hasQueries = /^```(query|tasks|kanban)/m.test(text);
				entry.bibs = new Set(noteBibFiles(text, path.dirname(abs), this.#vaultBibliography(),
					{ pandoc: this.#vaultOptions.pandocCitations === true }).map((p) => path.resolve(p)));
			} catch { entry.hasQueries = false; entry.bibs = null; }
			if (!this.#noteCode) {
				try { this.#noteRefusals(relPath, fs.readFileSync(entry.htmlFile, 'utf8')); } catch { /* unreadable: nothing to say */ }
			}
			// The build's warnings (incl. the LaTeX-export lint, jmarkdown
			// 0631c42), for the status bar (renderer/build-warnings.js).
			this.send(CH.EV_RENDER_DONE, { path: relPath, warnings: Array.isArray(result.warnings) ? result.warnings : [] });
			return entry.htmlFile;
		}
		this.send(CH.EV_RENDER_ERROR, { path: relPath, message: result.message, stack: result.stack });
		throw new Error(result.message);
	}

	/**
	 * A whole BOOK as ONE preview document (book-mode.md, phase 3's print
	 * PDF): the master with its chapters handed to the engine
	 * (processFile's `chapters`, relative to the master, and `numbering`, as
	 * export-book.js hands them over), under the PREVIEW configuration, so it is what
	 * reading view would draw, numbered as the book is. Kept beside the note
	 * renders under its own name — the master's own render is untouched — and
	 * served at the master's URL with `?book=1` (protocol.js), which is where
	 * the engine's master-relative paths resolve.
	 *
	 * @returns {Promise<{ htmlFile: string, warnings: Array }>}
	 */
	async renderBook(masterRel, { chapters, numbering }) {
		const generation = this.#generation;
		const hash = crypto.createHash('sha1').update(`book\u0000${masterRel}`).digest('hex').slice(0, 16);
		const htmlFile = path.join(this.cacheDir, `book-${hash}.html`);
		const result = await this.#workerBuild(path.join(this.vaultRoot, masterRel), {
			to: 'html',
			output: htmlFile,
			normalSyntax: this.#vaultOptions.normalSyntax === true,
			chapters,
			numbering,
		});
		if (generation !== this.#generation) throw new Error('stale render (vault closed)');
		if (result.type !== 'done') throw new Error(result.message);
		this.#books.set(masterRel, htmlFile);
		return { htmlFile, warnings: Array.isArray(result.warnings) ? result.warnings : [] };
	}

	/** The last whole-book document built for `masterRel`, or null. */
	bookHtmlFile(masterRel) {
		const file = this.#books.get(masterRel);
		return file && fs.existsSync(file) ? file : null;
	}

	/**
	 * Render a markdown snippet (a canvas card) through the engine in
	 * fragment mode: body HTML only, no template. Same worker pipeline and
	 * engine config as note renders (wikilinks, fences, normalSyntax), so a
	 * card renders exactly like the same text would in a note. Cached by
	 * content hash — a canvas reopening re-renders nothing — unless the text
	 * reads other files (fragment-deps.js), whose key then carries the file
	 * epoch so any file change retires it.
	 *
	 * `sourcePath` (vault-relative) is the note the snippet belongs to. It is
	 * part of the key and is left beside the temp file as `<key>.source`,
	 * which engine/vault-model.js#currentFilePath reads — so Dataview `this`,
	 * Bases' `this.file`, Meta Bind and a kanban board see the note.
	 *
	 * @param {string} text
	 * @param {{ sourcePath?: string|null, dependent?: boolean }} [options]
	 * @returns {Promise<string>} the body HTML
	 */
	renderFragment(text, options = {}) {
		return this.#cachedBuild(text, { ...options, document: false });
	}

	/**
	 * Render a snippet as a FULL preview document — the engine's own
	 * template, exactly as a note gets it (MathJax config, mermaid, CSS) —
	 * for live edit's block frames. protocol.js serves it at
	 * `__clew_block__/<key>` with the preview client injected. Resolves to
	 * the key; `blockDocument(key)` returns the HTML while it is cached.
	 *
	 * @param {string} text
	 * @param {{ sourcePath?: string|null, book?: string[]|null, dependent?: boolean }} [options]
	 *   `book`: the master then its chapters (vault paths) — the snippet's
	 *   citations render under the BOOK's header, not the note's
	 * @returns {Promise<string>} the block's key
	 */
	async renderBlock(text, options = {}) {
		// The note's citation keys go in front (citation-header.js): a block
		// renders on its own, and a `\cite` in it stayed raw while reading
		// mode resolved it. They come from the note's file, so such a block is
		// dependent — a saved header change reaches it. A chapter's citations
		// (live edit's pills, cite-text.js) render under its book's.
		const { book, ...rest } = options;
		const header = book?.length ? this.#bookCitationHeaderOf(book)
			: options.sourcePath ? this.#citationHeaderOf(options.sourcePath) : '';
		const full = header + text;
		const opts = { ...rest, ...(header ? { dependent: true } : {}), document: true };
		const key = this.#fragmentKey(full, opts);
		await this.#cachedBuild(full, opts);
		// Its note, for what the document itself cannot say: a block is served
		// from __clew_block__/, not the note's folder, so a relative path in it
		// (a note's own <iframe src="paper.pdf">) resolves against the note.
		if (options.sourcePath) this.#blockSources.set(key, options.sourcePath);
		if (this.#blockSources.size > 1000) this.#blockSources.delete(this.#blockSources.keys().next().value);
		return key;
	}

	/** The note a block document was rendered for, or null. */
	blockSourcePath(key) {
		return this.#blockSources.get(key) ?? null;
	}

	/** The source note's citation header, or '' (no note, no header, unreadable). */
	#citationHeaderOf(sourcePath) {
		try {
			const abs = path.join(this.vaultRoot, sourcePath);
			return citationHeader(fs.readFileSync(abs, 'utf8'), path.dirname(abs));
		} catch {
			return '';
		}
	}

	/** A book's citation header (citation-header.js#bookCitationHeader), or ''. */
	#bookCitationHeaderOf([master, ...chapters]) {
		const piece = (rel) => {
			const abs = path.join(this.vaultRoot, rel);
			try { return { text: fs.readFileSync(abs, 'utf8'), dir: path.dirname(abs) }; } catch { return { text: '', dir: path.dirname(abs) }; }
		};
		return bookCitationHeader(piece(master), chapters.map(piece));
	}

	/** A built block document by key, or undefined once evicted. */
	blockDocument(key) {
		return this.#fragments.get(key);
	}

	#templateHashes = null; // { generation, promise }

	/**
	 * The CSP hash sources of the inline scripts Clew's own template emits
	 * for a note with NO code (today: the MathJax configuration) — what a
	 * restricted vault's documents may run inline (preview-csp.js). Read off
	 * a real render of an empty document, once per configuration, so it is
	 * whatever the engine and this config produce, never a copy that could
	 * drift; anything a note adds (its own <script>, an HTML header) hashes
	 * differently and is refused.
	 */
	templateScriptHashes() {
		if (this.#templateHashes?.generation === this.#configGeneration) return this.#templateHashes.promise;
		const generation = this.#configGeneration;
		const promise = this.#cachedBuild('', { document: true, dependent: false })
			.then((html) => inlineScriptHashes(html))
			.catch(() => {
				if (this.#templateHashes?.promise === promise) this.#templateHashes = null;
				return [];
			});
		this.#templateHashes = { generation, promise };
		return promise;
	}

	#fragmentKey(text, { sourcePath = null, dependent = isDependentFragment(text), document = false }) {
		return crypto.createHash('sha1')
			.update(`${document ? 'doc' : 'frag'}\0${this.#configGeneration}\0${sourcePath ?? ''}\0${dependent ? this.#fragmentEpoch : ''}\0${text}`)
			.digest('hex').slice(0, 20);
	}

	#cachedBuild(text, options) {
		if (!this.vaultRoot) return Promise.reject(new Error('no vault open'));
		const key = this.#fragmentKey(text, options);
		const cached = this.#fragments.get(key);
		if (cached !== undefined) return Promise.resolve(cached);
		const inflight = this.#fragmentInflight.get(key);
		if (inflight) return inflight;

		const job = this.#buildFragment(key, text, options).finally(() => {
			this.#fragmentInflight.delete(key);
		});
		this.#fragmentInflight.set(key, job);
		return job;
	}

	async #buildFragment(key, text, { sourcePath = null, document = false } = {}) {
		const generation = this.#generation;
		const dir = path.join(this.vaultRoot, '.clew', 'cache', 'fragments');
		fs.mkdirSync(dir, { recursive: true });
		const mdFile = path.join(dir, `${key}.md`);
		const htmlFile = path.join(dir, `${key}.html`);
		const sourceFile = path.join(dir, `${key}.source`);
		fs.writeFileSync(mdFile, text);
		// Which note the snippet belongs to: engine/vault-model.js#currentFilePath
		// reads this, so Dataview `this` & co. see the note, not the temp file.
		if (sourcePath) fs.writeFileSync(sourceFile, sourcePath);

		const standby = this.#takeStandby();
		const child = await standby.ready;
		const result = await new Promise((resolve) => {
			child.on('message', (msg) => {
				if (msg?.type === 'done' || msg?.type === 'error') resolve(msg);
			});
			child.once('exit', (code) => {
				resolve({ type: 'error', message: `render worker exited (code ${code}) without a result` });
			});
			child.send({
				type: 'build',
				file: mdFile,
				options: {
					to: 'html',
					output: htmlFile,
					fragment: !document,
					normalSyntax: this.#vaultOptions.normalSyntax === true,
				},
			});
		});
		if (generation !== this.#generation) throw new Error('stale fragment (vault closed)');
		if (result.type !== 'done') throw new Error(result.message);

		const html = fs.readFileSync(htmlFile, 'utf8');
		// Keyed by the fragment, not its note: a clean block must not erase
		// what the note itself had refused.
		this.#noteRefusals(`fragment:${key}`, html, sourcePath ?? `fragment:${key}`);
		fs.rmSync(mdFile, { force: true });
		fs.rmSync(htmlFile, { force: true });
		fs.rmSync(sourceFile, { force: true });
		// Bounded cache: drop the oldest half when it grows past 500 entries.
		if (this.#fragments.size > 500) {
			const keys = [...this.#fragments.keys()].slice(0, 250);
			for (const k of keys) this.#fragments.delete(k);
		}
		this.#fragments.set(key, html);
		return html;
	}

	// ---- subscriptions (open previews re-render on file change) -----------

	subscribe(relPath) {
		this.#subscribed.set(relPath, (this.#subscribed.get(relPath) ?? 0) + 1);
	}

	unsubscribe(relPath) {
		const count = (this.#subscribed.get(relPath) ?? 1) - 1;
		if (count <= 0) this.#subscribed.delete(relPath);
		else this.#subscribed.set(relPath, count);
	}

	/** Called by the vault watcher on every content change. */
	onFileChanged(relPath) {
		this.#fragmentEpoch++;
		if (this.#subscribed.has(relPath)) {
			clearTimeout(this.#rebuildTimers.get(relPath));
			this.#rebuildTimers.set(relPath, setTimeout(() => {
				this.#rebuildTimers.delete(relPath);
				this.render(relPath).catch(() => {}); // errors already broadcast
			}, REBUILD_DEBOUNCE_MS));
		}
		// Embeds are transclusions: `![[Child]]` puts Child's CONTENT inside
		// the parent's HTML, so a change to Child leaves every note embedding
		// it stale on screen — showing prose its own file no longer has. The
		// index knows who embeds whom (transitively; embeds nest).
		for (const embedder of this.embeddersOf(relPath)) {
			this.#restale(embedder);
		}
		// Live queries: notes holding ```query/tasks/kanban fences depend on
		// the WHOLE vault, not just their own file — so any note change makes
		// their cached renders stale. Invalidate every known query note (the
		// next ensureRendered re-renders even though the note's own mtime is
		// unchanged), and push re-renders to the ones with open previews.
		if (/\.(md|jmd)$/i.test(relPath)) {
			for (const [queryPath, entry] of this.#notes) {
				if (queryPath === relPath || !entry.hasQueries) continue;
				this.#restale(queryPath);
			}
		}
		// A bibliography: the notes whose citations come from it (their
		// header's `Bibliography`, else the vault's) — rebuilt where a preview
		// is open, marked stale elsewhere. Reading mode kept the old entry
		// until the note itself changed (2026-10-01).
		if (/\.bib$/i.test(relPath) && this.vaultRoot) {
			const bib = path.resolve(this.vaultRoot, relPath);
			for (const [notePath, entry] of this.#notes) {
				if (entry.bibs?.has(bib)) this.#restale(notePath);
			}
		}
	}

	/** The vault-wide bibliography (vault-settings `bibliography`), absolute, or ''. */
	#vaultBibliography() {
		const bib = String(this.#vaultOptions.bibliography ?? '').trim();
		if (!bib || !this.vaultRoot) return '';
		return path.isAbsolute(bib) ? bib : path.join(this.vaultRoot, bib);
	}

	/**
	 * Mark another note's cached render stale and, if a preview is watching,
	 * rebuild it. The note's own mtime has not moved — what changed is
	 * something it renders from — so `mtimeMs = 0` is what makes the next
	 * ensureRendered do the work rather than serve the cache.
	 */
	#restale(relPath) {
		const entry = this.#notes.get(relPath);
		if (entry) entry.mtimeMs = 0;
		if (!this.#subscribed.has(relPath)) return;
		clearTimeout(this.#rebuildTimers.get(relPath));
		this.#rebuildTimers.set(relPath, setTimeout(() => {
			this.#rebuildTimers.delete(relPath);
			this.render(relPath).catch(() => {});
		}, REBUILD_DEBOUNCE_MS * 2));
	}
}
