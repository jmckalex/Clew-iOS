// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Canvas node content builders. Content is inert by default (pointer-events
// none) so the canvas owns dragging; a double-clicked ("engaged") node turns
// its content interactive. Note embeds are live jmarkdown previews — the
// canvas view drives their render subscription and postMessage traffic.
import { fileKind } from '../lib/file-types.js';
import { vaultFileUrl } from '../lib/preview-url.js';
import { isNotePath } from '../state/vault-store.js';
import { previewUrl, fragmentUrl, previewOrigin } from '../lib/preview-url.js';
import { renderCardHtml } from './card-markdown.js';
import { typesetMath } from '../lib/mathjax.js';
import { openWikilink } from '../commands/actions.js';
import { buildPortal } from './portal.js';
import { ipc, CH } from '../ipc.js';

/**
 * Fill a card's content element from its raw text. Two passes: the tiny
 * synchronous renderer paints instantly, then the real engine render (a
 * fragment build — full jmarkdown: math, alerts, containers, footnotes)
 * swaps in when it lands. dataset.cardText is the staleness guard.
 */
export function setCardText(el, text) {
	el.dataset.cardText = text ?? '';
	el.classList.remove('is-engine');
	el.innerHTML = renderCardHtml(text ?? '');
	upgradeCard(el, text ?? '');
}

async function upgradeCard(el, text) {
	if (!text.trim()) return;
	try {
		const response = await fetch(fragmentUrl(), { method: 'POST', body: text });
		if (!response.ok) return;
		const html = await response.text();
		if (el.dataset.cardText !== text || !el.isConnected) return; // stale
		// Engine HTML manages its own block spacing; the pre-wrap that the
		// line-based fallback needs would render its formatting newlines as
		// literal blank space (huge gaps between blocks).
		el.classList.add('is-engine');
		el.innerHTML = html;
		// The engine emits root-relative vault URLs (media embeds in cards);
		// the app window is file://, so pin them to the preview origin.
		for (const media of el.querySelectorAll('[src^="/"]')) {
			media.setAttribute('src', previewOrigin() + media.getAttribute('src'));
		}
		typesetMath(el).catch(() => {});
	} catch {
		// Engine unavailable or build failed — the instant render stands.
	}
}

export function nodeTitle(node) {
	if (node.type === 'file') return node.file.split('/').pop();
	if (node.type === 'link') {
		try { return new URL(node.url).host || node.url; } catch { return node.url; }
	}
	if (node.type === 'group') return node.label ?? 'Group';
	return '';
}

/**
 * Build the content element for a node. For note embeds, `embedHooks.register`
 * is called with (nodeId, iframe, path) so the view can wire live rendering.
 */
export function buildNodeContent(node, embedHooks) {
	if (node.type === 'text') {
		const el = document.createElement('div');
		el.className = 'canvas-text';
		setCardText(el, node.text);
		// Links are clickable once the card is engaged (double-click). Both
		// renderers' shapes: card-markdown emits card-wikilink/card-extlink,
		// the engine emits internal-link[data-href] and plain external hrefs.
		el.addEventListener('click', (e) => {
			const link = e.target.closest('a');
			if (!link) return;
			e.preventDefault();
			if (link.dataset.href) {
				openWikilink(link.dataset.href, { newTab: true });
				return;
			}
			const url = link.dataset.url ?? link.getAttribute('href') ?? '';
			if (/^https?:/i.test(url)) {
				ipc.invoke(CH.SHELL_OPEN_EXTERNAL, { url }).catch(() => {});
			}
		});
		return el;
	}

	if (node.type === 'group') {
		const el = document.createElement('div');
		el.className = 'canvas-group-label';
		el.textContent = node.label ?? '';
		return el;
	}

	if (node.type === 'link') {
		const wrap = document.createElement('div');
		wrap.className = 'canvas-embed';
		const webview = document.createElement('webview');
		webview.className = 'canvas-webview';
		webview.setAttribute('partition', 'persist:clew-canvas');
		webview.setAttribute('src', node.url);

		// Loading spinner: shown from attach until the page settles, and again
		// during in-page navigations.
		const loading = document.createElement('div');
		loading.className = 'canvas-web-loading';
		const ring = document.createElement('div');
		ring.className = 'canvas-web-spinner';
		loading.append(ring);
		webview.addEventListener('did-stop-loading', () => { loading.hidden = true; });

		// Load-failure chrome (offline, bad host): overlay with a retry.
		const error = document.createElement('div');
		error.className = 'canvas-web-error';
		error.hidden = true;
		const message = document.createElement('div');
		message.className = 'canvas-web-error-text';
		const retry = document.createElement('button');
		retry.className = 'canvas-web-retry';
		retry.textContent = 'Retry';
		retry.addEventListener('click', () => {
			error.hidden = true;
			try { webview.reload(); } catch { webview.setAttribute('src', node.url); }
		});
		error.append(message, retry);
		webview.addEventListener('did-fail-load', (e) => {
			if (e.errorCode === -3 || e.isMainFrame === false) return; // aborted / subframe
			message.textContent = `Couldn’t load ${node.url}${e.errorDescription ? ` (${e.errorDescription})` : ''}`;
			error.hidden = false;
			loading.hidden = true;
		});
		webview.addEventListener('did-start-loading', () => {
			error.hidden = true;
			loading.hidden = false;
		});

		wrap.append(webview, loading, error, titleBar(node));
		return wrap;
	}

	// file nodes
	const path = node.file;
	const wrap = document.createElement('div');
	wrap.className = 'canvas-embed';
	if (path?.toLowerCase().endsWith('.canvas')) {
		// Portal: a live, read-only miniature of another canvas. Built async
		// once attached (it needs the box size); the view rebuilds it on
		// file change. Double-click opens the real canvas.
		const portal = document.createElement('div');
		portal.className = 'canvas-portal';
		queueMicrotask(() => buildPortal(portal, path));
		wrap.append(portal, titleBar(node));
		return wrap;
	}
	if (isNotePath(path)) {
		const iframe = document.createElement('iframe');
		// Unsandboxed like every preview frame (PDF embeds inside notes);
		// isolation comes from the clew-preview:// origin. See CLAUDE.md.
		iframe.className = 'canvas-note-frame';
		iframe.src = previewUrl(path);
		wrap.append(iframe, titleBar(node));
		embedHooks?.register?.(node.id, iframe, path);
		return wrap;
	}
	const kind = fileKind(path);
	const url = vaultFileUrl(path);
	if (kind === 'image') {
		const img = document.createElement('img');
		img.className = 'canvas-image';
		img.src = url;
		img.draggable = false;
		wrap.append(img);
	} else if (kind === 'pdf') {
		const iframe = document.createElement('iframe');
		iframe.className = 'canvas-pdf-frame';
		iframe.src = url;
		wrap.append(iframe, titleBar(node));
	} else if (kind === 'audio') {
		const audio = document.createElement('audio');
		audio.controls = true;
		audio.src = url;
		wrap.append(audio, titleBar(node));
	} else if (kind === 'video') {
		const video = document.createElement('video');
		video.controls = true;
		video.src = url;
		wrap.append(video, titleBar(node));
	} else {
		const missing = document.createElement('div');
		missing.className = 'canvas-missing';
		missing.textContent = path ? `No viewer for ${path}` : 'Missing file';
		wrap.append(missing, titleBar(node));
	}
	return wrap;
}

function titleBar(node) {
	const bar = document.createElement('div');
	bar.className = 'canvas-node-title';
	bar.textContent = nodeTitle(node);
	return bar;
}

/** A stable content identity — when this changes, content must be rebuilt. */
export function contentKey(node) {
	if (node.type === 'file') return `file:${node.file}`;
	if (node.type === 'link') return `link:${node.url}`;
	return node.type;
}
