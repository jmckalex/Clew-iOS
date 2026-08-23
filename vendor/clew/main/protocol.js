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
import { Readable } from 'node:stream';
import { NOTE_EXTENSIONS } from '../shared/channels.js';
import { sessionById } from './session.js';
import { previewPluginPaths, enabledPlugins } from './plugins.js';

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
export function installPreviewProtocol({ distDir, nodeModulesDir, engineAssetsDir }) {
	const assetRoots = {
		mathjax: path.join(nodeModulesDir, 'mathjax', 'es5'),
		mermaid: path.join(nodeModulesDir, 'mermaid', 'dist'),
		highlight: path.join(nodeModulesDir, 'highlight.js', 'styles'),
		fontawesome: path.join(nodeModulesDir, '@fortawesome', 'fontawesome-free', 'js'),
		jquery: path.join(nodeModulesDir, 'jquery', 'dist'),
		leaflet: path.join(nodeModulesDir, 'leaflet', 'dist'),
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
				const [root, ...restParts] = rest.split('/');
				const base = assetRoots[root];
				if (!base) return new Response('Unknown asset root', { status: 404, headers: headers('text/plain') });
				const abs = path.normalize(path.join(base, ...restParts));
				if (!abs.startsWith(base + path.sep)) {
					return new Response('Forbidden', { status: 403, headers: headers('text/plain') });
				}
				return fileResponse(abs, {}, request.headers.get('range'));
			}
			if (pathname.startsWith('__clew_preview__/')) {
				const file = pathname.endsWith('/api.js') ? 'api.js' : 'client.js';
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
				const plugin = enabledPlugins(pluginSession.vaults.root, vaultSettings)
					.find((p) => p.id === id && p.surfaces.app);
				if (!plugin) {
					return new Response('Not an enabled plugin', { status: 403, headers: headers('text/plain') });
				}
				const abs = path.join(pluginSession.vaults.root, '.clew', 'plugins', id, plugin.surfaces.app.file);
				const code = fs.readFileSync(abs, 'utf8');
				const wrapped = `(function (clew) {\n'use strict';\n${code}\n})(window.__clewPluginApi?.[${JSON.stringify(id)}]);`;
				return new Response(wrapped, { headers: headers('text/javascript') });
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
				const pluginTags = previewPluginPaths(session.vaults.root, vaultSettings)
					.map((p) => `<script src="/${sid}/${p.split('/').map(encodeURIComponent).join('/')}"></script>`)
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
