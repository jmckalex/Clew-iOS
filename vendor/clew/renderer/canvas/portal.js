// Portals (Advanced-Canvas style): a canvas FILE node on a canvas renders a
// live, read-only miniature of that other canvas — cards, images, note
// previews, groups, edges, ink, and shapes — scaled to fit the node box.
// Double-clicking the node opens the real canvas in a tab; the owning view
// rebuilds the portal when the target file changes on disk. Canvas nodes
// INSIDE a portal render as name chips (no recursive portals).
import { parseCanvas, canvasBounds, nodeRect } from './canvas-model.js';
import { shapeSvg, edgeSvg, strokeSvg } from './shape-svg.js';
import { renderCardHtml } from './card-markdown.js';
import { vaultFileUrl, previewUrl, fragmentUrl } from '../lib/preview-url.js';
import { fileKind } from '../lib/file-types.js';
import { isNotePath } from '../state/vault-store.js';
import { ipc, CH } from '../ipc.js';

/** Build (or rebuild) a portal into `container` for the canvas at `path`. */
export async function buildPortal(container, path) {
	container.classList.add('canvas-portal');
	container.dataset.portalPath = path;
	const text = await ipc.invoke(CH.NOTE_READ, { path }).catch(() => null);
	if (typeof text !== 'string') {
		container.textContent = '(canvas unavailable)';
		return;
	}
	const doc = parseCanvas(text);
	const bounds = canvasBounds(doc);
	container.replaceChildren();
	if (!bounds) {
		container.classList.add('is-empty');
		container.textContent = '(empty canvas)';
		return;
	}
	container.classList.remove('is-empty');

	const pad = 24;
	const bx = bounds.x - pad, by = bounds.y - pad;
	const bw = bounds.width + pad * 2, bh = bounds.height + pad * 2;
	const w = container.clientWidth || 300;
	const h = container.clientHeight || 200;
	const z = Math.min(w / bw, h / bh);

	const world = document.createElement('div');
	world.className = 'canvas-portal-world';
	// Centered fit.
	const ox = bx - (w / z - bw) / 2;
	const oy = by - (h / z - bh) / 2;
	world.style.transform = `scale(${z}) translate(${-ox}px, ${-oy}px)`;

	const svgLayer = () => {
		const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		el.style.cssText = `position:absolute;left:${bx}px;top:${by}px;width:${bw}px;height:${bh}px;overflow:visible;pointer-events:none`;
		el.setAttribute('viewBox', `${bx} ${by} ${bw} ${bh}`);
		return el;
	};

	for (const node of doc.nodes.filter((n) => n.type === 'group')) {
		const el = document.createElement('div');
		el.className = 'portal-group';
		place(el, nodeRect(node));
		if (node.label) {
			const label = document.createElement('span');
			label.textContent = node.label;
			el.append(label);
		}
		world.append(el);
	}

	const edges = svgLayer();
	const byId = new Map(doc.nodes.map((n) => [n.id, n]));
	edges.innerHTML = doc.edges.map((edge) => {
		const from = byId.get(edge.fromNode);
		const to = byId.get(edge.toNode);
		return from && to ? edgeSvg(edge, from, to, false, doc.edgeStyles?.[edge.id]) : '';
	}).join('');
	world.append(edges);

	for (const node of doc.nodes.filter((n) => n.type !== 'group')) {
		world.append(portalNode(node, doc.nodeStyles?.[node.id]));
	}

	const ink = svgLayer();
	ink.innerHTML = doc.strokes.map((s) => strokeSvg(s)).join('')
		+ doc.shapes.map((s) => shapeSvg(s, false)).join('');
	world.append(ink);

	container.append(world);
}

function portalNode(node, nstyle) {
	const el = document.createElement('div');
	el.className = 'portal-node';
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
		el.classList.add('is-chip');
		el.textContent = node.url;
	} else if (node.type === 'file' && node.file) {
		const kind = fileKind(node.file);
		if (node.file.toLowerCase().endsWith('.canvas')) {
			el.classList.add('is-chip');
			el.textContent = node.file.split('/').pop(); // no recursive portals
		} else if (isNotePath(node.file)) {
			el.innerHTML = `<iframe src="${previewUrl(node.file)}"></iframe>`;
		} else if (kind === 'image') {
			el.innerHTML = `<img src="${vaultFileUrl(node.file)}" alt="">`;
		} else if (kind === 'pdf') {
			el.innerHTML = `<iframe src="${vaultFileUrl(node.file)}"></iframe>`;
		} else if (kind === 'video') {
			el.innerHTML = `<video src="${vaultFileUrl(node.file)}"></video>`;
		} else {
			el.classList.add('is-chip');
			el.textContent = node.file.split('/').pop();
		}
	}
	return el;
}

// Cards upgrade to real engine renders, same as everywhere else.
async function upgradeCard(el, text) {
	if (!text.trim()) return;
	try {
		const response = await fetch(fragmentUrl(), { method: 'POST', body: text });
		if (!response.ok) return;
		const html = await response.text();
		if (!el.isConnected) return;
		el.classList.add('is-engine');
		el.innerHTML = html;
	} catch { /* mini-render stands */ }
}

function place(el, r) {
	el.style.left = `${r.x}px`;
	el.style.top = `${r.y}px`;
	el.style.width = `${r.width}px`;
	el.style.height = `${r.height}px`;
}
