// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The clew-preview:// protocol: serves rendered notes (from the render
// cache), the note's own directory for relative assets (images, TikZ/
// mermaid caches), Clew's vendored preview assets, and the preview client.
//
// URL space (host is always 'vault'). A protocol handler cannot see which
// window issued a request, so vault URLs carry the session id of the
// window/vault they belong to:
//   clew-preview://vault/__clew_assets__/…     vendored assets (mathjax, …)
//   clew-preview://vault/__clew_preview__/…    preview client / note API
//   clew-preview://vault/<sid>/<note path>.html   rendered note (on demand)
//   clew-preview://vault/<sid>/<any other path>   the real file from the vault
//
// Because a rendered note's URL sits in its real (sid-prefixed) directory,
// relative references in the document resolve through this handler
// untouched — and stay inside the right vault.
import { app, protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { NOTE_EXTENSIONS } from '../shared/channels.js';
import { sessionById } from './session.js';
import { previewPluginScripts, enabledPlugins } from './plugins.js';
import { previewCsp, isScriptableDocument } from './preview-csp.js';
import { settings } from './settings.js';
import { fontsDir, fallbackConfig } from './pdf-fonts.js';
import { narrowCors, renderOriginAllowed } from './preview-cors.js';
import { appFileFor, appPageCsp } from './app-files.js';
import { FRAME_SCHEME, appFile, appCsp, injectBridge } from './app-frames.js';
import { appByKey, resolveFor, stateOf } from './app-registry.js';
import { rewriteAppEmbeds } from './app-embeds-rewrite.js';
import { APP_ORIGIN } from '../shared/caller-token.js';
import { readRenderBody } from './caller-token.js';
import { rewritePdfFrames, viewerUrl } from './pdf-frames-rewrite.js';
import { registerRemotePdf, remotePdfFile } from './remote-pdfs.js';

const MIME = {
	'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
	'.mjs': 'text/javascript', '.json': 'application/json',
	'.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
	'.avif': 'image/avif', '.pdf': 'application/pdf', '.woff': 'font/woff',
	'.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
	'.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
	'.m4a': 'audio/mp4', '.wav': 'audio/wav', '.txt': 'text/plain',
	'.md': 'text/plain', '.jmd': 'text/plain',
	// application/wasm lets WebAssembly.instantiateStreaming work (the
	// ZetaOffice module is 36 MB — the buffered fallback path hurts there).
	'.wasm': 'application/wasm',
};

export const PREVIEW_SCHEME = 'clew-preview';
/** The app page's own scheme (frame-bridge.md §2): `clew-app://app/…`. */
export const APP_SCHEME = 'clew-app';

/**
 * Must run before app.whenReady(). ONE call for every scheme: Electron allows
 * registerSchemesAsPrivileged once, and a second call risks the first
 * scheme's privileges. `standard` (a tuple origin, 'self' in a CSP),
 * `secure` (a secure context — the clipboard, and its delegation to the
 * office and Excalidraw frames), fetch, CORS and streaming; never
 * `bypassCSP`, no service workers, no code cache (yet).
 */
export function registerPreviewScheme() {
	const privileges = {
		standard: true,
		secure: true,
		supportFetchAPI: true,
		corsEnabled: true,
		stream: true,
	};
	protocol.registerSchemesAsPrivileged([
		{ scheme: PREVIEW_SCHEME, privileges },
		{ scheme: APP_SCHEME, privileges },
		// Apps in notes, each on an origin of its own (frame-bridge.md §7).
		{ scheme: FRAME_SCHEME, privileges },
	]);
}

/**
 * After app.whenReady(), before any window: the app page's files
 * (app-files.js — dist/renderer/ and nothing else, host `app` only) on the
 * DEFAULT session (the canvas webview partition never gets it). No caching:
 * dev hot reload and View → Reload come through here, and the asset stamp
 * does not follow renderer builds. The page itself carries its CSP as a
 * header too, with `frame-ancestors 'none'`: no frame may host the app.
 */
export function installAppProtocol({ rendererDir }) {
	protocol.handle(APP_SCHEME, async (request) => {
		const found = request.method === 'GET' ? appFileFor(rendererDir, request.url) : null;
		const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
		if (!found) return notFound();
		let body;
		try { body = fs.readFileSync(found.file); } catch { return notFound(); }
		const headers = { 'Content-Type': found.type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': APP_ORIGIN };
		if (found.isPage) headers['Content-Security-Policy'] = appPageCsp(body.toString('utf8'));
		return new Response(body, { headers });
	});
}

const RENDERED_SUFFIX = new RegExp(`(${NOTE_EXTENSIONS.map((e) => e.replace('.', '\\.')).join('|')})\\.html$`, 'i');

/**
 * After app.whenReady(), before any window: `clew-frame://<key>/…`, an app's
 * own folder and nothing else (frame-bridge.md §7). Served only for a key a
 * window registered (app-registry.js, as it served the note embedding it),
 * never under `/<sid>/`, never another app's files, every path clamped to
 * the folder by realpath. Every response carries the app's CSP (R2 + the
 * owner's choice A: everything 'self' unless `network` is granted), no ACAO
 * (its origin reads nothing of the vault), no referrer and no DNS
 * prefetching; HTML documents get the bridge client first in <head>. In a
 * vault this device has not trusted, an app the user has not allowed to run
 * is not served at all (R1, choice B).
 */
export function installFrameProtocol({ bridgeFile }) {
	protocol.handle(FRAME_SCHEME, async (request) => {
		const plain = (status, text) => new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'" } });
		let url;
		try { url = new URL(request.url); } catch { return plain(400, 'Bad request'); }
		if (request.method !== 'GET') return plain(405, 'GET only');
		const registered = appByKey(url.hostname);
		const session = registered ? sessionById(registered.sessionId) : null;
		if (!registered || !session?.vaults.isOpen) return plain(404, 'Not found');
		const state = stateOf(registered, !session.access.trusted);
		if (!state.mayRun) return plain(403, 'This app has not been allowed to run here.');
		const network = state.granted.includes('network') ? registered.manifest.network : null;
		const headers = (type) => ({
			'Content-Type': type,
			'Cache-Control': 'no-store',
			'Content-Security-Policy': appCsp({ network }),
			'Referrer-Policy': 'no-referrer',
			'X-DNS-Prefetch-Control': 'off',
			'X-Content-Type-Options': 'nosniff',
		});
		if (url.pathname === '/__clew_bridge__.js') {
			try { return new Response(fs.readFileSync(bridgeFile), { headers: headers('text/javascript; charset=utf-8') }); } catch { return plain(500, 'Bridge missing'); }
		}
		const file = appFile(registered.abs, url.pathname);
		if (!file) return plain(404, 'Not found');
		const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
		if (/^text\/html/.test(type)) {
			return new Response(injectBridge(fs.readFileSync(file, 'utf8')), { headers: headers('text/html; charset=utf-8') });
		}
		return new Response(fs.readFileSync(file), { headers: headers(type) });
	});
}

/** After app.whenReady(). */
export function installPreviewProtocol({ distDir, nodeModulesDir, engineAssetsDir, embedpdfDir, stampsDir = null, mptikzDir, zetaDir, noteFontsDir = null, globalPluginsDir = null }) {
	const assetRoots = {
		mathjax: path.join(nodeModulesDir, 'mathjax', 'es5'),
		mermaid: path.join(nodeModulesDir, 'mermaid', 'dist'),
		highlight: path.join(nodeModulesDir, 'highlight.js', 'styles'),
		fontawesome: path.join(nodeModulesDir, '@fortawesome', 'fontawesome-free', 'js'),
		jquery: path.join(nodeModulesDir, 'jquery', 'dist'),
		leaflet: path.join(nodeModulesDir, 'leaflet', 'dist'),
		// The EmbedPDF bundle + pdfium.wasm (the PDF viewer) — the vendored
		// OCG/layers build (vendor/embedpdf), not the npm package.
		embedpdf: embedpdfDir,
		// The stamp tool's default library (pdf-core.js points EmbedPDF here
		// rather than at its CDN): {locale}/manifest.json + stamps.pdf, a
		// committed copy (vendor/default-stamps, MIT).
		...(stampsDir ? { stamps: stampsDir } : {}),
		// mp-tikz-wasm: the MetaPost/TikZ engines and their TeX bundles
		// (paths.js#mptikzAssets). A first figure reads ~90 of these files
		// through kpathsea, so the whole tree is servable rather than a
		// closed set — it is read-only app payload, like embedpdf.
		mptikz: mptikzDir,
		// The note's typeface as font files, for `font=note` figures (main/
		// note-fonts.js): index.json plus one file per face, fetched by the
		// preview and handed to the TeX engine as bytes.
		...(noteFontsDir ? { notefonts: noteFontsDir } : {}),
		// Our own PDF viewer page + its bundle (pdf-page.html/.js).
		clewpdf: path.join(distDir, 'preview-client'),
		// ZetaOffice (LibreOffice wasm) bundle: soffice.{js,wasm,data,…} +
		// zeta.js, downloaded — never shipped (spike; see HANDOVER §0).
		zeta: zetaDir,
		// Our own ZetaOffice host page + bundle (zeta-page.html/.js + the
		// office-thread script that runs inside the LOWA worker).
		clewzeta: path.join(distDir, 'preview-client'),
		// Optional CJK fonts, downloaded on demand into userData.
		pdffonts: fontsDir(),
		// The Excalidraw editor page + its bundle (React lives only here).
		clewex: path.join(distDir, 'excalidraw'),
		// Excalidraw's own fonts and locale data, from our copy of the package
		// — window.EXCALIDRAW_ASSET_PATH points here so it never calls unpkg.
		excalidraw: path.join(nodeModulesDir, '@excalidraw', 'excalidraw', 'dist', 'prod'),
		preview: engineAssetsDir, // preview.css
	};

	const headers = (type) => ({
		'Content-Type': type,
		'Cache-Control': 'no-store',
		'Access-Control-Allow-Origin': '*',
	});

	const fileResponse = (absPath, extraHeaders = {}, rangeHeader = null) => {
		let stat = null;
		try { stat = fs.statSync(absPath); } catch { /* fall through to 404 */ }
		if (!stat?.isFile()) {
			// A brotli twin can stand in for the plain file: the downloaded
			// ZetaOffice bundle keeps its two big files compressed on disk
			// (~53 MB instead of 262 — see src/main/zeta-assets.js).
			// Decompressed here in a stream: Chromium does NOT decode a
			// Content-Encoding header on protocol.handle responses (measured
			// 2026-09-01 — raw brotli bytes reach the page), so the header
			// trick is a trap. Typed as the PLAIN name so soffice.wasm.br
			// still instantiates as wasm; Range is ignored (nothing that
			// ships compressed is range-read).
			try {
				if (fs.statSync(absPath + '.br').isFile()) {
					const type = MIME[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream';
					const stream = fs.createReadStream(absPath + '.br').pipe(zlib.createBrotliDecompress());
					return new Response(Readable.toWeb(stream), {
						headers: { ...headers(type), ...extraHeaders },
					});
				}
			} catch { /* no twin either */ }
			return new Response('Not found', { status: 404, headers: headers('text/plain') });
		}
		const type = MIME[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream';
		const base = { ...headers(type), 'Accept-Ranges': 'bytes', ...extraHeaders };

		// Byte ranges: Chromium's media stack refuses to scrub audio/video
		// (and moov-at-end MP4s can't even build a seek index) unless the
		// server honors Range. Single ranges only — all Chromium ever sends.
		const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
		if (m && (m[1] !== '' || m[2] !== '')) {
			const size = stat.size;
			let start, end;
			if (m[1] === '') { // suffix form "bytes=-N": the last N bytes
				start = Math.max(0, size - Number(m[2]));
				end = size - 1;
			} else {
				start = Number(m[1]);
				end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
			}
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
				|| start > end || start >= size) {
				return new Response(null,
					{ status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
			}
			return new Response(Readable.toWeb(fs.createReadStream(absPath, { start, end })), {
				status: 206,
				headers: {
					...base,
					'Content-Range': `bytes ${start}-${end}/${size}`,
					'Content-Length': String(end - start + 1),
				},
			});
		}
		return new Response(fs.readFileSync(absPath), { headers: base });
	};

	/**
	 * What every preview document gets on top of the engine's own template:
	 * the note API in <head> (so inline note scripts can use window.clew
	 * immediately), the client bridge at the end of <body>, then the vault
	 * scripts and the enabled preview-surface plugin scripts — what the
	 * DEVICE lets this vault run (session.access, vault-trust.js), never
	 * what the vault's own settings ask for. One function for notes and live
	 * edit's block documents, so the two cannot drift; a block is marked
	 * `data-clew-block` on its <html>, a restricted vault's document
	 * `data-clew-restricted` (the client marks a refused inline script).
	 */
	function wrapPreviewDocument(html, { session, sid, block = false, noteDir = '', notePath = null }) {
		// A note's own PDF frames go to Clew's viewer (pdf-frames-rewrite.js,
		// docs/dev/pdf-unification.md §3) — as the document is SERVED, so a
		// site export (which never comes through here) keeps the author's.
		// Web PDFs are REGISTERED for this session as they are met (§4): the
		// viewer is handed their hash, never the URL to fetch.
		html = rewritePdfFrames(html, { sid, noteDir, registerRemote: (url) => registerRemotePdf(session, url) }).html;
		const access = session.access;
		// `@app[…]` embeds: resolved and registered for this window (§7).
		html = rewriteAppEmbeds(html, { resolve: (target) => resolveFor(session, target), restricted: !access.trusted, notePath }).html;
		// Vault plugins load as ordinary vault files; global ones from
		// the __clew_plugin_file__ namespace (they are outside every
		// vault). Either way the script's own URL sits in its plugin
		// folder, so the house convention for loading a sibling —
		// `new URL('x.js', document.currentScript.src)`, what the
		// Charts plugin does — works in both scopes. (A bare relative
		// fetch resolves against the NOTE's URL, in both scopes.)
		const pluginTags = previewPluginScripts(session.vaults.root, access, globalPluginsDir)
			.map((p) => (p.vaultRel
				? `/${sid}/${p.vaultRel.split('/').map(encodeURIComponent).join('/')}`
				: `/__clew_plugin_file__/${sid}/${encodeURIComponent(p.id)}/${encodeURIComponent(p.file)}`))
			.map((src) => `<script src="${src}"></script>`)
			.join('');
		// Vault scripts: <vault>/.clew/scripts/*.js load into EVERY
		// rendered note (alphabetical) — shared custom elements and
		// helpers, the JS twin of the .clew/snippets CSS convention.
		// Same trust surface as the inline <script>s notes can already
		// carry; per-note "Script:" metadata still works alongside. Only in
		// a vault this device trusts, with its scripts on (§4.4).
		let vaultScriptTags = '';
		if (access.scripts) try {
			vaultScriptTags = fs.readdirSync(path.join(session.vaults.root, '.clew', 'scripts'))
				.filter((f) => f.endsWith('.js')).sort()
				.map((f) => `<script src="/${sid}/.clew/scripts/${encodeURIComponent(f)}"></script>`)
				.join('');
		} catch { /* no scripts folder */ }
		let out = html
			.replace(/<head([^>]*)>/i, `<head$1><script src="/__clew_preview__/api.js"></script>`)
			.replace(
				/<\/body>/i,
				`<script src="/__clew_preview__/client.js"></script>${vaultScriptTags}${pluginTags}</body>`,
			);
		if (block) out = out.replace(/<html([^>]*)>/i, '<html$1 data-clew-block="1">');
		if (!access.trusted) out = out.replace(/<html([^>]*)>/i, '<html$1 data-clew-restricted="1">');
		return out;
	}

	/**
	 * The headers a note document goes out with: the usual ones plus its CSP
	 * (preview-csp.js) — Clew's own scripts only in a vault this device has
	 * not trusted, the network closed unless the device opened it.
	 */
	async function noteHeaders(session) {
		const { trusted, network } = session.access;
		const hashes = trusted ? [] : await session.renderService.templateScriptHashes();
		const csp = previewCsp({ kind: 'note', trusted, network, hashes });
		return csp ? { ...headers('text/html'), 'Content-Security-Policy': csp } : headers('text/html');
	}

	const serve = async (request) => {
		try {
			const url = new URL(request.url);
			const pathname = decodeURIComponent(url.pathname).replace(/^\/+/, '');

			// Vendored assets and the preview client bundle.
			if (pathname.startsWith('__clew_assets__/')) {
				const rest = pathname.slice('__clew_assets__/'.length);
				// The PDF viewer asks for this on every open. Answering it here
				// (rather than writing a file) means the app setting is the only
				// switch: turn CJK fonts off and the viewer simply stops being
				// offered them, with no state to clean up.
				if (rest === 'pdffonts/fallback.json') {
					const config = fallbackConfig(settings.get('pdfCjkFonts') === true);
					if (!config) return new Response('null', { headers: headers('application/json') });
					return new Response(JSON.stringify(config), { headers: headers('application/json') });
				}
				const [root, ...restParts] = rest.split('/');
				const base = assetRoots[root];
				if (!base) return new Response('Unknown asset root', { status: 404, headers: headers('text/plain') });
				const abs = path.normalize(path.join(base, ...restParts));
				if (!abs.startsWith(base + path.sep)) {
					return new Response('Forbidden', { status: 403, headers: headers('text/plain') });
				}
				// Every other asset is served no-store (the default in
				// headers()), which is right for anything that can change
				// under the app. The TeX engines are the exception worth
				// making: a pinned, read-only build whose wasm Chromium can
				// only code-cache if it is allowed to store it, and whose
				// bundles a figure re-reads by the dozen.
				const extra = root === 'mptikz'
					? { 'Cache-Control': 'public, max-age=31536000, immutable' }
					: {};
				// What a figure actually fetched — the engines run in a Worker,
				// invisible to the preview document's resource timings, so a
				// smoke run counts here (smoke/README.md: "what the engines
				// fetched").
				if (process.env.CLEW_SMOKE_LOG && root === 'mptikz') console.log(`smoke-asset: ${rest}`);
				return fileResponse(abs, extra, request.headers.get('range'));
			}
			if (pathname.startsWith('__clew_preview__/')) {
				// A closed set: nothing outside dist/preview-client is servable.
				const known = new Set(['api.js', 'client.js', 'wa.js', 'wa.css']);
				const name = pathname.split('/').pop();
				const file = known.has(name) ? name : 'client.js';
				return fileResponse(path.join(distDir, 'preview-client', file));
			}

			// App-surface plugin scripts: /__clew_plugin_app__/<sid>/<id>.js.
			// The app's CSP has no unsafe-eval, so plugin code loads as a real
			// script from this namespace — served ONLY for plugins currently
			// enabled in the session's vault, wrapped so the body receives its
			// API object (window.__clewPluginApi, set by the loader) as `clew`.
			if (pathname.startsWith('__clew_plugin_app__/')) {
				const [, psid, pfile] = pathname.split('/');
				const pluginSession = sessionById(psid);
				const id = (pfile ?? '').replace(/\.js$/, '');
				if (!pluginSession?.vaults.isOpen) {
					return new Response('No session', { status: 503, headers: headers('text/plain') });
				}
				const plugin = enabledPlugins(pluginSession.vaults.root, pluginSession.access, globalPluginsDir)
					.find((p) => p.id === id && p.surfaces.app);
				if (!plugin) {
					return new Response('Not an enabled plugin', { status: 403, headers: headers('text/plain') });
				}
				// plugin.dir is the plugin's own folder, vault-local or global.
				const abs = path.join(plugin.dir, plugin.surfaces.app.file);
				const code = fs.readFileSync(abs, 'utf8');
				const wrapped = `(function (clew) {\n'use strict';\n${code}\n})(window.__clewPluginApi?.[${JSON.stringify(id)}]);`;
				return new Response(wrapped, { headers: headers('text/javascript') });
			}

			// Files inside a GLOBAL plugin's folder:
			// /__clew_plugin_file__/<sid>/<id>/<path>. A vault plugin's files
			// are ordinary vault content and need none of this; a global
			// plugin lives outside every vault, so its preview surface — and
			// any sibling it fetches (the Charts plugin loads chart.umd.js) —
			// is served from here. Gated on the plugin being ENABLED in that
			// session's vault, and clamped inside the plugin's own folder.
			if (pathname.startsWith('__clew_plugin_file__/')) {
				const segments = pathname.split('/').slice(1);
				const [psid, id, ...rest] = segments;
				const pluginSession = sessionById(psid);
				if (!pluginSession?.vaults.isOpen || !id || rest.length === 0) {
					return new Response('No session', { status: 503, headers: headers('text/plain') });
				}
				const plugin = enabledPlugins(pluginSession.vaults.root, pluginSession.access, globalPluginsDir)
					.find((p) => p.id === id && p.scope === 'global');
				if (!plugin) {
					return new Response('Not an enabled global plugin', { status: 403, headers: headers('text/plain') });
				}
				const abs = path.resolve(plugin.dir, rest.map(decodeURIComponent).join('/'));
				if (abs !== plugin.dir && !abs.startsWith(plugin.dir + path.sep)) {
					return new Response('Path escapes plugin', { status: 403, headers: headers('text/plain') });
				}
				return fileResponse(abs);
			}

			// Everything else is vault content: first segment is the session id.
			const slash = pathname.indexOf('/');
			const session = slash > 0 ? sessionById(pathname.slice(0, slash)) : null;
			const rel = slash > 0 ? pathname.slice(slash + 1) : '';
			if (!session || !session.vaults.isOpen || !rel) {
				return new Response('No vault for this session', { status: 503, headers: headers('text/plain') });
			}
			const { vaults, renderService } = session;

			// The render endpoints run the engine — script blocks execute — so
			// they run nothing for a caller without the session's token
			// (main/caller-token.js; docs/dev/frame-bridge.md §1): only the
			// app page and the preview documents it hands the token to may use
			// them, and no header can say which caller is which (this handler
			// sees no Origin on these POSTs, measured). The Origin guard stays
			// as a second layer. The body is JSON `{token, text, sourcePath?}`.
			const readRender = async () => {
				// The second layer under the token: an Origin, where one comes,
				// must be the app page's or a preview document's (§2.6).
				if (!renderOriginAllowed(request.headers.get('origin') ?? '')) return { status: 403, message: 'Forbidden' };
				return readRenderBody(await request.text(), session.callerToken);
			};
			const refuse = ({ status, message }) =>
				new Response(message, { status, headers: headers('text/plain') });

			// Canvas-card fragment rendering: POST `{token, text}`, get body HTML.
			if (rel === '__clew_fragment__' && request.method === 'POST') {
				const body = await readRender();
				if (body.status) return refuse(body);
				const html = rewriteAppEmbeds(rewritePdfFrames(await renderService.renderFragment(body.text), {
					sid: pathname.slice(0, slash), registerRemote: (url) => registerRemotePdf(session, url),
				}).html, { resolve: (target) => resolveFor(session, target), restricted: !session.access.trusted, notePath: null }).html;
				return new Response(html, { headers: headers('text/html') });
			}

			// Live edit's block frames (docs/dev/live-edit.md §7.2). POST
			// `{token, text, sourcePath}` renders the snippet as a full preview
			// document and answers `{hash}`; GET `__clew_block__/<hash>` serves
			// that document with the same client injection a note gets, marked
			// `data-clew-block` so the client reports its size instead of its
			// scroll. Same token check and size limit as fragments; the GET's
			// capability is its unguessable path, as every preview URL's is. An
			// evicted hash is a 404: the caller POSTs again.
			if (rel === '__clew_block__' && request.method === 'POST') {
				const body = await readRender();
				if (body.status) return refuse(body);
				const { text, sourcePath } = body;
				if (sourcePath !== null) {
					try { vaults.resolve(sourcePath); } catch {
						return new Response('Forbidden', { status: 403, headers: headers('text/plain') });
					}
				}
				const hash = await renderService.renderBlock(text, { sourcePath });
				return new Response(JSON.stringify({ hash }), { headers: headers('application/json') });
			}
			if (rel.startsWith('__clew_block__/') && request.method === 'GET') {
				const html = renderService.blockDocument(rel.slice('__clew_block__/'.length));
				if (html === undefined) {
					return new Response('Not found', { status: 404, headers: headers('text/plain') });
				}
				const blockKey = rel.slice('__clew_block__/'.length);
				const blockNote = renderService.blockSourcePath(blockKey);
				const injected = wrapPreviewDocument(html, {
					session, sid: pathname.slice(0, slash), block: true,
					noteDir: blockNote ? path.posix.dirname(blockNote).replace(/^\.$/, '') : '',
					notePath: blockNote,
				});
				return new Response(injected, { headers: await noteHeaders(session) });
			}

			// A web PDF a render registered (remote-pdfs.js; pdf-unification.md
			// §4): GET only, served from the DEVICE cache, and ONLY for a hash
			// this session's renders registered — 404 for anything else, so no
			// page can name a URL for Clew to fetch. `?reload=1` refetches now.
			// A failure with no copy to fall back on is a 502 whose JSON body
			// names it; a copy served after a failed refetch says so in
			// X-Clew-Remote-Error. X-Clew-Remote-Fetched dates the copy.
			if (rel.startsWith('__clew_remote_pdf__/')) {
				if (request.method !== 'GET') return new Response('GET only', { status: 405, headers: headers('text/plain') });
				const key = rel.slice('__clew_remote_pdf__/'.length);
				if (!/^[0-9a-f]{64}$/.test(key)) return new Response('Not found', { status: 404, headers: headers('text/plain') });
				let got;
				try {
					got = await remotePdfFile(session, key, { reload: url.searchParams.get('reload') === '1' });
				} catch (err) {
					return new Response(JSON.stringify({ error: err.code ?? 'network', message: String(err.message ?? err) }),
						{ status: 502, headers: headers('application/json') });
				}
				if (!got) return new Response('Not registered in this session', { status: 404, headers: headers('text/plain') });
				const extra = { 'Content-Type': 'application/pdf', 'X-Clew-Remote-Fetched': new Date(got.meta.fetchedAt).toISOString() };
				if (got.error) extra['X-Clew-Remote-Error'] = encodeURIComponent(`${got.error.code ?? 'network'}: ${got.error.message}`);
				return fileResponse(got.file, extra, request.headers.get('range'));
			}

			// Rendered note: "<note path>.html" → render on demand, inject client.
			if (RENDERED_SUFFIX.test(rel)) {
				const relPath = rel.replace(/\.html$/i, '');
				vaults.resolve(relPath); // path-escape validation
				let html;
				try {
					const htmlFile = await renderService.ensureRendered(relPath);
					html = fs.readFileSync(htmlFile, 'utf8');
				} catch (err) {
					// First render failed — an error document that still loads the
					// client, so the pane shows the error and recovers on rebuild.
					html = `<!DOCTYPE html><html><head><meta charset="utf-8">`
						+ `<link rel="stylesheet" href="/__clew_assets__/preview/preview.css"></head>`
						+ `<body><div id="__clew_err">${String(err.message ?? err)
							.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div></body></html>`;
				}
				const injected = wrapPreviewDocument(html, {
					session, sid: pathname.slice(0, slash),
					noteDir: path.posix.dirname(relPath).replace(/^\.$/, ''),
					notePath: relPath,
				});
				return new Response(injected, { headers: await noteHeaders(session) });
			}

			// A vault PDF asked for as a DOCUMENT — a frame navigating to it,
			// whatever put the frame there (a note's own script, a link) — goes
			// to EmbedPDF's viewer page instead (pdf-unification.md §6). Dropping
			// `plugins: true` does NOT turn Chromium's own viewer off (Electron
			// 43, measured 2026-09-30: a raw PDF iframe still rendered, nothing
			// downloaded), so this, not a download guard, is what keeps EmbedPDF
			// the one viewer of a vault PDF. A navigation is told from the
			// viewer's own fetch by its Accept (`text/html,…` against `*/*`;
			// Sec-Fetch-Dest is not sent on this scheme). The redirect keeps a
			// `#page=N`, which pdf-page.js reads. Every Clew surface reaches the
			// viewer before this, so in dev and smoke a catch is logged as
			// `smoke-pdf-leak:` and the sweep asserts there are none.
			if (/\.pdf$/i.test(rel) && /^text\/html\b/i.test(request.headers.get('accept') ?? '')) {
				const file = vaults.resolve(rel);
				if (fs.existsSync(file)) {
					if (process.env.CLEW_SMOKE || !app.isPackaged) console.log(`smoke-pdf-leak: ${request.url}`);
					return new Response(null, { status: 302, headers: { Location: viewerUrl(pathname.slice(0, slash), rel) } });
				}
			}

			// Anything else: the real file from the vault (relative images etc.).
			// A document that can carry script (HTML, SVG, XML) goes out with
			// the vault-HTML CSP: in a restricted vault it draws and runs
			// nothing; anywhere, its network follows the vault's (§4.4, §4.9).
			// (As an <img>, an SVG runs nothing and the header is ignored.)
			const vaultCsp = isScriptableDocument(rel)
				? previewCsp({ kind: 'vault', trusted: session.access.trusted, network: session.access.network })
				: null;
			return fileResponse(vaults.resolve(rel), vaultCsp ? { 'Content-Security-Policy': vaultCsp } : {}, request.headers.get('range'));
		} catch (err) {
			// A link out of a vault this device has not trusted (vault.js#
			// resolve): refused by name, never served.
			if (err?.code === 'ELEAVES') {
				return new Response(String(err.message), { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Clew-Refused': 'leaves-vault' } });
			}
			return new Response(`Preview error: ${String(err.message ?? err)}`,
				{ status: 500, headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } });
		}
	};
	// Every response leaves through the one rule for who may read it across
	// origins (preview-cors.js): the app page, `clew-app://app`, as a
	// constant; preview documents are same-origin; nothing else reads.
	protocol.handle(PREVIEW_SCHEME, async (request) => narrowCors(await serve(request)));
}
