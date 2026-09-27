// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Graph view: canvas 2D + d3-force over the vault's resolved link graph.
// Hand-rolled pan/zoom/drag/hit-testing (pointer math only — no d3-selection).
//
// Attributes/properties:
//   local        — when set, a local graph centered on the active note
//   depth        — local-graph neighborhood depth (default 1)
import { ClewElement } from '../base/clew-element.js';
import { vaultStore } from '../../state/vault-store.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { debounce } from '../../lib/debounce.js';
import { settingsStore } from '../../state/settings-store.js';
import { vaultSettingsStore } from '../../state/vault-settings-store.js';
import { citationLabel, citationsReady } from '../../editor/complete/citations.js';
import { showCitation } from '../../editor/live/events.js';
import {
	forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceX, forceY,
} from 'd3-force';

const noteTitle = (path) => path.split('/').pop().replace(/\.(md|jmd)$/i, '');

export class ClewGraphView extends ClewElement {
	local = false;
	depth = 1;

	#canvas = null;
	#ctx = null;
	#simulation = null;
	#nodes = [];
	#links = [];
	#transform = { x: 0, y: 0, k: 1 };
	#hovered = null;
	#dragging = null;
	#raf = 0;
	#resizeObserver = null;
	#rebuild = debounce(() => this.#buildGraph(), 300);
	#toggle = null;

	#syncToggle() {
		if (this.#toggle) this.#toggle.checked = settingsStore.get('graphReferences') === true;
	}

	subscribe() {
		this.listen(vaultStore, 'index-changed', () => this.#rebuild());
		this.listen(settingsStore, 'settings-changed', (key) => {
			if (key === 'graphReferences') { this.#syncToggle(); this.#buildGraph(); }
		});
		if (this.local) {
			this.listen(workspaceStore, 'active-changed', () => this.#rebuild());
			this.listen(workspaceStore, 'layout-changed', () => this.#rebuild());
		}
	}

	render() {
		this.classList.add('graph-host');
		this.#canvas = document.createElement('canvas');
		// References (§5.14): one node per cited key, an edge from each note
		// citing it. App-global, persisted (`graphReferences`).
		const label = document.createElement('label');
		label.className = 'graph-references-toggle';
		this.#toggle = document.createElement('input');
		this.#toggle.type = 'checkbox';
		this.#toggle.addEventListener('change', () => settingsStore.set('graphReferences', this.#toggle.checked));
		label.append(this.#toggle, document.createTextNode(' References'));
		this.replaceChildren(this.#canvas, label);
		this.#syncToggle();
		// Author-year labels arrive with the .bib cache.
		citationsReady().then(() => { if (settingsStore.get('graphReferences') === true) this.#buildGraph(); });
		this.#ctx = this.#canvas.getContext('2d');

		this.#resizeObserver = new ResizeObserver(() => this.#resize());
		this.#resizeObserver.observe(this);
		this.#wirePointer();
		this.#resize();
		this.#buildGraph();
	}

	cleanup() {
		this.#resizeObserver?.disconnect();
		this.#simulation?.stop();
		cancelAnimationFrame(this.#raf);
	}

	#resize() {
		if (!this.#canvas) return;
		const { width, height } = this.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		this.#canvas.width = Math.max(1, width * dpr);
		this.#canvas.height = Math.max(1, height * dpr);
		this.#canvas.style.width = `${width}px`;
		this.#canvas.style.height = `${height}px`;
		this.#draw();
	}

	// ---- graph data -------------------------------------------------------

	#graphData() {
		const index = vaultStore.index;
		let paths = Object.keys(index);
		if (this.local) {
			const center = workspaceStore.activeTab()?.path;
			if (!center || !index[center]) return { nodes: [], links: [] };
			const keep = new Set([center]);
			let frontier = [center];
			for (let d = 0; d < this.depth; d++) {
				const next = [];
				for (const p of frontier) {
					for (const link of index[p]?.links ?? []) {
						if (link.resolved && !keep.has(link.resolved)) { keep.add(link.resolved); next.push(link.resolved); }
					}
					for (const [source, meta] of Object.entries(index)) {
						if (keep.has(source)) continue;
						if ((meta.links ?? []).some((l) => l.resolved === p)) { keep.add(source); next.push(source); }
					}
				}
				frontier = next;
			}
			paths = [...keep];
		}

		const nodeSet = new Set(paths);
		const degree = new Map();
		const links = [];
		const seen = new Set();
		for (const source of paths) {
			for (const link of index[source]?.links ?? []) {
				const target = link.resolved;
				if (!target || !nodeSet.has(target) || target === source) continue;
				const key = source < target ? `${source}|${target}` : `${target}|${source}`;
				if (seen.has(key)) continue;
				seen.add(key);
				links.push({ source, target });
				degree.set(source, (degree.get(source) ?? 0) + 1);
				degree.set(target, (degree.get(target) ?? 0) + 1);
			}
		}
		const center = this.local ? workspaceStore.activeTab()?.path : null;
		const nodes = paths.map((path) => ({
			id: path,
			label: noteTitle(path),
			radius: Math.min(14, 4 + (degree.get(path) ?? 0) * 1.2) * (path === center ? 1.4 : 1),
			isCenter: path === center,
		}));
		if (settingsStore.get('graphReferences') === true) {
			const pandoc = vaultSettingsStore.get('pandocCitations') === true;
			const refs = new Map();
			for (const source of paths) {
				const keys = new Set((index[source]?.citations ?? []).filter((c) => pandoc || !c.pandoc).map((c) => c.key));
				for (const key of keys) {
					const id = `cite:${key}`;
					if (!refs.has(id)) refs.set(id, { id, key, label: citationLabel(key)?.label ?? key, radius: 5, isReference: true });
					links.push({ source, target: id, reference: true });
				}
			}
			nodes.push(...refs.values());
		}
		this.dataset.nodes = String(nodes.length);
		this.dataset.links = String(links.length);
		return { nodes, links };
	}

	#buildGraph() {
		if (!this.isConnected) return;
		const { nodes, links } = this.#graphData();

		// Preserve positions of surviving nodes across rebuilds.
		const previous = new Map(this.#nodes.map((n) => [n.id, n]));
		for (const node of nodes) {
			const old = previous.get(node.id);
			if (old) { node.x = old.x; node.y = old.y; node.vx = old.vx; node.vy = old.vy; }
		}
		this.#nodes = nodes;
		this.#links = links;

		this.#simulation?.stop();
		this.#simulation = forceSimulation(nodes)
			.force('link', forceLink(links).id((d) => d.id).distance(70).strength(0.4))
			.force('charge', forceManyBody().strength(-160).distanceMax(600))
			.force('center', forceCenter(0, 0).strength(0.05))
			.force('collide', forceCollide().radius((d) => d.radius + 4))
			.force('x', forceX(0).strength(0.02))
			.force('y', forceY(0).strength(0.02))
			.alpha(1)
			.alphaDecay(0.03)
			.on('tick', () => this.#scheduleDraw());
	}

	// ---- rendering --------------------------------------------------------

	#scheduleDraw() {
		if (this.#raf) return;
		this.#raf = requestAnimationFrame(() => {
			this.#raf = 0;
			this.#draw();
		});
	}

	#draw() {
		const ctx = this.#ctx;
		if (!ctx) return;
		const dpr = window.devicePixelRatio || 1;
		const width = this.#canvas.width / dpr;
		const height = this.#canvas.height / dpr;
		const styles = getComputedStyle(this);
		const colors = {
			bg: styles.getPropertyValue('--clew-bg-primary').trim(),
			edge: styles.getPropertyValue('--clew-border').trim(),
			node: styles.getPropertyValue('--clew-text-muted').trim(),
			accent: styles.getPropertyValue('--clew-accent').trim(),
			label: styles.getPropertyValue('--clew-text-muted').trim(),
			reference: styles.getPropertyValue('--clew-graph-reference').trim() || styles.getPropertyValue('--clew-accent').trim(),
		};

		ctx.save();
		ctx.scale(dpr, dpr);
		ctx.fillStyle = colors.bg;
		ctx.fillRect(0, 0, width, height);
		ctx.translate(width / 2 + this.#transform.x, height / 2 + this.#transform.y);
		ctx.scale(this.#transform.k, this.#transform.k);

		const neighborIds = new Set();
		if (this.#hovered) {
			neighborIds.add(this.#hovered.id);
			for (const link of this.#links) {
				if (link.source.id === this.#hovered.id) neighborIds.add(link.target.id);
				if (link.target.id === this.#hovered.id) neighborIds.add(link.source.id);
			}
		}
		const dim = (id) => this.#hovered && !neighborIds.has(id);

		ctx.lineWidth = 1 / this.#transform.k;
		for (const link of this.#links) {
			const isDim = this.#hovered
				&& link.source.id !== this.#hovered.id && link.target.id !== this.#hovered.id;
			ctx.strokeStyle = colors.edge;
			ctx.globalAlpha = isDim ? 0.15 : 0.7;
			ctx.beginPath();
			ctx.moveTo(link.source.x, link.source.y);
			ctx.lineTo(link.target.x, link.target.y);
			ctx.stroke();
		}

		for (const node of this.#nodes) {
			ctx.globalAlpha = dim(node.id) ? 0.25 : 1;
			ctx.fillStyle = node.isCenter || node === this.#hovered ? colors.accent : node.isReference ? colors.reference : colors.node;
			ctx.beginPath();
			// A reference is a square: a work, not a note.
			if (node.isReference) ctx.rect(node.x - node.radius, node.y - node.radius, node.radius * 2, node.radius * 2);
			else ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
			ctx.fill();
		}

		// Labels: readable once zoomed in (or always for small graphs).
		if (this.#transform.k > 0.7 || this.#nodes.length <= 30) {
			ctx.font = `${11 / this.#transform.k}px sans-serif`;
			ctx.textAlign = 'center';
			for (const node of this.#nodes) {
				ctx.globalAlpha = dim(node.id) ? 0.2 : 0.85;
				ctx.fillStyle = node === this.#hovered ? colors.accent : colors.label;
				ctx.fillText(node.label, node.x, node.y + node.radius + 12 / this.#transform.k);
			}
		}
		ctx.restore();
	}

	// ---- interaction ------------------------------------------------------

	#toGraphCoords(event) {
		const rect = this.#canvas.getBoundingClientRect();
		const x = event.clientX - rect.left - rect.width / 2 - this.#transform.x;
		const y = event.clientY - rect.top - rect.height / 2 - this.#transform.y;
		return { x: x / this.#transform.k, y: y / this.#transform.k };
	}

	#nodeAt(point) {
		for (let i = this.#nodes.length - 1; i >= 0; i--) {
			const node = this.#nodes[i];
			const dx = point.x - node.x;
			const dy = point.y - node.y;
			if (dx * dx + dy * dy <= (node.radius + 3) ** 2) return node;
		}
		return null;
	}

	#wirePointer() {
		const canvas = this.#canvas;

		canvas.addEventListener('pointerdown', (e) => {
			const point = this.#toGraphCoords(e);
			const node = this.#nodeAt(point);
			canvas.setPointerCapture(e.pointerId);
			if (node) {
				this.#dragging = { node, moved: false };
				node.fx = node.x;
				node.fy = node.y;
				this.#simulation.alphaTarget(0.25).restart();
			} else {
				this.#dragging = { pan: true, startX: e.clientX, startY: e.clientY, origin: { ...this.#transform } };
			}
		});

		canvas.addEventListener('pointermove', (e) => {
			if (this.#dragging?.node) {
				const point = this.#toGraphCoords(e);
				this.#dragging.node.fx = point.x;
				this.#dragging.node.fy = point.y;
				this.#dragging.moved = true;
			} else if (this.#dragging?.pan) {
				this.#transform.x = this.#dragging.origin.x + (e.clientX - this.#dragging.startX);
				this.#transform.y = this.#dragging.origin.y + (e.clientY - this.#dragging.startY);
				this.#scheduleDraw();
			} else {
				const node = this.#nodeAt(this.#toGraphCoords(e));
				if (node !== this.#hovered) {
					this.#hovered = node;
					canvas.style.cursor = node ? 'pointer' : 'default';
					this.#scheduleDraw();
				}
			}
		});

		canvas.addEventListener('pointerup', (e) => {
			const drag = this.#dragging;
			this.#dragging = null;
			if (drag?.node) {
				this.#simulation.alphaTarget(0);
				drag.node.fx = null;
				drag.node.fy = null;
				if (!drag.moved) {
					if (drag.node.isReference) showCitation(drag.node.key);
					else workspaceStore.openNote(drag.node.id, { newTab: e.metaKey || e.ctrlKey });
				}
			}
		});

		canvas.addEventListener('wheel', (e) => {
			e.preventDefault();
			const factor = Math.exp(-e.deltaY * 0.002);
			const k = Math.max(0.15, Math.min(6, this.#transform.k * factor));
			// Zoom around the cursor.
			const rect = canvas.getBoundingClientRect();
			const cx = e.clientX - rect.left - rect.width / 2;
			const cy = e.clientY - rect.top - rect.height / 2;
			const scale = k / this.#transform.k;
			this.#transform.x = cx - (cx - this.#transform.x) * scale;
			this.#transform.y = cy - (cy - this.#transform.y) * scale;
			this.#transform.k = k;
			this.#scheduleDraw();
		}, { passive: false });
	}
}

customElements.define('clew-graph-view', ClewGraphView);
