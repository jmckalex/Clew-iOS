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
import { VAULT_ROOT, isTextPath } from './vault-manager.js';

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
	#notes = new Map(); // rel -> {mtimeMs, html, hasQueries, inflight, dirty}
	#fragments = new Map();
	#fragmentInflight = new Map();
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

	// Mirrors desktop #writeEngineConfig. Extension paths are registry keys
	// the worker pre-bundles (vault plugins' engine surfaces are not yet
	// loadable on iOS — they would need bundling at runtime).
	#engineConfig() {
		return JSON.stringify({
			'File inclusion': this.#vaultOptions.jmarkdownProject === true,
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
		files[`${ENGINE_CWD}/.jmarkdown/config.json`] = this.#engineConfig();
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
			env: { CLEW_VAULT_ROOT: VAULT_ROOT, CLEW_SESSION_ID: this.sessionId ?? '' },
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
				worker.postMessage({ type: 'build', file, options, ...(extraFiles ? { files: extraFiles } : {}) });
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

	/** Markdown snippet → body HTML (canvas cards), content-hash cached. */
	async renderFragment(text) {
		if (!this.#open) throw new Error('no vault open');
		const key = sha1ish(text);
		const cached = this.#fragments.get(key);
		if (cached !== undefined) return cached;
		const inflight = this.#fragmentInflight.get(key);
		if (inflight) return inflight;
		const job = (async () => {
			const file = `${VAULT_ROOT}/.clew/cache/fragments/${key}.md`;
			const result = await this.#runBuild(file, {
				to: 'html',
				output: `${VAULT_ROOT}/.clew/cache/fragments/${key}.html`,
				fragment: true,
				normalSyntax: this.#vaultOptions.normalSyntax === true,
			}, { [file]: text });
			if (result.type !== 'done') throw new Error(result.message);
			if (this.#fragments.size > 500) {
				for (const k of [...this.#fragments.keys()].slice(0, 250)) this.#fragments.delete(k);
			}
			this.#fragments.set(key, result.html);
			return result.html;
		})().finally(() => this.#fragmentInflight.delete(key));
		this.#fragmentInflight.set(key, job);
		return job;
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
		if (this.#subscribed.has(rel)) {
			clearTimeout(this.#rebuildTimers.get(rel));
			this.#rebuildTimers.set(rel, setTimeout(() => {
				this.#rebuildTimers.delete(rel);
				this.render(rel).catch(() => {});
			}, REBUILD_DEBOUNCE_MS));
		}
		// Query notes depend on the whole vault (see desktop render-service).
		if (/\.(md|jmd)$/i.test(rel)) {
			for (const [queryPath, entry] of this.#notes) {
				if (queryPath === rel || !entry.hasQueries) continue;
				entry.mtimeMs = 0;
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
