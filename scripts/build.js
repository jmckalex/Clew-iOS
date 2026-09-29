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
	'fs/promises': 'fs-promises.js', process: 'process.js',
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
		// Upstream's renderer reaches its engine mirror by a relative path
		// (`../../../../vendor/jmarkdown/src/crossref.js` from editor/live/),
		// which counts on the app living at <repo>/src. Here the app is
		// mirrored one level deeper (vendor/clew), so the same path lands on
		// a vendor/vendor/… that does not exist. Re-root it onto this repo's
		// vendor/jmarkdown — the one place the two layouts differ that an
		// import can see. tests/hooks/vendor-jmarkdown.mjs is the same rule
		// for node --test. (Upstream candidate: an import map or a package
		// self-reference would make the engine reachable by name.)
		builder.onResolve({ filter: /^(?:\.\.\/)+vendor\/jmarkdown\// }, (args) => {
			if (!args.importer.startsWith(path.join(root, 'vendor', 'clew') + path.sep)) return undefined;
			const rest = args.path.replace(/^(?:\.\.\/)+vendor\/jmarkdown\//, '');
			return { path: path.join(root, 'vendor', 'jmarkdown', rest) };
		});
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
		builder.onLoad({ filter: /vendor\/clew\/renderer\/components\/views\/clew-settings-view\.js$/ }, (args) => ({
			contents: patched('clew-settings-view.js',
				patched('clew-settings-view.js', fs.readFileSync(args.path, 'utf8'),
					"\t\t\tthis.#section('PDF viewer', [...this.#cjkFontRow()]),\n",
					''),
				"\t\t\tthis.#section('Office documents', [...this.#officeEngineRow()]),\n",
				''),
			loader: 'js',
		}));
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
		// Three transforms on the canvas view, applied in order.
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
			// 2. An engaged node's content owns its pointer events, so the
			// resize handles drawn over its corners are a lie: a drag there
			// goes to the content, not to the geometry. On touch that matters
			// more than on desktop \u2014 engaging is a double tap (src/shim/
			// ios-ui.js) and the handles vanishing is half of how you can see
			// it happened, the border colour (ios.css) being the other half.
			src = patched('clew-canvas-view.js', src,
				"if (soloNode && this.#tool === 'select' && !this.#drag) handleRect(model.nodeRect(soloNode));",
				"if (soloNode && this.#tool === 'select' && !this.#drag && this.#engagedId !== soloNode.id) handleRect(model.nodeRect(soloNode));");
			// 3. \u2026 which only shows if the overlay is redrawn when the engaged
			// node changes. #engage/#disengage just toggle a class today.
			src = patched('clew-canvas-view.js', src,
				"\t\tthis.#nodeEls.get(id)?.classList.add('is-engaged');\n",
				"\t\tthis.#nodeEls.get(id)?.classList.add('is-engaged');\n\t\tthis.#syncOverlay();\n");
			src = patched('clew-canvas-view.js', src,
				"\t\tthis.#engagedId = null;\n",
				"\t\tthis.#engagedId = null;\n\t\tthis.#syncOverlay();\n");
			// 4. Same argument for the connection anchors: the side dots start
			// an edge drag, which an engaged node's content swallows.
			src = patched('clew-canvas-view.js', src,
				"\t\tif (anchorTarget) {\n",
				"\t\tif (anchorTarget && this.#engagedId !== anchorTarget.id) {\n");
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
		// The renderer's vault-settings store (grammar, live-edit config,
		// TeX-fragment warnings) is loaded ONLY in the EV_VAULT_OPENED
		// handler. iOS boots through the VAULT_CURRENT branch — desktop's
		// window-reload path — which never fires that event, so the store
		// would stay `{}` every launch and the first editors would take the
		// wrong grammar (the pool awaits ready(), which starts resolved). Load
		// it there too, before the workspace restores. Upstream candidate: a
		// desktop reload has the same hole.
		builder.onLoad({ filter: /vendor\/clew\/renderer\/main\.js$/ }, (args) => ({
			contents: patched('renderer/main.js', fs.readFileSync(args.path, 'utf8'),
				'\t\tif (vault.watchCap) watchCapNotice(vault.watchCap);\n',
				'\t\tif (vault.watchCap) watchCapNotice(vault.watchCap);\n'
				+ '\t\tawait vaultSettingsStore.load();\n'),
			loader: 'js',
		}));
		// Floaters clamp to window.innerWidth/innerHeight, and in a WKWebView
		// the software keyboard shrinks neither — only the VISUAL viewport —
		// so "below the anchor" can land under the keyboard. Both placement
		// functions read the visual viewport's bottom and right edges
		// instead; identical on desktop, where the two viewports agree
		// (upstream candidate). The formatting popovers (popover.js) and the
		// preview pane + link preview (floating-pane.js#placeAgainst).
		builder.onLoad({ filter: /vendor\/clew\/renderer\/editor\/toolbar\/popover\.js$/ }, (args) => ({
			contents: patched('toolbar/popover.js', fs.readFileSync(args.path, 'utf8'),
				"\tif (top + r.height > window.innerHeight - 8 && a.top - r.height - 4 > 8) top = a.top - r.height - 4;\n"
				+ "\tconst left = Math.max(8, Math.min(a.left, window.innerWidth - r.width - 8));\n",
				"\tconst vv = window.visualViewport;\n"
				+ "\tconst bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;\n"
				+ "\tconst right = vv ? vv.offsetLeft + vv.width : window.innerWidth;\n"
				+ "\tif (top + r.height > bottom - 8 && a.top - r.height - 4 > 8) top = a.top - r.height - 4;\n"
				+ "\tconst left = Math.max(8, Math.min(a.left, right - r.width - 8));\n"),
			loader: 'js',
		}));
		builder.onLoad({ filter: /vendor\/clew\/renderer\/components\/chrome\/floating-pane\.js$/ }, (args) => ({
			contents: patched('chrome/floating-pane.js',
				patched('chrome/floating-pane.js', fs.readFileSync(args.path, 'utf8'),
					"\t\tconst fitsBelow = below + r.height <= window.innerHeight - 8;\n",
					"\t\tconst vv = window.visualViewport;\n"
					+ "\t\tconst fitsBelow = below + r.height <= (vv ? vv.offsetTop + vv.height : window.innerHeight) - 8;\n"),
				"\t\tthis.style.left = `${Math.round(Math.max(8, Math.min(left, window.innerWidth - r.width - 8)))}px`;\n",
				"\t\tthis.style.left = `${Math.round(Math.max(8, Math.min(left, (vv ? vv.offsetLeft + vv.width : window.innerWidth) - r.width - 8)))}px`;\n"),
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
			contents: patched('clew-preview-view.js',
				patched('clew-preview-view.js', fs.readFileSync(args.path, 'utf8'),
					'ipc.invoke(CH.RENDER_SUBSCRIBE, { path: this.path }).catch(() => {});',
					'if (!this.__iosSubscribed) { this.__iosSubscribed = true; ipc.invoke(CH.RENDER_SUBSCRIBE, { path: this.path }).catch(() => {}); }'),
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

// The vendored main-process modules the app bundle runs (indexer, kv-store,
// rename-links) write through fs-utils.js#writeFileAtomic, which spells
// `Buffer`. Only that identifier is injected — the worker's globals.js also
// installs process/global, which the app page must never see.
const bufferInject = [path.join(shims, 'buffer-inject.js')];
const xtermStub = path.join(root, 'src', 'shim', 'xterm-stub.js');

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
		// The shell panel's terminal emulator is aliased to an inert stub: a
		// PTY cannot exist on iOS, and clew-shell-panel.js imports both
		// packages at module scope (see src/shim/xterm-stub.js).
		alias: { ...builtinAlias, '@xterm/xterm': xtermStub, '@xterm/addon-fit': xtermStub },
		inject: bufferInject,
		plugins: [rendererPatches],
		minify,
		sourcemap: false,
		logLevel: 'warning',
		metafile: true,
	});
}

// iOS-only additions to the preview-side bundles. Real sources in
// src/preview/, appended so they share the bundle's module scope and run in
// the document they belong to.
//
//  - pdf-touch.js goes into BOTH client.js (note embeds) and pdf-page.js
//    (file tabs, canvas nodes): the Pencil finger-pan convention, which has
//    no desktop equivalent.
//  - pdf-scene-embeds.js goes into client.js only: raw <embed> PDFs inside
//    .canvas-embed-scene, which WebKit shows as one static page.
//  - embed-scroll.js goes into client.js only: a note embedded in a canvas
//    node cannot scroll its root scroller under the canvas's scale
//    transform, so on request it scrolls its body instead.
const readPreviewModule = (name) =>
	fs.readFileSync(path.join(root, 'src', 'preview', name), 'utf8');
const iosPdfTouch = readPreviewModule('pdf-touch.js');
const iosPdfSceneEmbeds = readPreviewModule('pdf-scene-embeds.js');
const iosEmbedScroll = readPreviewModule('embed-scroll.js');

const previewClientPatches = {
	name: 'clew-preview-client-patches',
	setup(builder) {
		// WebKit can move/restore a preview iframe during workspace
		// reconciliation without re-running its scripts — the client's
		// one-shot 'ready' is lost and the host↔preview bridge never opens.
		// Re-announce on pageshow (fires on WebKit document restores) so the
		// handshake always completes.
		builder.onLoad({ filter: /vendor\/clew\/preview-client\/client\.js$/ }, (args) => ({
			contents: patched('preview-client/client.js', fs.readFileSync(args.path, 'utf8'),
				"post({ type: 'ready' });",
				"post({ type: 'ready' });\n"
				+ "window.addEventListener('pageshow', () => post({ type: 'ready' }));\n"
				+ iosPdfTouch + iosPdfSceneEmbeds + iosEmbedScroll),
			loader: 'js',
		}));
		// Both PDF surfaces build their viewer here, so one hook reaches all
		// three. pdf-embed.js publishes its own viewers on
		// window.__clewPdfViewers, but pdf-page.js keeps its handle private —
		// and the touch layer needs the annotation capability from every
		// surface, not just embeds. (Upstream candidate: publish handles from
		// pdf-core itself; the smoke hooks beside this line already exist for
		// the same reason.)
		builder.onLoad({ filter: /vendor\/clew\/preview-client\/pdf-core\.js$/ }, (args) => ({
			contents: patched('preview-client/pdf-core.js', fs.readFileSync(args.path, 'utf8'),
				'\t// Spike instrumentation.\n'
				+ '\twindow.__clewPdfReady = (window.__clewPdfReady ?? 0) + 1;',
				'\t(window.__clewPdfHandles ??= new Set()).add(handle);\n'
				+ '\t// Spike instrumentation.\n'
				+ '\twindow.__clewPdfReady = (window.__clewPdfReady ?? 0) + 1;'),
			loader: 'js',
		}));
	},
};

const previewPagePatches = {
	name: 'clew-preview-page-patches',
	setup(builder) {
		previewClientPatches.setup(builder);
		// The standalone viewer page gets the Pencil layer too — it is the
		// surface a file tab and a canvas PDF node both load.
		builder.onLoad({ filter: /vendor\/clew\/preview-client\/pdf-page\.js$/ }, (args) => ({
			contents: fs.readFileSync(args.path, 'utf8') + iosPdfTouch,
			loader: 'js',
		}));
	},
};

export async function buildPreviewClients({ minify = true } = {}) {
	// Classic <script> injections into rendered-note documents — the same
	// bundles the desktop build produces. pdf-page.js is the standalone
	// viewer page's bundle (loaded by pdf-page.html in an iframe).
	const results = [];
	for (const name of ['client.js', 'api.js', 'site-client.js', 'pdf-page.js']) {
		results.push(await build({
			entryPoints: [path.join(root, 'vendor', 'clew', 'preview-client', name)],
			bundle: true,
			format: 'iife',
			target: 'safari16',
			outfile: path.join(webroot, 'preview-client', name),
			plugins: [previewPagePatches],
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
