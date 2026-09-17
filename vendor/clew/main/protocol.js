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
import { protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { NOTE_EXTENSIONS } from '../shared/channels.js';
import { sessionById } from './session.js';
import { previewPluginScripts, enabledPlugins } from './plugins.js';
import { settings } from './settings.js';
import { fontsDir, fallbackConfig } from './pdf-fonts.js';

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

/** Must run before app.whenReady(). */
export function registerPreviewScheme() {
	protocol.registerSchemesAsPrivileged([{
		scheme: PREVIEW_SCHEME,
		privileges: {
			standard: true,
			secure: true,
			supportFetchAPI: true,
			corsEnabled: true,
			stream: true,
		},
	}]);
}

const RENDERED_SUFFIX = new RegExp(`(${NOTE_EXTENSIONS.map((e) => e.replace('.', '\\.')).join('|')})\\.html$`, 'i');

/** After app.whenReady(). */
export function installPreviewProtocol({ distDir, nodeModulesDir, engineAssetsDir, embedpdfDir, mptikzDir, zetaDir, globalPluginsDir = null }) {
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
		// mp-tikz-wasm: the MetaPost/TikZ engines and their TeX bundles
		// (paths.js#mptikzAssets). A first figure reads ~90 of these files
		// through kpathsea, so the whole tree is servable rather than a
		// closed set — it is read-only app payload, like embedpdf.
		mptikz: mptikzDir,
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

	protocol.handle(PREVIEW_SCHEME, async (request) => {
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
				const vaultSettings = pluginSession.vaults.loadState('vault-settings.json') ?? {};
				const plugin = enabledPlugins(pluginSession.vaults.root, vaultSettings, globalPluginsDir)
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
				const vaultSettings = pluginSession.vaults.loadState('vault-settings.json') ?? {};
				const plugin = enabledPlugins(pluginSession.vaults.root, vaultSettings, globalPluginsDir)
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

			// Canvas-card fragment rendering: POST markdown text, get body HTML.
			// Origin-guarded: only the app (file:// sends "null") and preview
			// documents (same scheme) may use it — a web page framed inside a
			// canvas web node must NOT reach the engine (script blocks execute).
			if (rel === '__clew_fragment__' && request.method === 'POST') {
				const origin = request.headers.get('origin') ?? '';
				if (/^https?:/i.test(origin)) {
					return new Response('Forbidden', { status: 403, headers: headers('text/plain') });
				}
				const text = await request.text();
				if (text.length > 100_000) {
					return new Response('Too large', { status: 413, headers: headers('text/plain') });
				}
				const html = await renderService.renderFragment(text);
				return new Response(html, { headers: headers('text/html') });
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
				// The note API loads in <head> so inline note scripts can use
				// window.clew immediately; the client bridge loads at end of body,
				// followed by any enabled preview-surface plugin scripts (served
				// as ordinary vault files from .clew/plugins/).
				const vaultSettings = session.vaults.loadState('vault-settings.json') ?? {};
				const sid = pathname.slice(0, slash);
				// Vault plugins load as ordinary vault files; global ones from
				// the __clew_plugin_file__ namespace (they are outside every
				// vault). Either way the script's own URL sits in its plugin
				// folder, so the house convention for loading a sibling —
				// `new URL('x.js', document.currentScript.src)`, what the
				// Charts plugin does — works in both scopes. (A bare relative
				// fetch resolves against the NOTE's URL, in both scopes.)
				const pluginTags = previewPluginScripts(session.vaults.root, vaultSettings, globalPluginsDir)
					.map((p) => (p.vaultRel
						? `/${sid}/${p.vaultRel.split('/').map(encodeURIComponent).join('/')}`
						: `/__clew_plugin_file__/${sid}/${encodeURIComponent(p.id)}/${encodeURIComponent(p.file)}`))
					.map((src) => `<script src="${src}"></script>`)
					.join('');
				// Vault scripts: <vault>/.clew/scripts/*.js load into EVERY
				// rendered note (alphabetical) — shared custom elements and
				// helpers, the JS twin of the .clew/snippets CSS convention.
				// Same trust surface as the inline <script>s notes can already
				// carry; per-note "Script:" metadata still works alongside.
				let vaultScriptTags = '';
				try {
					vaultScriptTags = fs.readdirSync(path.join(session.vaults.root, '.clew', 'scripts'))
						.filter((f) => f.endsWith('.js')).sort()
						.map((f) => `<script src="/${sid}/.clew/scripts/${encodeURIComponent(f)}"></script>`)
						.join('');
				} catch { /* no scripts folder */ }
				const injected = html
					.replace(/<head([^>]*)>/i, `<head$1><script src="/__clew_preview__/api.js"></script>`)
					.replace(
						/<\/body>/i,
						`<script src="/__clew_preview__/client.js"></script>${vaultScriptTags}${pluginTags}</body>`,
					);
				return new Response(injected, { headers: headers('text/html') });
			}

			// Anything else: the real file from the vault (relative images etc.).
			return fileResponse(vaults.resolve(rel), {}, request.headers.get('range'));
		} catch (err) {
			return new Response(`Preview error: ${String(err.message ?? err)}`,
				{ status: 500, headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } });
		}
	});
}
