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
import { engineExtensionEntries, previewPluginPaths } from './plugins.js';
import { writeFileAtomic } from './fs-utils.js';

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
	/** vault-relative note paths with an open preview (rendered eagerly on change) */
	#subscribed = new Map(); // path -> subscriber count
	/** per-path render bookkeeping: {mtimeMs, htmlFile, inflight: Promise|null, dirty} */
	#notes = new Map();
	#rebuildTimers = new Map();
	/** fragment cache: hash(text) → html string (canvas cards; bounded) */
	#fragments = new Map();
	#fragmentInflight = new Map();

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
		this.#fragments.clear();
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
		this.#fragments.clear();
		this.#fragmentInflight.clear();
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
			'Template': path.join(engineAssets, 'clew-template.html'),
			'Extensions': [
				`wikiembed, wikilink from ${path.join(engineAssets, 'wikilinks.js')}`,
				`mermaidFence, leafletFence from ${path.join(engineAssets, 'obsidian-fences.js')}`,
				`queryFence, tasksFence, kanbanFence from ${path.join(engineAssets, 'query-fences.js')}`,
				`tableBeforeAnchor, blockAnchorLine, blockAnchor from ${path.join(engineAssets, 'block-refs.js')}`,
				// Obsidian's Dataview, for vaults that arrive carrying it.
				`dataviewFence, dataviewJsFence, dataviewInline from ${path.join(engineAssets, 'dataview.js')}`,
				// Obsidian Bases. The `![[X.base]]` embed path lives in
				// wikilinks.js; this registers the inline ```base fence.
				`baseFence from ${path.join(engineAssets, 'bases.js')}`,
				// The Admonition plugin's ```ad-* fences (pre-callout vaults),
				// mapped onto callout tokens so callouts.js renders them.
				`admonitionFence from ${path.join(engineAssets, 'admonitions.js')}`,
				// Meta Bind's INPUT[…]/VIEW[…] widgets — editable cells that
				// live in prose, on the same field-edit write path.
				`metaBindInline, metaBindFence from ${path.join(engineAssets, 'meta-bind.js')}`,
				// LAST on purpose: marked offers the most recently registered
				// block extension first, and callouts must be seen before the
				// engine's own GFM-alert rule so that every `> [!type]` in a
				// document — the five GFM ones included — renders identically.
				`calloutBlock from ${path.join(engineAssets, 'callouts.js')}`,
				// After callouts (so it is offered first): a note whose
				// frontmatter declares `kanban-plugin` IS a board, and this
				// claims the whole body before any other rule can render it
				// as prose. Inert for every other note.
				`kanbanBoard from ${path.join(engineAssets, 'kanban-board.js')}`,
				// Enabled vault plugins' engine surfaces (custom syntax).
				...engineExtensionEntries(this.vaultRoot, this.#vaultOptions),
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
		const child = fork(WORKER_PATH, [], {
			cwd: this.engineDir,
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
			env: {
				...process.env,
				PATH: toolchainPath(),
				CLEW_VAULT_ROOT: this.vaultRoot,
				CLEW_SESSION_ID: this.sessionId ?? '',
				// Per-vault opt-in for running ```dataviewjs. Safe as spawn-time
				// env because reconfigure() discards the warm standby whenever
				// vault options change.
				CLEW_DATAVIEW_JS: this.#vaultOptions.dataviewJs === true ? '1' : '',
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

	async #build(relPath, entry) {
		const generation = this.#generation;
		const abs = path.join(this.vaultRoot, relPath);
		const mtimeMs = fs.statSync(abs).mtimeMs;
		const standby = this.#takeStandby();
		const child = await standby.ready;

		const result = await new Promise((resolve) => {
			const onMessage = (msg) => {
				if (msg?.type === 'done' || msg?.type === 'error') resolve(msg);
			};
			child.on('message', onMessage);
			child.once('exit', (code) => {
				resolve({ type: 'error', message: `render worker exited (code ${code}) without a result` });
			});
			child.send({
				type: 'build',
				file: abs,
				options: {
					to: 'html',
					output: entry.htmlFile,
					// Standard-Markdown vaults: the engine keeps its extensions but
					// reverts *em*/**strong** etc. to normal marked semantics.
					normalSyntax: this.#vaultOptions.normalSyntax === true,
				},
			});
		});

		if (generation !== this.#generation) throw new Error('stale render (vault closed)');

		if (result.type === 'done') {
			entry.mtimeMs = mtimeMs;
			// Notes holding query fences re-render on ANY vault change.
			try {
				entry.hasQueries = /^```(query|tasks|kanban)/m.test(fs.readFileSync(abs, 'utf8'));
			} catch { entry.hasQueries = false; }
			this.send(CH.EV_RENDER_DONE, { path: relPath });
			return entry.htmlFile;
		}
		this.send(CH.EV_RENDER_ERROR, { path: relPath, message: result.message, stack: result.stack });
		throw new Error(result.message);
	}

	/**
	 * Render a markdown snippet (a canvas card) through the engine in
	 * fragment mode: body HTML only, no template. Same worker pipeline and
	 * engine config as note renders (wikilinks, fences, normalSyntax), so a
	 * card renders exactly like the same text would in a note. Cached by
	 * content hash — a canvas reopening re-renders nothing.
	 */
	async renderFragment(text) {
		if (!this.vaultRoot) throw new Error('no vault open');
		const key = crypto.createHash('sha1').update(text).digest('hex').slice(0, 20);
		const cached = this.#fragments.get(key);
		if (cached !== undefined) return cached;
		const inflight = this.#fragmentInflight.get(key);
		if (inflight) return inflight;

		const job = this.#buildFragment(key, text).finally(() => {
			this.#fragmentInflight.delete(key);
		});
		this.#fragmentInflight.set(key, job);
		return job;
	}

	async #buildFragment(key, text) {
		const generation = this.#generation;
		const dir = path.join(this.vaultRoot, '.clew', 'cache', 'fragments');
		fs.mkdirSync(dir, { recursive: true });
		const mdFile = path.join(dir, `${key}.md`);
		const htmlFile = path.join(dir, `${key}.html`);
		fs.writeFileSync(mdFile, text);

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
					fragment: true,
					normalSyntax: this.#vaultOptions.normalSyntax === true,
				},
			});
		});
		if (generation !== this.#generation) throw new Error('stale fragment (vault closed)');
		if (result.type !== 'done') throw new Error(result.message);

		const html = fs.readFileSync(htmlFile, 'utf8');
		fs.rmSync(mdFile, { force: true });
		fs.rmSync(htmlFile, { force: true });
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
		if (this.#subscribed.has(relPath)) {
			clearTimeout(this.#rebuildTimers.get(relPath));
			this.#rebuildTimers.set(relPath, setTimeout(() => {
				this.#rebuildTimers.delete(relPath);
				this.render(relPath).catch(() => {}); // errors already broadcast
			}, REBUILD_DEBOUNCE_MS));
		}
		// Live queries: notes holding ```query/tasks/kanban fences depend on
		// the WHOLE vault, not just their own file — so any note change makes
		// their cached renders stale. Invalidate every known query note (the
		// next ensureRendered re-renders even though the note's own mtime is
		// unchanged), and push re-renders to the ones with open previews.
		if (/\.(md|jmd)$/i.test(relPath)) {
			for (const [queryPath, entry] of this.#notes) {
				if (queryPath === relPath || !entry.hasQueries) continue;
				entry.mtimeMs = 0; // stale: results may have changed
				if (!this.#subscribed.has(queryPath)) continue;
				clearTimeout(this.#rebuildTimers.get(queryPath));
				this.#rebuildTimers.set(queryPath, setTimeout(() => {
					this.#rebuildTimers.delete(queryPath);
					this.render(queryPath).catch(() => {});
				}, REBUILD_DEBOUNCE_MS * 2));
			}
		}
	}
}
