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
import { ENGINE_CSL_FILES } from '../src/shim/engine-config.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const shims = path.join(root, 'src', 'worker', 'shims');

const builtinAlias = {};
for (const [mod, file] of Object.entries({
	fs: 'fs.js', path: 'path.js', url: 'url.js', crypto: 'crypto.js',
	child_process: 'child_process.js', module: 'module.js', vm: 'vm.js',
	os: 'os.js', stream: 'stream.js', events: 'events.js', http: 'http.js',
	'fs/promises': 'fs-promises.js', process: 'process.js', util: 'util.js',
})) {
	builtinAlias[mod] = path.join(shims, file);
	builtinAlias[`node:${mod}`] = path.join(shims, file);
}

// Vendored files are patched by exact-string replacement; upstream syncs can
// change those lines. A patch that no longer matches must FAIL the build
// (silent no-ops resurrect the bugs the patches fix).
const patched = (file, source, find, replacement) => {
	if (!source.includes(find)) {
		throw new Error(`[build] patch no longer matches ${file}:\n  expected to find: ${find.slice(0, 90)}…\n  Upstream changed this line — update the patch in scripts/build.js.`);
	}
	return source.replace(find, replacement);
};

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
			if (!source.includes('await import(')) {
				throw new Error('[build] patch no longer matches metadata-header.js: no `await import(` sites found');
			}
			source = source.replaceAll('await import(', 'await __jmdImport(');
			// Vault plugins' engine surfaces are config-named absolute vault
			// paths with no module behind them in the bundle; the worker
			// supplies their SOURCE from the vfs (__jmdImportSource) and it is
			// imported as a blob module — data: fallback because Node (the
			// render-note harness) cannot import blob: URLs, and WebKit is
			// happier with blob:. Both environments hit the same code path.
			const helper = 'const __jmdImportText = async (text) => {\n'
				+ '\ttry {\n'
				+ "\t\tconst url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));\n"
				+ '\t\ttry { return await import(url); } finally { URL.revokeObjectURL(url); }\n'
				+ '\t} catch {\n'
				+ "\t\treturn import('data:text/javascript;base64,' + btoa(unescape(encodeURIComponent(text))));\n"
				+ '\t}\n'
				+ '};\n'
				+ 'const __jmdImport = (p) => {\n'
				+ '\tconst hit = globalThis.__jmdExtensionRegistry?.[p];\n'
				+ '\tif (hit) return Promise.resolve(hit);\n'
				+ '\tconst text = globalThis.__jmdImportSource?.(p);\n'
				+ '\treturn text != null ? __jmdImportText(text) : import(p);\n'
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
			contents: patched('clew-editor-view.js', fs.readFileSync(args.path, 'utf8'),
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
			contents: patched('clew-file-explorer.js', fs.readFileSync(args.path, 'utf8'),
				"row.addEventListener('pointerdown', (e) => this.#maybeStartDrag(e, entry, row));",
				"row.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') this.#maybeStartDrag(e, entry, row); });"),
			loader: 'js',
		}));
		builder.onLoad({ filter: /vendor\/clew\/renderer\/workspace\/tab-drag\.js$/ }, (args) => ({
			contents: patched('tab-drag.js', fs.readFileSync(args.path, 'utf8'),
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
			contents: patched('node-content.js', fs.readFileSync(args.path, 'utf8'),
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
		// Two settings sections offer downloads with nothing behind them on
		// iOS: "PDF viewer" (a 139 MB CJK fallback-font pack) and "Office
		// documents" (the LibreOffice-in-wasm engine). The channels answer
		// "not available" (src/shim/ipc.js) and each would dead-end at a
		// button that never finishes. Drop both sections rather than ship a
		// control that lies. A native URLSession font downloader is a
		// possible later feature; the office engine is the owner's call.
		// Likewise the "LaTeX engine (PDF via LaTeX export)" row and its hint
		// (Clew-app 0b4b7a4): iOS has no TeX toolchain, and that export
		// answers "not available". And the Updates section (below).
		builder.onLoad({ filter: /vendor\/clew\/renderer\/components\/views\/clew-settings-view\.js$/ }, (args) => {
			let src = fs.readFileSync(args.path, 'utf8');
			src = patched('clew-settings-view.js', src,
				"\t\t\tthis.#section('PDF viewer', [...this.#cjkFontRow()]),\n", '');
			src = patched('clew-settings-view.js', src,
				"\t\t\tthis.#section('Office documents', [...this.#officeEngineRow()]),\n", '');
			src = patched('clew-settings-view.js', src,
				"\t\t\t\tthis.#selectRow(LATEX_ENGINE_SETTING.label, 'latexEngine',\n"
				+ "\t\t\t\t\t[['auto', 'Automatic'], ['pdflatex', 'pdfLaTeX'], ['lualatex', 'LuaLaTeX'], ['xelatex', 'XeLaTeX']]),\n"
				+ "\t\t\t\tthis.#hint('Automatic reads the exported document: one that loads fontspec, unicode-math, '\n"
				+ "\t\t\t\t\t+ 'polyglossia or Lua code (a \\\\setmainfont in your jmarkdown config, say) is compiled with '\n"
				+ "\t\t\t\t\t+ 'LuaLaTeX, anything else with pdfLaTeX. Choose an engine here for what that cannot see.'),\n",
				'');
			// The daily update check (Clew-app 036befe) asks clew-app.com for
			// a newer desktop build; the iPad's updates are the App Store's
			// (UPDATE_CHECK answers 'off'), so the section goes.
			src = patched('clew-settings-view.js', src,
				"\t\t\tthis.#section('Updates', [\n"
				+ "\t\t\t\tthis.#selectRow('Check for updates once a day', 'updateCheck', [['on', 'On'], ['off', 'Off']]),\n"
				+ "\t\t\t\tthis.#hint('Clew asks clew-app.com whether a newer version exists and, if so, says so, '\n"
				+ "\t\t\t\t\t+ 'with a link to download it. Nothing is sent but the request itself, and nothing '\n"
				+ "\t\t\t\t\t+ 'is installed for you. Help → Check for Updates… asks at any time.'),\n"
				+ "\t\t\t]),\n",
				'');
			return { contents: src, loader: 'js' };
		});
		// An office document's tab: upstream offers the LibreOffice download
		// (and, with a desktop LibreOffice, a PDF preview); iOS has neither,
		// and the download button would spin forever on an engine that never
		// arrives. Say what iOS does instead — Quick Look — and label the
		// "open externally" button for what it opens.
		builder.onLoad({ filter: /vendor\/clew\/renderer\/components\/views\/clew-file-view\.js$/ }, (args) => ({
			contents: patched('clew-file-view.js',
				patched('clew-file-view.js', fs.readFileSync(args.path, 'utf8'),
					"\t\ttext.textContent = 'Editing Word, Excel and PowerPoint documents in Clew uses LibreOffice, '\n"
					+ "\t\t\t+ `a one-time ${mb(engine.wireBytes)} download. Nothing is fetched until you ask.`;\n"
					+ "\t\tif (engine.lastError) {\n"
					+ "\t\t\tdetail.textContent = `The last download did not finish: ${engine.lastError}`;\n"
					+ "\t\t}\n"
					+ "\t\tconst button = document.createElement('button');\n"
					+ "\t\tbutton.textContent = `Download LibreOffice (${mb(engine.wireBytes)})`;\n"
					+ "\t\tbutton.addEventListener('click', () => officeDock.downloadEngine());\n"
					+ "\t\tpanel.append(button);\n",
					"\t\ttext.textContent = 'Word, Excel and PowerPoint documents open read-only in Quick Look on iOS; '\n"
					+ "\t\t\t+ 'editing them in place needs the desktop app.';\n"),
				"external.textContent = engine.soffice ? 'Open in LibreOffice' : 'Open in default app';",
				"external.textContent = engine.soffice ? 'Open in LibreOffice' : 'Open in Quick Look';"),
			loader: 'js',
		}));
		// One transform on the canvas view. (Patches 2–4 — an engaged node
		// draws no handles or anchors — landed upstream as 45dffd7.)
		builder.onLoad({ filter: /vendor\/clew\/renderer\/components\/views\/clew-canvas-view\.js$/ }, (args) => {
			let src = fs.readFileSync(args.path, 'utf8');
			// 1. A canvas office node's context menu offers a LIVE LibreOffice
			// per node; with no engine that is a blank frame. Drop the choice
			// (the node stays a Quick Look thumbnail; a `live` flag set on
			// desktop is simply not honoured here).
			src = patched('clew-canvas-view.js', src,
				"\t\tif (node.type === 'file' && fileKind(node.file ?? '') === 'office') {\n"
				+ "\t\t\t// Thumbnail vs live editor. Live boots a LibreOffice PER NODE\n"
				+ "\t\t\t// (~1.6 GB) \u2014 an explicit, per-node opt-in, stored under the clew\n"
				+ "\t\t\t// key so Obsidian ignores it.\n"
				+ "\t\t\titems.push(\n"
				+ "\t\t\t\t{ separator: true },\n"
				+ "\t\t\t\t{ choices: true, label: 'Office', current: nstyle.office ?? null, options: [\n"
				+ "\t\t\t\t\t{ value: null, label: 'Thumb', title: 'static thumbnail (refreshes when the file changes)' },\n"
				+ "\t\t\t\t\t{ value: 'live', label: 'Live', title: 'live LibreOffice editor (boots one per node, ~1.6 GB)' },\n"
				+ "\t\t\t\t], onPick: (v) => this.#applyNodeStyle({ office: v }) },\n"
				+ "\t\t\t);\n"
				+ "\t\t}\n",
				'');
			return { contents: src, loader: 'js' };
		});
		// Books (Clew-app 5abf52d): the iPad builds a book only as its reading
		// view's print (EXPORT_BOOK `print`); PDF, LaTeX and HTML need TeX and
		// a Node fork. So the Book panel offers Print PDF alone, and the line
		// above a chapter's reading view offers the print that numbers it as
		// the book does, where desktop offers the HTML build. Upstream
		// candidate: a platform's build formats, asked of the host.
		builder.onLoad({ filter: /vendor\/clew\/renderer\/components\/panels\/clew-book\.js$/ }, (args) => {
			let src = fs.readFileSync(args.path, 'utf8');
			src = patched('clew-book.js', src,
				"for (const [format, label] of [['pdf', 'PDF'], ['latex', 'LaTeX'], ['html', 'HTML'], ['print', 'Print PDF']]) {",
				"for (const [format, label] of [['print', 'Print PDF']]) {");
			// The print goes to the share sheet here, not into build/.
			src = patched('clew-book.js', src,
				"'Print the book as reading view draws it — each chapter from a new page, no TeX — into build/ beside its master'",
				"'Print the book as reading view draws it — each chapter from a new page — and share the PDF'");
			return { contents: src, loader: 'js' };
		});
		builder.onLoad({ filter: /vendor\/clew\/renderer\/books\.js$/ }, (args) => {
			let src = fs.readFileSync(args.path, 'utf8');
			src = patched('books.js', src, "\tbuild.textContent = 'Build';\n", "\tbuild.textContent = 'Print PDF';\n");
			src = patched('books.js', src, "\tbuild.title = `Build “${book.title}” as HTML pages`;\n",
				"\tbuild.title = `Print “${book.title}” as one PDF, each chapter numbered as the book numbers it`;\n");
			src = patched('books.js', src, "\tbuild.addEventListener('click', () => buildBook(book.master, 'html'));\n",
				"\tbuild.addEventListener('click', () => buildBook(book.master, 'print'));\n");
			return { contents: src, loader: 'js' };
		});
		// The shell panel cannot exist on iOS (no PTY), so its command — and
		// with it the Ctrl-` chord and the palette entry — is dropped from the
		// registry. The panel element stays in the DOM, closed (ipc.js forces
		// `shell.open = false` on WORKSPACE_LOAD), and its xterm imports
		// resolve to src/shim/xterm-stub.js.
		builder.onLoad({ filter: /vendor\/clew\/renderer\/commands\/builtin\.js$/ }, (args) => ({
			contents: patched('builtin.js', fs.readFileSync(args.path, 'utf8'),
				"\t\t{ id: 'shell:toggle', name: 'Toggle shell panel', hotkeys: ['Ctrl-`'], when: needsVault,\n"
				+ "\t\t\trun: () => {\n"
				+ "\t\t\t\tconst open = !workspaceStore.shell.open;\n"
				+ "\t\t\t\tworkspaceStore.setShell({ open });\n"
				+ "\t\t\t\tif (open) {\n"
				+ "\t\t\t\t\t// Opening it should put the caret in it; nobody toggles a\n"
				+ "\t\t\t\t\t// terminal open in order to keep typing somewhere else.\n"
				+ "\t\t\t\t\trequestAnimationFrame(() => document.querySelector('clew-shell-panel')?.focusTerminal());\n"
				+ "\t\t\t\t}\n"
				+ "\t\t\t} },\n",
				''),
			loader: 'js',
		}));
	},
};

// The vendored main-process modules the app bundle runs (indexer, kv-store,
// rename-links) write through fs-utils.js#writeFileAtomic, which spells
// `Buffer`. Only that identifier is injected — the worker's globals.js also
// installs process/global, which the app page must never see.
const bufferInject = [path.join(shims, 'buffer-inject.js')];
const xtermStub = path.join(root, 'src', 'shim', 'xterm-stub.js');

// The app page has no `process` (see bufferInject), so a vendored module
// that reads it at load time throws before the shim installs — the app
// boots to nothing. A reference is fine only behind `typeof process`
// (Lezer's LOG check is the one today; fs-utils.js reads
// `globalThis.process?.env`, which is not a bare reference, since Clew-app
// 5306e93 retired our define); any other fails the BUILD, naming the code,
// rather than the boot on a device.
function assertNoBareProcess(file) {
	const text = fs.readFileSync(file, 'utf8');
	const bare = [];
	for (const m of text.matchAll(/(?<![\w$.])process(?=\s*[.[])/g)) {
		if (!text.slice(Math.max(0, m.index - 80), m.index).includes('typeof process')) {
			bare.push(text.slice(Math.max(0, m.index - 60), m.index + 60));
		}
	}
	if (bare.length) {
		throw new Error(`[build] the app bundle reads \`process\` unguarded (${bare.length}×) — it has no process, so it would fail at boot:\n  `
			+ bare.join('\n  ') + '\n  Guard it upstream (globalThis.process?.…), or give it a `define` in buildAppBundle (scripts/build.js).');
	}
}

export async function buildAppBundle({ minify = true } = {}) {
	// The renderer runs unmodified; the entry evaluates the shim first. The
	// vendored main-process services (indexer, search, kv-store, …) resolve
	// node:fs/node:path onto the same vfs the shim's VaultManager fills.
	const result = await build({
		entryPoints: [path.join(root, 'src', 'shim', 'entry.js')],
		bundle: true,
		platform: 'browser',
		format: 'esm',
		target: 'safari16',
		outfile: path.join(webroot, 'bundle.js'),
		// The shell panel's terminal emulator is aliased to an inert stub: a
		// PTY cannot exist on iOS, and clew-shell-panel.js imports both
		// packages at module scope (see src/shim/xterm-stub.js).
		alias: { ...builtinAlias, '@xterm/xterm': xtermStub, '@xterm/addon-fit': xtermStub, '@xterm/addon-unicode11': xtermStub },
		inject: bufferInject,
		plugins: [rendererPatches],
		minify,
		sourcemap: false,
		logLevel: 'warning',
		metafile: true,
	});
	assertNoBareProcess(path.join(webroot, 'bundle.js'));
	return result;
}

// The one iOS-only addition to the preview-side bundles, from src/preview/,
// appended so it runs in the document it belongs to: embed-scroll.js, in
// client.js — a note embedded in a canvas node cannot scroll its root
// scroller under the canvas's scale transform, so on request it scrolls its
// body instead. (The Pencil convention and the viewer handles went upstream
// as preview-client/pdf-pen.js and pdf-handles.js, 12b1734; scene PDFs
// through pdf-page.html, 71180c6.)
const iosEmbedScroll = fs.readFileSync(path.join(root, 'src', 'preview', 'embed-scroll.js'), 'utf8');

const previewClientPatches = {
	name: 'clew-preview-client-patches',
	setup(builder) {
		builder.onLoad({ filter: /vendor\/clew\/preview-client\/client\.js$/ }, (args) => ({
			contents: fs.readFileSync(args.path, 'utf8') + iosEmbedScroll,
			loader: 'js',
		}));
	},
};

export async function buildPreviewClients({ minify = true } = {}) {
	// Classic <script> injections into rendered-note documents — the same
	// bundles the desktop build produces. pdf-page.js is the standalone
	// viewer page's bundle (loaded by pdf-page.html in an iframe).
	const results = [];
	// clew-bridge.js is window.clew inside an app frame (frame-bridge.md §7),
	// served by the clew-frame handler at /__clew_bridge__.js.
	for (const name of ['client.js', 'api.js', 'site-client.js', 'pdf-page.js', 'clew-bridge.js']) {
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
	// Web Awesome components for Meta Bind widgets, plus their design
	// tokens: served as /__clew_preview__/wa.{js,css} (SchemeHandler's
	// closed set) and loaded LAZILY by preview-client/meta-bind.js only
	// when a rendered note contains a widget. Always minified, like
	// upstream: 650 KB of library nobody debugs here.
	results.push(await build({
		entryPoints: [path.join(root, 'vendor', 'clew', 'preview-client', 'wa-bundle.js')],
		bundle: true,
		format: 'iife',
		target: 'safari16',
		outfile: path.join(webroot, 'preview-client', 'wa.js'),
		minify: true,
		logLevel: 'warning',
		metafile: true,
	}));
	results.push(await build({
		entryPoints: [path.join(root, 'vendor', 'clew', 'preview-client', 'wa-styles.css')],
		bundle: true,
		outfile: path.join(webroot, 'preview-client', 'wa.css'),
		minify: true,
		logLevel: 'warning',
		metafile: true,
	}));
	return results;
}

// The Excalidraw editor page — the ONLY bundle in the project that contains
// React. It is loaded in an iframe when a drawing is opened, so the app's own
// renderer never carries a framework and React is parsed only by someone who
// owns a drawing. Config mirrors upstream's bundle entry exactly; nothing of
// ours is inside it, so upgrading is `npm install @excalidraw/excalidraw` and
// a rebuild.
//
// Runs AFTER stageStatic (which wipes preview-assets/) because it writes into
// preview-assets/clewex — page.js, the page.css esbuild emits from
// Excalidraw's index.css import, and the font/image files the loaders below
// turn into separate assets.
export async function buildExcalidrawPage({ minify = true } = {}) {
	return build({
		entryPoints: [path.join(root, 'vendor', 'clew', 'excalidraw', 'page.js')],
		outfile: path.join(webroot, 'preview-assets', 'clewex', 'page.js'),
		bundle: true,
		format: 'iife',
		target: 'safari16',
		jsx: 'automatic',
		// Excalidraw's exports map offers only development/production
		// conditions — no default — so without this neither its entry point nor
		// its stylesheet resolves.
		conditions: ['production'],
		// Always minified, like upstream: React plus Excalidraw is ~14 MB
		// unminified, and there is nothing of ours in here to debug.
		minify: true,
		loader: { '.woff2': 'file', '.ttf': 'file', '.png': 'file', '.svg': 'file' },
		define: { 'process.env.NODE_ENV': '"production"' },
		logLevel: 'warning',
		metafile: true,
	});
}

// Font Awesome Free's icons as one table — `family:name` → [width, height,
// path] — for custom callout types (Clew-app's scripts/build.js
// #writeIconTable, the same format): the shim resolves the names a
// definition uses from it and hands the worker only those paths, and
// Settings' icon picker loads it on demand. Never on a render path. Built
// from the package's own svgs/ (CC BY 4.0), which do not ship in the app.
function writeIconTable() {
	const base = path.join(root, 'node_modules/@fortawesome/fontawesome-free');
	const icons = {};
	for (const family of ['solid', 'regular', 'brands']) {
		const dir = path.join(base, 'svgs', family);
		if (!fs.existsSync(dir)) continue;
		for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.svg')).sort()) {
			const svg = fs.readFileSync(path.join(dir, file), 'utf8');
			const box = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg);
			const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
			if (!box || !paths.length) continue;
			icons[`${family}:${file.slice(0, -4)}`] = [Number(box[1]), Number(box[2]), paths.join(' ')];
		}
	}
	const { version } = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
	fs.mkdirSync(webroot, { recursive: true });
	fs.writeFileSync(path.join(webroot, 'fa-icons.json'), JSON.stringify({ version, icons }));
}

export function stageStatic() {
	writeIconTable();
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
	for (const name of ENGINE_CSL_FILES) {
		copy(path.join(root, 'vendor', 'jmarkdown', 'src', 'csl', name), path.join(webroot, 'engine', 'csl', name));
	}
	copy(path.join(dist, 'engine-worker.js'), path.join(webroot, 'engine-worker.js'));
	// Preview iframe assets, laid out like the desktop packaged app
	// (protocol.js assetRoots → Swift scheme handler).
	copy(path.join(root, 'vendor', 'clew', 'engine'), path.join(webroot, 'engine-assets'));
	// Wipe the tree rather than overwriting entry by entry: an asset REMOVED
	// from the map below (PDF.js, when EmbedPDF became the only PDF stack)
	// otherwise lingers forever in an incremental dist and ships in the app.
	fs.rmSync(path.join(webroot, 'preview-assets'), { recursive: true, force: true });
	const assets = {
		'mathjax/es5': 'node_modules/mathjax/es5',
		'mermaid/dist/mermaid.min.js': 'node_modules/mermaid/dist/mermaid.min.js',
		'highlight.js/styles': 'node_modules/highlight.js/styles',
		'@fortawesome/fontawesome-free/js/all.min.js': 'node_modules/@fortawesome/fontawesome-free/js/all.min.js',
		'jquery/dist/jquery.min.js': 'node_modules/jquery/dist/jquery.min.js',
		'leaflet/dist': 'node_modules/leaflet/dist',
		// Excalidraw's own fonts, locale data and subsetting worker chunks.
		// page.js sets window.EXCALIDRAW_ASSET_PATH to this root so the editor
		// never reaches unpkg — a note app has to open a drawing on a train.
		// Staged whole, exactly as upstream's protocol.js maps dist/prod: the
		// editor fetches from here lazily and by name, and guessing at the
		// subset is how a font silently stops loading. (12 MB of the 17 is the
		// Xiaolai CJK face — a candidate prune if app size ever matters more
		// than CJK handwriting.)
		'excalidraw': 'node_modules/@excalidraw/excalidraw/dist/prod',
	};
	// EmbedPDF (MIT) — Pdfium-in-wasm viewer with the full annotation suite,
	// and now the ONLY PDF stack in the app: one ESM bundle + hashed chunks +
	// pdfium.wasm, all inside the viewer's dist; staged whole, then pruned of
	// maps / types the app should not ship. Since upstream de45fe7 this is
	// the owner's OCG build (layers fork) from the committed vendor mirror,
	// not the @embedpdf/snippet npm package.
	assets['embedpdf'] = 'vendor/embedpdf/dist';
	// The stamp tool's library (vendor/default-stamps, MIT; upstream 88b6dd2):
	// pdf-core.js asks for __clew_assets__/stamps/{locale}/manifest.json, so
	// no viewer ever fetches it from jsdelivr.
	assets['default-stamps'] = 'vendor/default-stamps';

	for (const [to, from] of Object.entries(assets)) {
		copy(path.join(root, from), path.join(webroot, 'preview-assets', to));
	}
	// mp-tikz-wasm — the wasm MetaPost/TeX engines and their TeX bundles
	// (74 MB, 3,600 files), staged into the gitignored mptikz-assets/ by
	// scripts/stage-mptikz.js and served whole as the `mptikz` asset root:
	// a first figure reads the bundles by the dozen through kpathsea, so the
	// tree must stay unpacked and complete, exactly as upstream ships it
	// under Resources/mptikz. A missing tree is a warning here and a refusal
	// in CI (stage-mptikz --require), never a silent build: without it every
	// figure shows "No TikZ/MetaPost engine installed" in its own place.
	const mptikzSrc = path.join(root, 'mptikz-assets');
	if (fs.existsSync(path.join(mptikzSrc, 'index.js'))) {
		fs.cpSync(mptikzSrc, path.join(webroot, 'preview-assets', 'mptikz'), {
			recursive: true,
			filter: (src) => !/\.(js\.map|d\.ts)$/.test(src) && path.basename(src) !== '.cache',
		});
	} else {
		console.warn('[build] mptikz-assets/ is not staged (node scripts/stage-mptikz.js) — figures will not typeset in this build');
	}
	const embedPdfDir = path.join(webroot, 'preview-assets', 'embedpdf');
	for (const name of fs.readdirSync(embedPdfDir)) {
		if (/\.(pdf|map|d\.ts)$/.test(name) || name === 'index.html') {
			fs.rmSync(path.join(embedPdfDir, name), { recursive: true, force: true });
		}
	}
	// The standalone viewer page, beside the pdf-page.js bundle that
	// buildPreviewClients writes — together they are the `clewpdf` asset root
	// (SchemeHandler.assetRoots), which is where preview-url.js's
	// pdfViewerUrl() points the file tab and canvas PDF nodes.
	copy(path.join(root, 'vendor', 'clew', 'preview-client', 'pdf-page.html'),
		path.join(webroot, 'preview-client', 'pdf-page.html'));
	// Likewise the Excalidraw editor's host page, beside the page.js/page.css
	// buildExcalidrawPage writes — the `clewex` asset root.
	copy(path.join(root, 'vendor', 'clew', 'excalidraw', 'page.html'),
		path.join(webroot, 'preview-assets', 'clewex', 'page.html'));
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
		inject: bufferInject,
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
	outputs.push(await buildExcalidrawPage({ minify }));
	outputs.push(await buildAppBundle({ minify }));
	outputs.push(...await buildPreviewClients({ minify }));
	outputs.push(await buildServicesTestBundle());
	for (const result of outputs) {
		for (const [file, out] of Object.entries(result.metafile.outputs)) {
			if (out.bytes > 1024) console.log(`${file}  ${(out.bytes / 1024 / 1024).toFixed(2)} MB`);
		}
	}
}
