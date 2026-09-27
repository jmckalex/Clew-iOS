// The iOS render service: same public surface and discipline as
// vendor/clew/main/render-service.js, with the forked node worker swapped
// for the bundled engine Web Worker (dist/engine-worker.js) and the html
// cache kept in memory (the Swift scheme handler asks this service for
// rendered documents instead of reading .clew/cache files).
//
// One-shot workers, exactly like desktop: a standby is pre-warmed (init =
// vfs snapshot + engine import), consumed per build, terminated after its
// single result, while the replacement warms in the background.
import { vfs } from '../worker/shims/vfs.js';
import { VAULT_ROOT, GLOBAL_PLUGINS_ROOT } from './vault-manager.js';
import { engineConfig, engineEnv, isTextPath } from './engine-config.js';
import { engineExtensionEntries } from '../../vendor/clew/main/plugins.js';
import { isDependentFragment } from '../../vendor/clew/shared/fragment-deps.js';
import { settings } from './settings.js';

const REBUILD_DEBOUNCE_MS = 300;
const ENGINE_CWD = `${VAULT_ROOT}/.clew/engine`;

const sha1ish = (text) => {
	// Cache keys only. djb2-xor over the text, hex.
	let h1 = 5381, h2 = 52711;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		h1 = (h1 * 33) ^ c;
		h2 = (h2 * 31) ^ c;
	}
	return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
};

export class RenderService {
	sessionId = null;
	send = () => {};
	/** () => Worker — injectable for tests. */
	workerFactory;
	/** async (name) => text — loads template assets (fetch in the app). */
	assetLoader;

	#open = false;
	#openPromise = null; // resolves once assets are loaded and a standby spawned
	#standby = null; // { worker, ready: Promise<worker> }
	#generation = 0;
	#vaultOptions = {};
	#assets = null; // { '/engine/…': text }
	#subscribed = new Map(); // rel -> count
	/** Injected by the session (which owns both services): the notes that
	 *  transclude a given path. Standalone renders have no index — hence a
	 *  default that claims nothing rather than a hard dependency. Mirrors
	 *  desktop's render-service.js. */
	embeddersOf = () => [];
	/** Face → file map behind `font=note` figures, set by the session once the
	 *  bridge has built the faces (engine-config.js#engineEnv says how it is
	 *  used); null until then, which the engine treats as "no note fonts". */
	noteFonts = null;
	/** Resolves once `noteFonts` is known (or known to be unavailable): the
	 *  first standby waits for it, so the first render already carries the
	 *  map — a font=note figure in the first note opened would otherwise
	 *  typeset against files the engine was never told about. */
	noteFontsReady = Promise.resolve();
	#notes = new Map(); // rel -> {mtimeMs, html, hasQueries, inflight, dirty}
	/** fragment cache: key → html string (canvas cards, live-edit blocks; bounded) */
	#fragments = new Map();
	#fragmentInflight = new Map();
	/** Bumped on every file change: a DEPENDENT fragment's key carries it, so
	 *  a cached render of `![[Note]]` is never served after Note changed. */
	#fragmentEpoch = 0;
	/** Bumped on every reconfigure: in EVERY fragment key, so a block whose
	 *  rendering changed with the config (normalSyntax, a TeX fragment, a
	 *  plugin) gets a NEW hash — a caller comparing hashes sees the change. */
	#configGeneration = 0;
	#rebuildTimers = new Map();

	constructor({ workerFactory, assetLoader } = {}) {
		this.workerFactory = workerFactory
			?? (() => new Worker('/engine-worker.js', { type: 'module' }));
		this.assetLoader = assetLoader
			?? (async (name) => (await fetch(`/engine/${name}`)).text());
	}

	// Called synchronously from the vault-open hook; renders await
	// #openPromise so nothing races the asset fetch.
	openVault() {
		this.closeVault();
		this.#open = true;
		this.#vaultOptions = this.#loadVaultOptions();
		this.#openPromise = (async () => {
			if (!this.#assets) {
				const names = [
					'default-template.html.mustache', 'default-template.tex.mustache',
					'Biblify.js.mustache', 'jmarkdown.css', 'clew-template.html',
				];
				const texts = await Promise.all(names.map((n) => this.assetLoader(n)));
				this.#assets = Object.fromEntries(names.map((n, i) => [`/engine/${n}`, texts[i]]));
			}
			await this.noteFontsReady;
			this.#spawnStandby();
		})();
		this.#openPromise.catch((err) => console.error('[clew-ios] render service open failed:', err));
		return this.#openPromise;
	}

	reconfigure(options) {
		Object.assign(this.#vaultOptions, options);
		if (!this.#open) return;
		this.#standby?.worker.terminate();
		this.#standby = null;
		this.#spawnStandby();
		this.#notes.clear();
		this.#fragments.clear();
		this.#fragmentEpoch++;
		this.#configGeneration++;
		for (const rel of this.#subscribed.keys()) {
			this.render(rel).catch(() => {});
		}
	}

	closeVault() {
		this.#standby?.worker.terminate();
		this.#standby = null;
		this.#open = false;
		this.#subscribed.clear();
		this.#notes.clear();
		this.#fragments.clear();
		this.#fragmentInflight.clear();
		for (const timer of this.#rebuildTimers.values()) clearTimeout(timer);
		this.#rebuildTimers.clear();
		this.#generation++;
	}

	#loadVaultOptions() {
		try {
			const raw = vfs.read(`${VAULT_ROOT}/.clew/vault-settings.json`);
			return JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
		} catch {
			return {};
		}
	}

	// Mirrors desktop #writeEngineConfig — the body lives in engine-config.js
	// so the Node harness renders through the identical config. Enabled vault
	// plugins' engine surfaces are named by absolute vault path; the worker
	// loads them from its vfs snapshot (__jmdImportSource) — a Web Worker has
	// no disk to dynamic-import from.
	#engineConfig(engineExtensions) {
		return JSON.stringify(
			engineConfig({ vaultRoot: VAULT_ROOT, vaultOptions: this.#vaultOptions, engineExtensions }),
			null, 2);
	}

	/** Snapshot every vault text file (plus stubs so wikilink resolution can
	 *  see binaries) out of the mirror, for one worker's lifetime. */
	#snapshot() {
		const files = {};
		const prefix = VAULT_ROOT + '/';
		for (const [abs, entry] of vfs.files) {
			if (!abs.startsWith(prefix)) continue;
			const rel = abs.slice(prefix.length);
			if (rel.startsWith('.clew/')) continue;
			files[abs] = isTextPath(rel)
				? { data: typeof entry.data === 'string' ? entry.data : '', mtimeMs: entry.mtimeMs }
				: '';
		}
		// Enabled plugins' engine surfaces: the config names them by absolute
		// mirror path — the vault's .clew/plugins/<id>/ or the global root —
		// so the snapshot must carry exactly those files (the loop above
		// excludes .clew/ wholesale and never sees the global root — the
		// worker never needs the rest of either, e.g. the charts plugin's
		// ~200 KB chart.umd.js, which belongs to the PREVIEW surface).
		const engineExtensions = engineExtensionEntries(VAULT_ROOT, this.#vaultOptions, GLOBAL_PLUGINS_ROOT);
		for (const entry of engineExtensions) {
			const abs = entry.slice(entry.indexOf(' from ') + ' from '.length);
			const source = vfs.files.get(abs);
			if (source && typeof source.data === 'string') {
				files[abs] = { data: source.data, mtimeMs: source.mtimeMs };
			}
		}
		files[`${ENGINE_CWD}/.jmarkdown/config.json`] = this.#engineConfig(engineExtensions);
		Object.assign(files, this.#assets);
		return files;
	}

	#spawnStandby() {
		if (!this.#open) return;
		const worker = this.workerFactory();
		const ready = new Promise((resolve, reject) => {
			worker.onmessage = (event) => {
				if (event.data?.type === 'ready') resolve(worker);
				else if (event.data?.type === 'error') reject(new Error(event.data.message));
			};
			worker.onerror = (err) => reject(new Error(`render worker failed: ${err.message ?? err}`));
		});
		ready.catch(() => {});
		worker.postMessage({
			type: 'init',
			files: this.#snapshot(),
			cwd: ENGINE_CWD,
			env: engineEnv({
				noteFonts: this.noteFonts,
				vaultRoot: VAULT_ROOT,
				sessionId: this.sessionId,
				vaultOptions: this.#vaultOptions,
				// The device's global TeX fragments; a change to them
				// reconfigures (ipc.js SETTINGS_SET), so a standby never
				// outlives the list it was spawned with.
				globalTexFragments: settings.get('texFragments') ?? [],
			}),
		});
		this.#standby = { worker, ready };
	}

	#takeStandby() {
		const standby = this.#standby;
		this.#spawnStandby();
		return standby;
	}

	async #runBuild(file, options, extraFiles = null) {
		await this.#openPromise;
		const standby = this.#takeStandby();
		if (!standby) throw new Error('no vault open');
		const worker = await standby.ready;
		try {
			return await new Promise((resolve) => {
				worker.onmessage = (event) => {
					const msg = event.data;
					if (msg?.type === 'done' || msg?.type === 'error') resolve(msg);
				};
				worker.onerror = (err) => resolve({ type: 'error', message: String(err.message ?? err) });
				// The standby's init snapshot is only for engine warmup — it is
				// as old as the standby itself. Every build re-sends the CURRENT
				// vault (replaceVault drops entries deleted since spawn), so a
				// note edited after the standby spawned renders fresh, and
				// query fences scan up-to-date content.
				worker.postMessage({
					type: 'build',
					file,
					options,
					files: { ...this.#snapshot(), ...(extraFiles ?? {}) },
					replaceVault: true,
				});
			});
		} finally {
			worker.terminate(); // one-shot, like the desktop fork
		}
	}

	/** Rendered HTML for a note, cached until its mirror mtime moves. */
	async ensureRendered(rel) {
		const mtimeMs = vfs.stat(`${VAULT_ROOT}/${rel}`).mtimeMs;
		const entry = this.#notes.get(rel);
		if (entry?.inflight) return entry.inflight;
		if (entry && entry.mtimeMs >= mtimeMs && entry.html !== null) return entry.html;
		return this.render(rel);
	}

	async render(rel) {
		let entry = this.#notes.get(rel);
		if (entry?.inflight) {
			entry.dirty = true;
			return entry.inflight;
		}
		if (!entry) {
			entry = { mtimeMs: 0, html: null, hasQueries: false, inflight: null, dirty: false };
			this.#notes.set(rel, entry);
		}
		entry.inflight = this.#build(rel, entry).finally(() => {
			entry.inflight = null;
			if (entry.dirty) {
				entry.dirty = false;
				this.render(rel).catch(() => {});
			}
		});
		return entry.inflight;
	}

	async #build(rel, entry) {
		const generation = this.#generation;
		const abs = `${VAULT_ROOT}/${rel}`;
		const mtimeMs = vfs.stat(abs).mtimeMs;
		const result = await this.#runBuild(abs, {
			to: 'html',
			output: `${VAULT_ROOT}/.clew/cache/html/out.html`,
			normalSyntax: this.#vaultOptions.normalSyntax === true,
		});
		if (generation !== this.#generation) throw new Error('stale render (vault closed)');
		if (result.type === 'done') {
			entry.mtimeMs = mtimeMs;
			entry.html = result.html;
			try {
				const text = vfs.read(abs);
				entry.hasQueries = /^```(query|tasks|kanban)/m.test(
					typeof text === 'string' ? text : new TextDecoder().decode(text));
			} catch { entry.hasQueries = false; }
			this.send('clew:ev-render-done', { path: rel });
			return entry.html;
		}
		this.send('clew:ev-render-error', { path: rel, message: result.message, stack: result.stack });
		throw new Error(result.message);
	}

	/**
	 * Markdown snippet → body HTML (canvas cards). Fragment mode: body HTML
	 * only, no template. Same worker pipeline and engine config as note
	 * renders, so a card renders exactly like the same text would in a
	 * note. Cached by content hash — a canvas reopening re-renders nothing —
	 * unless the text reads other files (fragment-deps.js), whose key then
	 * carries the file epoch so any file change retires it.
	 *
	 * `sourcePath` (vault-relative) is the note the snippet belongs to. It is
	 * part of the key and rides into the worker's vfs as `<key>.source`
	 * beside the temp `<key>.md`, which engine/vault-model.js#currentFilePath
	 * reads — so Dataview `this`, Bases' `this.file`, Meta Bind and a kanban
	 * board see the note. Desktop's render-service.js, with the temp files
	 * handed to the worker as extra snapshot entries instead of written to
	 * disk (the worker has no disk).
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
	 * for live edit's block frames. SchemeHandler.swift serves it at
	 * `__clew_block__/<key>` with the preview client injected. Resolves to
	 * the key; `blockDocument(key)` returns the HTML while it is cached.
	 *
	 * @param {string} text
	 * @param {{ sourcePath?: string|null, dependent?: boolean }} [options]
	 * @returns {Promise<string>} the block's key
	 */
	async renderBlock(text, options = {}) {
		const key = this.#fragmentKey(text, { ...options, document: true });
		await this.#cachedBuild(text, { ...options, document: true });
		return key;
	}

	/** A built block document by key, or undefined once evicted. */
	blockDocument(key) {
		return this.#fragments.get(key);
	}

	#fragmentKey(text, { sourcePath = null, dependent = isDependentFragment(text), document = false }) {
		return sha1ish(`${document ? 'doc' : 'frag'}\0${this.#configGeneration}\0${sourcePath ?? ''}\0${dependent ? this.#fragmentEpoch : ''}\0${text}`);
	}

	#cachedBuild(text, options) {
		if (!this.#open) return Promise.reject(new Error('no vault open'));
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
		const dir = `${VAULT_ROOT}/.clew/cache/fragments`;
		const mdFile = `${dir}/${key}.md`;
		// The temp note and, when the snippet belongs to a note, the sidecar
		// vault-model.js#currentFilePath reads — both as extra vfs entries
		// for this one build (#snapshot excludes .clew/, so nothing else ever
		// sees them). Same directory as desktop, which is what the engine's
		// check `dirname(file) === <root>/.clew/cache/fragments` keys on.
		const extra = { [mdFile]: text };
		if (sourcePath) extra[`${dir}/${key}.source`] = sourcePath;
		const result = await this.#runBuild(mdFile, {
			to: 'html',
			output: `${dir}/${key}.html`,
			fragment: !document,
			normalSyntax: this.#vaultOptions.normalSyntax === true,
		}, extra);
		if (result.type !== 'done') throw new Error(result.message);
		// Bounded cache: drop the oldest half when it grows past 500 entries.
		if (this.#fragments.size > 500) {
			for (const k of [...this.#fragments.keys()].slice(0, 250)) this.#fragments.delete(k);
		}
		this.#fragments.set(key, result.html);
		return result.html;
	}

	// ---- subscriptions ----------------------------------------------------

	subscribe(rel) {
		this.#subscribed.set(rel, (this.#subscribed.get(rel) ?? 0) + 1);
	}

	unsubscribe(rel) {
		const count = (this.#subscribed.get(rel) ?? 1) - 1;
		if (count <= 0) this.#subscribed.delete(rel);
		else this.#subscribed.set(rel, count);
	}

	onFileChanged(rel) {
		this.#fragmentEpoch++;
		if (this.#subscribed.has(rel)) {
			clearTimeout(this.#rebuildTimers.get(rel));
			this.#rebuildTimers.set(rel, setTimeout(() => {
				this.#rebuildTimers.delete(rel);
				this.render(rel).catch(() => {});
			}, REBUILD_DEBOUNCE_MS));
		}
		// Embeds are transclusions: `![[Child]]` puts Child's CONTENT inside
		// the parent's HTML, so a change to Child leaves every note embedding
		// it stale on screen. The index knows who embeds whom (transitively).
		for (const embedder of this.embeddersOf(rel)) {
			this.#restale(embedder);
		}
		// Query notes depend on the whole vault (see desktop render-service).
		if (/\.(md|jmd)$/i.test(rel)) {
			for (const [queryPath, entry] of this.#notes) {
				if (queryPath === rel || !entry.hasQueries) continue;
				this.#restale(queryPath);
			}
		}
	}

	/**
	 * Mark another note's cached render stale and, if a preview is watching,
	 * rebuild it. The note's own mtime has not moved — what changed is
	 * something it renders from — so `mtimeMs = 0` is what makes the next
	 * ensureRendered do the work rather than serve the cache. (Desktop's
	 * #restale, verbatim.)
	 */
	#restale(rel) {
		const entry = this.#notes.get(rel);
		if (entry) entry.mtimeMs = 0;
		if (!this.#subscribed.has(rel)) return;
		clearTimeout(this.#rebuildTimers.get(rel));
		this.#rebuildTimers.set(rel, setTimeout(() => {
			this.#rebuildTimers.delete(rel);
			this.render(rel).catch(() => {});
		}, REBUILD_DEBOUNCE_MS * 2));
	}
}
