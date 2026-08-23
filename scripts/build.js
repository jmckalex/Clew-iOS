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
		minify,
		sourcemap: false,
		logLevel: 'warning',
		metafile: true,
	});
}

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
