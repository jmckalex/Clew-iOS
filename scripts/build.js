// esbuild for the iOS web layer. Outputs into dist/ (staged into the Xcode
// app's WebRoot by scripts/stage-webroot.js):
//   dist/engine-worker.js   the jmarkdown engine, bundled for a Web Worker
//                           with Node-builtin shims (src/worker/shims/)
//   dist/renderer.js        the Clew renderer (vendor/clew/renderer) + the
//                           iOS platform shim providing window.clew
//   dist/preview-client/    client.js + api.js for rendered-note iframes
//   dist/index.html, styles/, engine assets — verbatim copies
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const shims = path.join(root, 'src', 'worker', 'shims');

const builtinAlias = {};
for (const [mod, file] of Object.entries({
	fs: 'fs.js', path: 'path.js', url: 'url.js', crypto: 'crypto.js',
	child_process: 'child_process.js', module: 'module.js', vm: 'vm.js',
	os: 'os.js', stream: 'stream.js', events: 'events.js', http: 'http.js',
	'fs/promises': 'fs-promises.js', process: 'process.js',
})) {
	builtinAlias[mod] = path.join(shims, file);
	builtinAlias[`node:${mod}`] = path.join(shims, file);
}

// Engine patch: the config's "Extensions"/"Directives"/"Environments"
// entries load via runtime `await import(<absolute path>)` — impossible in
// a bundle. Redirect every dynamic import in metadata-header.js through a
// registry the worker entry fills with the pre-bundled Clew extensions.
// (Vendor stays untouched on disk; this is a build-time transform only.
// Upstream candidate: a registry hook in the engine itself.)
const enginePatches = {
	name: 'clew-engine-patches',
	setup(builder) {
		const vendorSrc = path.join(root, 'vendor', 'jmarkdown', 'src');
		builder.onLoad({ filter: /vendor\/jmarkdown\/src\/metadata-header\.js$/ }, (args) => {
			let source = fs.readFileSync(args.path, 'utf8');
			source = source.replaceAll('await import(', 'await __jmdImport(');
			const helper = 'const __jmdImport = (p) => {\n'
				+ '\tconst hit = globalThis.__jmdExtensionRegistry?.[p];\n'
				+ '\treturn hit ? Promise.resolve(hit) : import(p);\n'
				+ '};\n';
			return { contents: helper + source, loader: 'js' };
		});
		// algebra.js's expressions.js assigns `Term = function …` without a
		// declaration — a sloppy-mode global under real Node CJS, a
		// ReferenceError inside the (strict) bundle. Declare it.
		builder.onLoad({ filter: /node_modules\/algebra\.js\/src\/expressions\.js$/ }, (args) => ({
			contents: 'var Term;\n' + fs.readFileSync(args.path, 'utf8'),
			loader: 'js',
		}));
		// Dead-in-worker modules; stubbing removes chokidar/http/commander.
		builder.onResolve({ filter: /^commander$/ }, () => ({ path: path.join(root, 'src', 'worker', 'stubs.js') }));
		builder.onResolve({ filter: /^\.\/watch\.js$/ }, (args) => (
			args.resolveDir === vendorSrc ? { path: path.join(root, 'src', 'worker', 'stubs.js') } : undefined
		));
	},
};

export async function buildEngineWorker({ minify = true } = {}) {
	const result = await build({
		entryPoints: [path.join(root, 'src', 'worker', 'engine-worker.js')],
		bundle: true,
		platform: 'browser',
		format: 'esm',
		target: 'safari16',
		outfile: path.join(dist, 'engine-worker.js'),
		alias: builtinAlias,
		inject: [path.join(shims, 'globals.js')],
		// processFile derives 'Jmarkdown app directory' from import.meta.url on
		// every build; pinning it makes template/css reads resolve to /engine
		// in the vfs regardless of where the worker script is served from.
		define: {
			'process.env.NODE_ENV': '"production"',
			'import.meta.url': '"file:///engine/engine-worker.js"',
		},
		plugins: [enginePatches],
		minify,
		sourcemap: false,
		logLevel: 'warning',
		metafile: true,
	});
	return result;
}

// ---- the app bundle + webroot ---------------------------------------------

const webroot = path.join(dist, 'webroot');

// Renderer patches for touch devices — build-time transforms of vendored
// files (vendor stays untouched on disk; upstream candidates).
const rendererPatches = {
	name: 'clew-renderer-patches',
	setup(builder) {
		// Auto-focusing the editor pops the on-screen keyboard on every note
		// open; on coarse-pointer devices a tap focuses deliberately instead.
		builder.onLoad({ filter: /vendor\/clew\/renderer\/components\/workspace\/clew-editor-view\.js$/ }, (args) => ({
			contents: fs.readFileSync(args.path, 'utf8').replace(
				'entry.view.focus();',
				"if (!matchMedia('(pointer: coarse)').matches) entry.view.focus();"),
			loader: 'js',
		}));
		// Touch drags must scroll, not drag: the explorer's file-move drag and
		// the tab-bar drag arm on ANY pointerdown, so a slow touch drag fed
		// them instead of scrolling (the tree lit up as a drop target — the
		// only working scroll was a flick fast enough for WebKit's scroll
		// recognizer to pointercancel the row first). Gate both drags to
		// non-touch pointers; touch keeps tap-to-open, long-press menus, and
		// native scrolling, and moves stay available via drag with a
		// trackpad/mouse or on desktop.
		builder.onLoad({ filter: /vendor\/clew\/renderer\/components\/panels\/clew-file-explorer\.js$/ }, (args) => ({
			contents: fs.readFileSync(args.path, 'utf8').replace(
				"row.addEventListener('pointerdown', (e) => this.#maybeStartDrag(e, entry, row));",
				"row.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') this.#maybeStartDrag(e, entry, row); });"),
			loader: 'js',
		}));
		builder.onLoad({ filter: /vendor\/clew\/renderer\/workspace\/tab-drag\.js$/ }, (args) => ({
			contents: fs.readFileSync(args.path, 'utf8').replace(
				'if (e.button !== 0) return;',
				"if (e.button !== 0 || e.pointerType === 'touch') return;"),
			loader: 'js',
		}));
		// Canvas web nodes use Electron's <webview> (an unknown element in
		// WKWebView — the spinner never clears). Swap in the sandboxed
		// <iframe> shape the preview client already uses for canvas embeds,
		// adapting Electron's did-*-loading events onto load/error. reload()
		// is absent on iframes, so the existing try/catch falls back to a src
		// reset. Sites that refuse framing (X-Frame-Options) show blank —
		// same limitation as embedded canvases in previews.
		builder.onLoad({ filter: /vendor\/clew\/renderer\/canvas\/node-content\.js$/ }, (args) => ({
			contents: fs.readFileSync(args.path, 'utf8').replace(
				"const webview = document.createElement('webview');\n"
				+ "\t\twebview.className = 'canvas-webview';\n"
				+ "\t\twebview.setAttribute('partition', 'persist:clew-canvas');\n"
				+ "\t\twebview.setAttribute('src', node.url);",
				"const webview = document.createElement('iframe');\n"
				+ "\t\twebview.className = 'canvas-webview';\n"
				+ "\t\twebview.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');\n"
				+ "\t\twebview.setAttribute('referrerpolicy', 'no-referrer');\n"
				+ "\t\twebview.setAttribute('src', node.url);\n"
				+ "\t\twebview.addEventListener('load', () => webview.dispatchEvent(new Event('did-stop-loading')));\n"
				+ "\t\twebview.addEventListener('error', () => webview.dispatchEvent(new Event('did-fail-load')));"),
			loader: 'js',
		}));
		// WebKit + custom schemes: when the workspace reconciler moves a
		// freshly inserted preview iframe, the reinserted frame's window
		// proxy goes stale — its document loads and runs, but postMessage is
		// silently dropped in BOTH directions, so the host↔preview bridge
		// (re-renders, theme, scroll sync, checkboxes) never comes up. If the
		// client hasn't said 'ready' shortly after render(), rebuild the
		// iframe once the DOM has settled — a never-moved frame works.
		builder.onLoad({ filter: /vendor\/clew\/renderer\/components\/workspace\/clew-preview-view\.js$/ }, (args) => ({
			contents: fs.readFileSync(args.path, 'utf8')
				.replace(
					'ipc.invoke(CH.RENDER_SUBSCRIBE, { path: this.path }).catch(() => {});',
					'if (!this.__iosSubscribed) { this.__iosSubscribed = true; ipc.invoke(CH.RENDER_SUBSCRIBE, { path: this.path }).catch(() => {}); }')
				.replace(
					'this.replaceChildren(this.#iframe);',
					'this.replaceChildren(this.#iframe);\n'
					+ '\t\tclearTimeout(this.__iosReadyTimer);\n'
					+ '\t\tthis.__iosReadyTimer = setTimeout(() => {\n'
					+ '\t\t\tif (!this.#clientReady && this.isConnected) this.render();\n'
					+ '\t\t}, 2500);'),
			loader: 'js',
		}));
	},
};

export async function buildAppBundle({ minify = true } = {}) {
	// The renderer runs unmodified; the entry evaluates the shim first. The
	// vendored main-process services (indexer, search, kv-store, …) resolve
	// node:fs/node:path onto the same vfs the shim's VaultManager fills.
	return build({
		entryPoints: [path.join(root, 'src', 'shim', 'entry.js')],
		bundle: true,
		platform: 'browser',
		format: 'esm',
		target: 'safari16',
		outfile: path.join(webroot, 'bundle.js'),
		alias: builtinAlias,
		plugins: [rendererPatches],
		minify,
		sourcemap: false,
		logLevel: 'warning',
		metafile: true,
	});
}

// WebKit can move/restore a preview iframe during workspace reconciliation
// without re-running its scripts — the client's one-shot 'ready' is lost and
// the host↔preview bridge never opens. Re-announce on pageshow (fires on
// WebKit document restores) so the handshake always completes.
const previewClientPatches = {
	name: 'clew-preview-client-patches',
	setup(builder) {
		builder.onLoad({ filter: /vendor\/clew\/preview-client\/client\.js$/ }, (args) => ({
			contents: fs.readFileSync(args.path, 'utf8').replace(
				"post({ type: 'ready' });",
				"post({ type: 'ready' });\nwindow.addEventListener('pageshow', () => post({ type: 'ready' }));"),
			loader: 'js',
		}));
	},
};

export async function buildPreviewClients({ minify = true } = {}) {
	// Classic <script> injections into rendered-note documents — same three
	// bundles the desktop build produces.
	const results = [];
	for (const name of ['client.js', 'api.js', 'site-client.js']) {
		results.push(await build({
			entryPoints: [path.join(root, 'vendor', 'clew', 'preview-client', name)],
			bundle: true,
			format: 'iife',
			target: 'safari16',
			outfile: path.join(webroot, 'preview-client', name),
			plugins: [previewClientPatches],
			minify,
			logLevel: 'warning',
			metafile: true,
		}));
	}
	return results;
}

export function stageStatic() {
	const copy = (from, to) => {
		fs.rmSync(to, { recursive: true, force: true });
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.cpSync(from, to, { recursive: true });
	};
	copy(path.join(root, 'src', 'ios', 'index.html'), path.join(webroot, 'index.html'));
	copy(path.join(root, 'vendor', 'clew', 'renderer', 'styles'), path.join(webroot, 'styles'));
	copy(path.join(root, 'src', 'ios', 'styles', 'ios.css'), path.join(webroot, 'styles', 'ios.css'));
	// Engine template assets the render service snapshots into each worker.
	for (const [name, source] of Object.entries({
		'default-template.html.mustache': 'vendor/jmarkdown/src/default-template.html.mustache',
		'default-template.tex.mustache': 'vendor/jmarkdown/src/default-template.tex.mustache',
		'Biblify.js.mustache': 'vendor/jmarkdown/src/Biblify.js.mustache',
		'jmarkdown.css': 'vendor/jmarkdown/src/jmarkdown.css',
		'clew-template.html': 'vendor/clew/engine/clew-template.html',
	})) {
		copy(path.join(root, source), path.join(webroot, 'engine', name));
	}
	copy(path.join(dist, 'engine-worker.js'), path.join(webroot, 'engine-worker.js'));
	// Preview iframe assets, laid out like the desktop packaged app
	// (protocol.js assetRoots → Swift scheme handler).
	copy(path.join(root, 'vendor', 'clew', 'engine'), path.join(webroot, 'engine-assets'));
	const assets = {
		'mathjax/es5': 'node_modules/mathjax/es5',
		'mermaid/dist/mermaid.min.js': 'node_modules/mermaid/dist/mermaid.min.js',
		'highlight.js/styles': 'node_modules/highlight.js/styles',
		'@fortawesome/fontawesome-free/js/all.min.js': 'node_modules/@fortawesome/fontawesome-free/js/all.min.js',
		'jquery/dist/jquery.min.js': 'node_modules/jquery/dist/jquery.min.js',
		'leaflet/dist': 'node_modules/leaflet/dist',
	};
	for (const [to, from] of Object.entries(assets)) {
		copy(path.join(root, from), path.join(webroot, 'preview-assets', to));
	}
}

export async function buildServicesTestBundle() {
	// The services layer with node builtins aliased to the shims, importable
	// from node --test (which otherwise would resolve node:fs to the real fs).
	return build({
		entryPoints: [path.join(root, 'src', 'shim', 'ipc.js')],
		bundle: true,
		platform: 'neutral',
		mainFields: ['module', 'main'],
		format: 'esm',
		outfile: path.join(dist, 'test', 'services.js'),
		alias: builtinAlias,
		logLevel: 'warning',
		metafile: true,
	});
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
	const minify = !process.argv.includes('--dev');
	fs.mkdirSync(dist, { recursive: true });
	const outputs = [];
	outputs.push(await buildEngineWorker({ minify }));
	stageStatic();
	outputs.push(await buildAppBundle({ minify }));
	outputs.push(...await buildPreviewClients({ minify }));
	outputs.push(await buildServicesTestBundle());
	for (const result of outputs) {
		for (const [file, out] of Object.entries(result.metafile.outputs)) {
			if (out.bytes > 1024) console.log(`${file}  ${(out.bytes / 1024 / 1024).toFixed(2)} MB`);
		}
	}
}
