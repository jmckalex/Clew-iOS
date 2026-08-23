// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Read-only canvas embeds in rendered notes: ![[X.canvas]] emits a shell div
// (see src/engine/wikilinks.js); this module fetches the canvas JSON over the
// same clew-preview:// origin and renders the scene — cards, file nodes, live
// note previews (nested iframes), web links, groups, edges, ink, and shapes —
// scaled to fit the note column. The host posts {type:'canvas-changed'} when
// a .canvas file changes and the scene rebuilds in place.
import { parseCanvas, canvasBounds, nodeRect } from '../renderer/canvas/canvas-model.js';
import { shapeSvg, edgeSvg, strokeSvg, escapeXml } from '../renderer/canvas/shape-svg.js';
import { renderCardHtml } from '../renderer/canvas/card-markdown.js';

// Nesting guard: a canvas embed renders note nodes as iframes (?cdepth=N+1);
// inside those, canvas embeds render as a plain title box, so a canvas that
// embeds a note that embeds the canvas terminates instead of recursing.
const DEPTH = Number(new URLSearchParams(location.search).get('cdepth') ?? 0);
const SID = location.pathname.replace(/^\/+/, '').split('/')[0];

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;
const AUDIO_EXT = /\.(mp3|m4a|wav|ogg|flac)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov)$/i;
const NOTE_EXT = /\.(md|jmd)$/i;

const sitePath = (rel) => `/${SID}/` + rel.split('/').map(encodeURIComponent).join('/');
const MAX_SCENE_H = 480;

export function initCanvasEmbeds() {
	for (const embed of document.querySelectorAll('.canvas-embed[data-canvas-path]')) {
		const scene = embed.querySelector('.canvas-embed-scene');
		if (!scene || scene.dataset.built) continue;
		scene.dataset.built = '1';
		const rel = decodeURIComponent(
			embed.dataset.canvasPath.replace(/^\/+/, '').split('/').slice(1).join('/'));
		scene.dataset.canvasRel = rel;
		if (DEPTH >= 1) {
			scene.classList.add('is-deep');
			scene.textContent = '(open the canvas to view it)';
			continue;
		}
		buildScene(embed, scene).catch((err) => {
			scene.textContent = `(canvas failed to load: ${err.message})`;
		});
	}
}

/** A .canvas file changed on disk — rebuild every embed showing it. */
export function refreshCanvasEmbeds(vaultPath) {
	for (const scene of document.querySelectorAll('.canvas-embed-scene[data-canvas-rel]')) {
		if (scene.dataset.canvasRel !== vaultPath || DEPTH >= 1) continue;
		const embed = scene.closest('.canvas-embed');
		buildScene(embed, scene).catch(() => {});
	}
}

async function buildScene(embed, scene) {
	const response = await fetch(embed.dataset.canvasPath);
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const doc = parseCanvas(await response.text());
	const bounds = canvasBounds(doc);
	scene.replaceChildren();
	if (!bounds) {
		scene.classList.add('is-empty');
		scene.textContent = '(empty canvas)';
		return;
	}
	scene.classList.remove('is-empty');

	const pad = 30;
	const view = {
		x: bounds.x - pad, y: bounds.y - pad,
		width: bounds.width + pad * 2, height: bounds.height + pad * 2,
	};
	const width = scene.clientWidth || embed.clientWidth || 600;
	scene.style.height = `${Math.round(view.height * Math.min(width / view.width, MAX_SCENE_H / view.height, 1))}px`;
	scene._view = view;

	const world = document.createElement('div');
	world.className = 'canvas-embed-world';
	scene._world = world;
	// A live rebuild keeps the camera the reader panned/zoomed to.
	if (!scene._cam) scene._cam = fitCam(scene);
	applyCam(scene);

	const { x: bx, y: by, width: bw, height: bh } = view;
	const svgLayer = (cls) => {
		const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		el.setAttribute('class', cls);
		el.setAttribute('viewBox', `${bx} ${by} ${bw} ${bh}`);
		el.style.cssText = `position:absolute;left:${bx}px;top:${by}px;width:${bw}px;height:${bh}px;overflow:visible;pointer-events:none`;
		return el;
	};

	// Layer order matches the canvas view: groups, edges, nodes, ink+shapes.
	const groups = doc.nodes.filter((n) => n.type === 'group');
	const others = doc.nodes.filter((n) => n.type !== 'group');
	for (const node of groups) world.append(groupEl(node));

	const edges = svgLayer('canvas-embed-edges');
	const byId = new Map(doc.nodes.map((n) => [n.id, n]));
	edges.innerHTML = doc.edges
		.map((edge) => {
			const from = byId.get(edge.fromNode);
			const to = byId.get(edge.toNode);
			return from && to ? edgeSvg(edge, from, to, false, doc.edgeStyles?.[edge.id]) : '';
		})
		.join('');
	world.append(edges);

	for (const node of others) world.append(nodeEl(node, doc.nodeStyles?.[node.id]));

	const ink = svgLayer('canvas-embed-ink');
	ink.innerHTML = doc.strokes.map((stroke) => strokeSvg(stroke)).join('')
		+ doc.shapes.map((shape) => shapeSvg(shape, false)).join('');
	world.append(ink);

	scene.append(world);
	wireInteraction(scene);
}

// ---- read-only camera: scroll pans, pinch/⌘-scroll zooms at the cursor,
// dragging empty background pans, double-click refits ----------------------

function fitCam(scene) {
	const view = scene._view;
	const w = scene.clientWidth || 600;
	const h = scene.clientHeight || Math.round(view.height);
	const z = Math.min(w / view.width, h / view.height, 1);
	return {
		x: view.x - (w / z - view.width) / 2,
		y: view.y - (h / z - view.height) / 2,
		z,
	};
}

function applyCam(scene) {
	const { x, y, z } = scene._cam;
	scene._world.style.transform = `scale(${z}) translate(${-x}px, ${-y}px)`;
}

function wireInteraction(scene) {
	if (scene.dataset.wired) return;
	scene.dataset.wired = '1';

	scene.addEventListener('wheel', (e) => {
		e.preventDefault();
		const cam = scene._cam;
		if (e.ctrlKey || e.metaKey) {
			// Zoom at the cursor: the world point under it stays put.
			const rect = scene.getBoundingClientRect();
			const px = e.clientX - rect.left, py = e.clientY - rect.top;
			const wx = cam.x + px / cam.z, wy = cam.y + py / cam.z;
			cam.z = Math.min(4, Math.max(0.05, cam.z * Math.exp(-e.deltaY * 0.01)));
			cam.x = wx - px / cam.z;
			cam.y = wy - py / cam.z;
		} else {
			cam.x += e.deltaX / cam.z;
			cam.y += e.deltaY / cam.z;
		}
		applyCam(scene);
	}, { passive: false });

	scene.addEventListener('pointerdown', (e) => {
		// Node content stays interactive (scroll a note, click a link, play a
		// video); only empty background drags the camera.
		if (e.button !== 0 || e.target.closest('.canvas-embed-node')) return;
		e.preventDefault();
		const cam = scene._cam;
		const start = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
		scene.setPointerCapture(e.pointerId);
		scene.classList.add('is-panning');
		const move = (ev) => {
			cam.x = start.cx - (ev.clientX - start.x) / cam.z;
			cam.y = start.cy - (ev.clientY - start.y) / cam.z;
			applyCam(scene);
		};
		const up = () => {
			scene.classList.remove('is-panning');
			scene.removeEventListener('pointermove', move);
			scene.removeEventListener('pointerup', up);
		};
		scene.addEventListener('pointermove', move);
		scene.addEventListener('pointerup', up);
	});

	scene.addEventListener('dblclick', (e) => {
		if (e.target.closest('.canvas-embed-node')) return;
		scene._cam = fitCam(scene);
		applyCam(scene);
	});
}

function groupEl(node) {
	const el = document.createElement('div');
	el.className = 'canvas-embed-group';
	place(el, nodeRect(node));
	if (node.label) {
		const label = document.createElement('span');
		label.textContent = node.label;
		el.append(label);
	}
	return el;
}

function nodeEl(node, nstyle) {
	const el = document.createElement('div');
	el.className = 'canvas-embed-node';
	if (node.color) el.dataset.color = node.color;
	if (nstyle?.shape) el.dataset.nshape = nstyle.shape;
	if (nstyle?.border) el.dataset.nborder = nstyle.border;
	if (nstyle?.bg === 'transparent') el.classList.add('is-bg-transparent');
	if (nstyle?.opacity) el.style.opacity = nstyle.opacity;
	place(el, nodeRect(node));

	if (node.type === 'text') {
		el.classList.add('is-card');
		el.innerHTML = renderCardHtml(node.text ?? '');
		upgradeCard(el, node.text ?? '');
	} else if (node.type === 'link') {
		// A real embedded page where the site allows framing (an <iframe>
		// honors X-Frame-Options; the app's canvas uses <webview>, which is
		// unavailable inside preview iframes). Sandboxed: allow-popups lets
		// target=_blank links reach the window-open handler in main, which —
		// exactly like canvas webviews — sends them to the system browser and
		// denies the popup. Same-tab links navigate the iframe in place.
		el.classList.add('is-web');
		const url = escapeXml(node.url);
		el.innerHTML = `<div class="canvas-embed-webbar"><a href="${url}">${url}</a></div>`
			+ `<iframe src="${url}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>`;
	} else if (node.type === 'file' && node.file) {
		const src = sitePath(node.file);
		if (IMAGE_EXT.test(node.file)) {
			el.innerHTML = `<img src="${src}" alt="">`;
		} else if (node.file.toLowerCase().endsWith('.pdf')) {
			el.innerHTML = `<embed src="${src}" type="application/pdf">`;
		} else if (VIDEO_EXT.test(node.file)) {
			el.innerHTML = `<video controls src="${src}"></video>`;
		} else if (AUDIO_EXT.test(node.file)) {
			el.innerHTML = `<audio controls src="${src}"></audio>`;
		} else if (NOTE_EXT.test(node.file)) {
			// A live nested note preview; cdepth breaks embed cycles. The
			// class marks it trusted for the message relay below — external
			// web iframes never get it.
			el.innerHTML = `<iframe class="canvas-embed-note-frame" src="${src}.html?cdepth=${DEPTH + 1}"></iframe>`;
		} else {
			el.classList.add('is-chip');
			el.innerHTML = `<span>${escapeXml(node.file.split('/').pop())}</span>`;
		}
	}
	return el;
}

function place(el, r) {
	el.style.left = `${r.x}px`;
	el.style.top = `${r.y}px`;
	el.style.width = `${r.width}px`;
	el.style.height = `${r.height}px`;
}

// Swap in the engine's fragment render (full jmarkdown — math, alerts,
// containers) once it lands; the instant card-markdown pass stands until
// then, and remains the fallback if the build fails. MathJax is already
// loaded in preview documents, so cards typeset like note math.
async function upgradeCard(el, text) {
	if (!text.trim()) return;
	try {
		const response = await fetch(`/${SID}/__clew_fragment__`, { method: 'POST', body: text });
		if (!response.ok) return;
		const html = await response.text();
		if (!el.isConnected) return;
		el.innerHTML = html;
		if (/\$|\\\(|\\\[/.test(el.textContent ?? '')) {
			window.MathJax?.typesetPromise?.([el]).catch(() => {});
		}
	} catch { /* instant render stands */ }
}

/** The app theme changed — push it into nested note iframes too. */
export function broadcastThemeToNested(theme) {
	for (const frame of document.querySelectorAll('iframe.canvas-embed-note-frame')) {
		frame.contentWindow?.postMessage(
			{ source: 'clew-preview-host', type: 'theme', theme }, '*');
	}
}

// Nested note iframes talk clew-preview protocol at us (their parent): greet
// them with the theme, and relay link clicks upward so they open app tabs.
// ONLY note frames are trusted — an external site framed in a web node could
// spoof these messages otherwise.
window.addEventListener('message', (event) => {
	const msg = event.data;
	if (!msg || msg.source !== 'clew-preview') return;
	const fromNested = [...document.querySelectorAll('iframe.canvas-embed-note-frame')]
		.some((f) => f.contentWindow === event.source);
	if (!fromNested) return;
	if (msg.type === 'ready') {
		event.source.postMessage({
			source: 'clew-preview-host',
			type: 'theme',
			theme: document.documentElement.dataset.theme ?? 'dark',
		}, '*');
	} else if (msg.type === 'link-click' || msg.type === 'external-link') {
		window.parent.postMessage(msg, '*');
	}
});
