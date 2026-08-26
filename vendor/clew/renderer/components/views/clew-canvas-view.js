// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// <clew-canvas-view>: an infinite pan/zoom canvas tab for .canvas files
// (JSON Canvas / Obsidian-compatible). Cards, embedded notes (live jmarkdown
// previews), images, PDFs, media, web pages (webview), connections with
// labels, groups — plus Clew's drawing layer (freehand ink, eraser) and
// Excalidraw-style shapes (rect/ellipse/diamond/arrow/line with labels).
//
// Interaction model: content is inert until a node is "engaged" (double-
// click), so dragging always wins; affordances (handles, anchors, marquee,
// previews) are drawn geometry in an overlay SVG and hit-tested in world
// space, never via DOM targets.
import { ClewElement } from '../base/clew-element.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { vaultStore, isNotePath } from '../../state/vault-store.js';
import { settingsStore } from '../../state/settings-store.js';
import { ipc, CH } from '../../ipc.js';
import { debounce } from '../../lib/debounce.js';
import { isViewablePath } from '../../lib/file-types.js';
import * as actions from '../../commands/actions.js';
import * as model from '../../canvas/canvas-model.js';
import { buildNodeContent, contentKey, setCardText } from '../../canvas/node-content.js';
import { showCanvasMenu } from '../../canvas/canvas-menu.js';
import { buildPortal } from '../../canvas/portal.js';
import { canvasSyncBus } from '../../canvas/canvas-sync.js';
import { inkColor, edgeColor, shapeSvg, edgeSvg, strokeSvg, escapeXml, TEXT_FONT_STACKS } from '../../canvas/shape-svg.js';
import { openListModal } from '../modals/list-modal.js';
import { previewUrl } from '../../lib/preview-url.js';
import { handleApiRequest } from '../../note-api.js';
import { icon } from '../../lib/icons.js';

const HOST_SOURCE = 'clew-preview-host';
const UNDO_LIMIT = 100;

const TOOLS = [
	{ id: 'select', key: 'v', icon: 'select', title: 'Select (V)' },
	{ id: 'pan', key: 'h', icon: 'hand', title: 'Pan (H)' },
	{ id: 'card', key: 'c', icon: 'card', title: 'Card (C) — or double-click the canvas' },
	{ id: 'draw', key: 'p', icon: 'pencil', title: 'Draw (P)' },
	{ id: 'erase', key: 'e', icon: 'eraser', title: 'Erase (E)' },
	{ id: 'rect', key: 'r', icon: 'square', title: 'Rectangle (R)' },
	{ id: 'ellipse', key: 'o', icon: 'circle', title: 'Ellipse (O)' },
	{ id: 'diamond', key: 'd', icon: 'diamond', title: 'Diamond (D)' },
	{ id: 'arrow', key: 'a', icon: 'arrow-right', title: 'Arrow (A)' },
	{ id: 'line', key: 'l', icon: 'slash', title: 'Line (L)' },
	{ id: 'text', key: 't', icon: 'font', title: 'Text (T)' },
];

const SHAPE_TOOLS = ['rect', 'ellipse', 'diamond', 'arrow', 'line'];

class ClewCanvasView extends ClewElement {
	tabId = null;
	path = null;

	#doc = model.createCanvas();
	#camera = { x: 0, y: 0, zoom: 1 };
	#tool = 'select';
	#sel = { nodes: new Set(), shapes: new Set(), strokes: new Set(), edges: new Set() };
	#hoverId = null;
	#engagedId = null;
	#editingId = null;
	#drag = null;
	#spaceHeld = false;
	#undoStack = [];
	#redoStack = [];
	#lastWritten = null;
	#loaded = false;
	#conflict = null; // disk text during an unresolved external-change conflict
	#ink = { color: 'ink', width: 3 };
	/** Defaults for newly drawn shapes/strokes/text; the style bar edits
	 *  these and applies changes to the current selection too. */
	#shapeStyle = {
		color: '2', fill: false, fillStyle: 'solid',
		strokeStyle: null, rough: 1, opacity: 1,
		font: 'hand', fontSize: 20,
	};
	#nodeEls = new Map(); // node id -> element
	#embeds = new Map(); // node id -> {iframe, path, ready, pending}
	#els = null;
	#save = debounce(() => this.#write(), 500);
	#saveCamera = debounce(() => {
		workspaceStore.updateTabView(this.tabId, { camera: { ...this.#camera } });
	}, 300);

	// ---- lifecycle ---------------------------------------------------------

	subscribe() {
		this.listen({ on: ipc.on }, CH.EV_RENDER_DONE, ({ path }) => this.#refreshEmbeds(path));
		this.listen({ on: ipc.on }, CH.EV_KV_CHANGED, (payload) => {
			for (const embed of this.#embeds.values()) {
				this.#postEmbed(embed, { type: 'event', name: 'kv', payload });
			}
		});
		this.listen({ on: ipc.on }, CH.EV_FILE_CHANGED, ({ path }) => {
			if (path === this.path) this.#externalChange();
			// Note embeds on this canvas may contain ![[X.canvas]] embeds,
			// and portal nodes show other canvases directly.
			if (path.toLowerCase().endsWith('.canvas')) {
				for (const embed of this.#embeds.values()) {
					this.#postEmbed(embed, { type: 'canvas-changed', path });
				}
				for (const portal of this.querySelectorAll(`.canvas-portal[data-portal-path]`)) {
					if (portal.dataset.portalPath === path) buildPortal(portal, path);
				}
			}
		});
		this.listen(settingsStore, 'settings-changed', () => this.#broadcastTheme());
		// Sibling canvas views of the same file (splits) sync live.
		this.listen(canvasSyncBus, 'doc-changed', ({ path, text, source }) => {
			if (source === this || path !== this.path || this.#drag || !this.#loaded) return;
			this.#lastWritten = text; // the source's save covers the file
			this.#doc = model.parseCanvas(text);
			this.#pruneSelection();
			this.#syncAll();
		});
		window.addEventListener('message', this.#onMessage);
		window.addEventListener('blur', this.#onWindowBlur);
	}

	cleanup() {
		this.#save.flush();
		this.#saveCamera.flush();
		window.removeEventListener('message', this.#onMessage);
		window.removeEventListener('blur', this.#onWindowBlur);
		for (const embed of this.#embeds.values()) {
			ipc.invoke(CH.RENDER_UNSUBSCRIBE, { path: embed.path }).catch(() => {});
		}
		this.#embeds.clear();
	}

	#onWindowBlur = () => this.#save.flush();

	render() {
		this.classList.add('canvas-view');
		this.innerHTML = `
			<div class="canvas-viewport" tabindex="0">
				<div class="canvas-world">
					<svg class="canvas-layer canvas-edges"></svg>
					<div class="canvas-nodes"></div>
					<svg class="canvas-layer canvas-shapes"></svg>
					<svg class="canvas-layer canvas-strokes"></svg>
					<svg class="canvas-layer canvas-overlay"></svg>
				</div>
				<div class="canvas-toolbar canvas-chrome"></div>
				<div class="canvas-stylebar canvas-chrome"></div>
				<div class="canvas-zoombar canvas-chrome">
					<button data-zoom="out" title="Zoom out"></button>
					<button data-zoom="reset" class="canvas-zoom-label" title="Reset zoom">100%</button>
					<button data-zoom="in" title="Zoom in"></button>
					<button data-zoom="fit" title="Zoom to fit (⇧1)"></button>
				</div>
			</div>
		`;
		this.#els = {
			viewport: this.querySelector('.canvas-viewport'),
			world: this.querySelector('.canvas-world'),
			edges: this.querySelector('.canvas-edges'),
			nodes: this.querySelector('.canvas-nodes'),
			shapes: this.querySelector('.canvas-shapes'),
			strokes: this.querySelector('.canvas-strokes'),
			overlay: this.querySelector('.canvas-overlay'),
			toolbar: this.querySelector('.canvas-toolbar'),
			stylebar: this.querySelector('.canvas-stylebar'),
			zoomLabel: this.querySelector('.canvas-zoom-label'),
		};
		this.#renderToolbar();
		this.#renderStylebar();
		this.querySelector('[data-zoom="out"]').append(icon('minus'));
		this.querySelector('[data-zoom="in"]').append(icon('plus'));
		this.querySelector('[data-zoom="fit"]').append(icon('expand'));

		const vp = this.#els.viewport;
		vp.addEventListener('pointerdown', this.#onPointerDown);
		vp.addEventListener('pointermove', this.#onPointerMove);
		vp.addEventListener('pointerup', this.#onPointerUp);
		vp.addEventListener('pointercancel', this.#onPointerUp);
		vp.addEventListener('dblclick', this.#onDblClick);
		vp.addEventListener('wheel', this.#onWheel, { passive: false });
		vp.addEventListener('keydown', this.#onKeyDown);
		vp.addEventListener('keyup', this.#onKeyUp);
		vp.addEventListener('contextmenu', this.#onContextMenu);
		vp.addEventListener('paste', this.#onPaste);
		this.querySelector('.canvas-zoombar').addEventListener('click', (e) => {
			const action = e.target.closest('[data-zoom]')?.dataset.zoom;
			const rect = vp.getBoundingClientRect();
			const cx = rect.width / 2, cy = rect.height / 2;
			if (action === 'in') this.#zoomTo(this.#camera.zoom * 1.25, cx, cy);
			else if (action === 'out') this.#zoomTo(this.#camera.zoom / 1.25, cx, cy);
			else if (action === 'reset') this.#zoomTo(1, cx, cy);
			else if (action === 'fit') this.#zoomFit();
		});

		this.#load();
	}

	async #load() {
		const text = await ipc.invoke(CH.NOTE_READ, { path: this.path }).catch(() => null);
		if (text === null) return;
		this.#lastWritten = text;
		this.#doc = model.parseCanvas(text);
		this.#loaded = true;
		const saved = workspaceStore.findTab(this.tabId)?.tab.view.camera;
		if (saved && Number.isFinite(saved.zoom)) {
			this.#camera = { x: saved.x, y: saved.y, zoom: saved.zoom };
			this.#applyCamera();
			this.#syncAll();
		} else {
			this.#syncAll();
			this.#zoomFit();
		}
		this.#els.viewport.focus({ preventScroll: true });
	}

	#write() {
		if (!this.#loaded || this.#conflict) return;
		const text = model.serializeCanvas(this.#doc);
		if (text === this.#lastWritten) return;
		this.#lastWritten = text;
		ipc.invoke(CH.NOTE_WRITE, { path: this.path, content: text }).catch((err) => {
			console.error('Canvas save failed:', err);
		});
	}

	async #externalChange() {
		const text = await ipc.invoke(CH.NOTE_READ, { path: this.path }).catch(() => null);
		if (text === null || text === this.#lastWritten) return;
		if (this.#save.pending() || this.#conflict) {
			// External change + unsaved local edits: pause saving, let the
			// user pick a side (mirrors the editor's conflict banner).
			this.#conflict = text;
			this.#save.cancel();
			this.#syncConflictBanner();
			return;
		}
		this.#lastWritten = text;
		this.#doc = model.parseCanvas(text);
		this.#clearSelection();
		this.#syncAll();
	}

	#syncConflictBanner() {
		this.querySelector(':scope .conflict-banner')?.remove();
		if (!this.#conflict) return;
		const banner = document.createElement('div');
		banner.className = 'conflict-banner';
		const text = document.createElement('span');
		text.textContent = 'This canvas changed on disk while you have unsaved edits. Auto-save is paused.';
		const keep = document.createElement('button');
		keep.textContent = 'Keep my version';
		keep.addEventListener('click', () => {
			this.#conflict = null;
			this.#syncConflictBanner();
			this.#write();
		});
		const load = document.createElement('button');
		load.textContent = 'Load disk version';
		load.addEventListener('click', () => {
			const disk = this.#conflict;
			this.#conflict = null;
			this.#syncConflictBanner();
			this.#checkpoint(); // ⌘Z can still restore the local version
			this.#doc = model.parseCanvas(disk);
			this.#lastWritten = disk;
			this.#pruneSelection();
			this.#syncAll();
		});
		banner.append(text, keep, load);
		this.#els.viewport.append(banner);
	}

	// ---- undo / mutation ---------------------------------------------------

	#checkpoint() {
		this.#undoStack.push(model.serializeCanvas(this.#doc));
		if (this.#undoStack.length > UNDO_LIMIT) this.#undoStack.shift();
		this.#redoStack = [];
	}

	#mutated() {
		this.#syncAll();
		this.#save();
		canvasSyncBus.emit('doc-changed', {
			path: this.path,
			text: model.serializeCanvas(this.#doc),
			source: this,
		});
	}

	#undo() {
		if (this.#undoStack.length === 0) return;
		this.#redoStack.push(model.serializeCanvas(this.#doc));
		this.#doc = model.parseCanvas(this.#undoStack.pop());
		this.#pruneSelection();
		this.#mutated();
	}

	#redo() {
		if (this.#redoStack.length === 0) return;
		this.#undoStack.push(model.serializeCanvas(this.#doc));
		this.#doc = model.parseCanvas(this.#redoStack.pop());
		this.#pruneSelection();
		this.#mutated();
	}

	#pruneSelection() {
		const nodeIds = new Set(this.#doc.nodes.map((n) => n.id));
		const shapeIds = new Set(this.#doc.shapes.map((s) => s.id));
		const strokeIds = new Set(this.#doc.strokes.map((s) => s.id));
		const edgeIds = new Set(this.#doc.edges.map((e) => e.id));
		this.#sel.nodes = new Set([...this.#sel.nodes].filter((id) => nodeIds.has(id)));
		this.#sel.shapes = new Set([...this.#sel.shapes].filter((id) => shapeIds.has(id)));
		this.#sel.strokes = new Set([...this.#sel.strokes].filter((id) => strokeIds.has(id)));
		this.#sel.edges = new Set([...this.#sel.edges].filter((id) => edgeIds.has(id)));
	}

	// ---- coordinates -------------------------------------------------------

	#toWorld(clientX, clientY) {
		const rect = this.#els.viewport.getBoundingClientRect();
		const { x, y, zoom } = this.#camera;
		return {
			x: (clientX - rect.left - x) / zoom,
			y: (clientY - rect.top - y) / zoom,
		};
	}

	#toScreen(wx, wy) {
		const { x, y, zoom } = this.#camera;
		return { x: wx * zoom + x, y: wy * zoom + y };
	}

	#applyCamera() {
		const { x, y, zoom } = this.#camera;
		this.#els.world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
		this.#els.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
		this.#saveCamera();
	}

	#zoomTo(zoom, cx, cy) {
		const clamped = Math.max(0.08, Math.min(3, zoom));
		const { x, y, zoom: old } = this.#camera;
		// Keep the viewport point (cx, cy) fixed in world space.
		this.#camera.x = cx - ((cx - x) / old) * clamped;
		this.#camera.y = cy - ((cy - y) / old) * clamped;
		this.#camera.zoom = clamped;
		this.#applyCamera();
		this.#syncOverlay();
	}

	#zoomFit() {
		const bounds = model.canvasBounds(this.#doc);
		const rect = this.#els.viewport.getBoundingClientRect();
		if (!bounds || rect.width === 0) {
			this.#camera = { x: rect.width / 2, y: rect.height / 2, zoom: 1 };
			this.#applyCamera();
			return;
		}
		const margin = 60;
		const zoom = Math.max(0.08, Math.min(1.5,
			Math.min((rect.width - margin * 2) / bounds.width, (rect.height - margin * 2) / bounds.height)));
		this.#camera.zoom = zoom;
		this.#camera.x = rect.width / 2 - (bounds.x + bounds.width / 2) * zoom;
		this.#camera.y = rect.height / 2 - (bounds.y + bounds.height / 2) * zoom;
		this.#applyCamera();
		this.#syncOverlay();
	}

	// ---- toolbar -----------------------------------------------------------

	#renderToolbar() {
		const bar = this.#els.toolbar;
		bar.innerHTML = '';
		for (const tool of TOOLS) {
			const button = document.createElement('button');
			button.className = 'canvas-tool' + (this.#tool === tool.id ? ' is-active' : '');
			button.append(icon(tool.icon));
			button.title = tool.title;
			button.addEventListener('click', () => this.#setTool(tool.id));
			bar.append(button);
		}
		bar.append(sep());
		const addNote = document.createElement('button');
		addNote.className = 'canvas-tool';
		addNote.append(icon('file-plus'));
		addNote.title = 'Add note or file…';
		addNote.addEventListener('click', () => this.#addFilePicker());
		const addWeb = document.createElement('button');
		addWeb.className = 'canvas-tool';
		addWeb.append(icon('globe'));
		addWeb.title = 'Add web page…';
		addWeb.addEventListener('click', () => this.#addWebPrompt());
		bar.append(addNote, addWeb, sep());

		// Ink / shape color swatches.
		for (const color of ['ink', '1', '2', '3', '4', '5', '6']) {
			const dot = document.createElement('button');
			dot.className = 'canvas-swatch' + (this.#ink.color === color ? ' is-active' : '');
			dot.dataset.canvasColor = color;
			dot.title = color === 'ink' ? 'Ink' : `Color ${color}`;
			dot.addEventListener('click', () => {
				this.#ink.color = color;
				this.#shapeStyle.color = color;
				this.#renderToolbar();
			});
			bar.append(dot);
		}
		bar.append(sep());
		for (const [label, width] of [['S', 2], ['M', 3.5], ['L', 6]]) {
			const button = document.createElement('button');
			button.className = 'canvas-tool canvas-width' + (this.#ink.width === width ? ' is-active' : '');
			button.textContent = label;
			button.title = `Pen width ${label}`;
			button.addEventListener('click', () => {
				this.#ink.width = width;
				this.#renderToolbar();
			});
			bar.append(button);
		}

		function sep() {
			const el = document.createElement('span');
			el.className = 'canvas-toolbar-sep';
			return el;
		}
	}

	#setTool(tool) {
		this.#tool = tool;
		this.#disengage();
		this.#renderToolbar();
		this.#renderStylebar();
		this.#els.viewport.dataset.tool = tool;
		this.#syncOverlay();
		this.#els.viewport.focus({ preventScroll: true });
	}

	// ---- style bar (Excalidraw-style: stroke, sloppiness, fill, opacity) ---

	/** Apply a style patch to the shape defaults AND every selected shape. */
	#applyShapeStyle(patch) {
		Object.assign(this.#shapeStyle, patch);
		if (this.#sel.shapes.size) {
			this.#checkpoint();
			for (const id of this.#sel.shapes) {
				const s = this.#shapeById(id);
				if (!s) continue;
				if ('strokeStyle' in patch) {
					if (patch.strokeStyle) s.strokeStyle = patch.strokeStyle;
					else delete s.strokeStyle;
				}
				if ('rough' in patch) {
					if (patch.rough === 1) delete s.rough;
					else s.rough = patch.rough;
				}
				if ('opacity' in patch) {
					if (patch.opacity >= 1) delete s.opacity;
					else s.opacity = patch.opacity;
				}
				if ('fill' in patch || 'fillStyle' in patch) {
					const fill = patch.fill ?? this.#shapeStyle.fill;
					const fillStyle = patch.fillStyle ?? this.#shapeStyle.fillStyle;
					if (fill) s.fill = true; else delete s.fill;
					if (fill && fillStyle === 'hachure') s.fillStyle = 'hachure';
					else delete s.fillStyle;
				}
				if ('font' in patch && s.kind === 'text') s.font = patch.font;
				if ('fontSize' in patch && s.kind === 'text') s.fontSize = patch.fontSize;
			}
			this.#mutated();
		}
		this.#renderStylebar();
	}

	#renderStylebar() {
		const bar = this.#els.stylebar;
		if (!bar) return;
		const st = this.#shapeStyle;
		const textish = this.#tool === 'text'
			|| [...this.#sel.shapes].some((id) => this.#shapeById(id)?.kind === 'text');
		bar.innerHTML = '';
		const group = (title, options, current, onPick) => {
			const wrap = document.createElement('span');
			wrap.className = 'canvas-stylegroup';
			wrap.title = title;
			for (const opt of options) {
				const button = document.createElement('button');
				button.className = 'canvas-styleopt' + (current === opt.value ? ' is-active' : '');
				button.textContent = opt.label;
				button.title = `${title}: ${opt.title ?? opt.label}`;
				button.addEventListener('click', () => onPick(opt.value));
				wrap.append(button);
			}
			return wrap;
		};
		bar.append(
			group('Stroke', [
				{ value: null, label: '—', title: 'solid' },
				{ value: 'dashed', label: '- -', title: 'dashed' },
				{ value: 'dotted', label: '···', title: 'dotted' },
			], st.strokeStyle, (v) => this.#applyShapeStyle({ strokeStyle: v })),
			group('Sloppiness', [
				{ value: 0, label: '▭', title: 'architect (clean)' },
				{ value: 1, label: '≈', title: 'artist (sketchy)' },
				{ value: 2, label: '〰', title: 'cartoonist (scrawl)' },
			], st.rough, (v) => this.#applyShapeStyle({ rough: v })),
			group('Fill', [
				{ value: 'none', label: '□', title: 'none' },
				{ value: 'solid', label: '■', title: 'solid' },
				{ value: 'hachure', label: '▨', title: 'hachure' },
			], st.fill ? st.fillStyle : 'none', (v) =>
				this.#applyShapeStyle(v === 'none'
					? { fill: false, fillStyle: 'solid' }
					: { fill: true, fillStyle: v })),
		);
		const opacity = document.createElement('input');
		opacity.type = 'range';
		opacity.className = 'canvas-opacity';
		opacity.min = '10';
		opacity.max = '100';
		opacity.value = String(Math.round(st.opacity * 100));
		opacity.title = 'Opacity';
		opacity.addEventListener('change', () => {
			this.#applyShapeStyle({ opacity: Number(opacity.value) / 100 });
		});
		bar.append(opacity);
		if (textish) {
			bar.append(group('Font', [
				{ value: 'hand', label: 'Hand' },
				{ value: 'sans', label: 'Aa' , title: 'sans'},
				{ value: 'serif', label: 'Se' , title: 'serif'},
				{ value: 'mono', label: 'Mo', title: 'mono' },
			], st.font, (v) => this.#applyShapeStyle({ font: v })));
			bar.append(group('Text size', [
				{ value: 14, label: 'S' },
				{ value: 20, label: 'M' },
				{ value: 32, label: 'L' },
				{ value: 48, label: 'XL' },
			], st.fontSize, (v) => this.#applyShapeStyle({ fontSize: v })));
		}
	}

	// ---- sync (doc → DOM) --------------------------------------------------

	#syncAll() {
		this.#syncNodes();
		this.#syncEdges();
		this.#syncStrokes();
		this.#syncShapes();
		this.#syncOverlay();
	}

	#syncNodes() {
		const container = this.#els.nodes;
		const seen = new Set();
		// Groups paint first (under), then regular nodes in array order.
		const ordered = [
			...this.#doc.nodes.filter((n) => n.type === 'group'),
			...this.#doc.nodes.filter((n) => n.type !== 'group'),
		];
		let previous = null;
		for (const node of ordered) {
			seen.add(node.id);
			let el = this.#nodeEls.get(node.id);
			if (el && el.dataset.contentKey !== contentKey(node)) {
				this.#removeNodeEl(node.id);
				el = null;
			}
			if (!el) {
				el = document.createElement('div');
				el.className = `canvas-node canvas-node-${node.type}`;
				el.dataset.id = node.id;
				el.dataset.contentKey = contentKey(node);
				el.append(buildNodeContent(node, { register: this.#registerEmbed }));
				this.#nodeEls.set(node.id, el);
			}
			// Keep DOM order aligned with paint order.
			if (previous ? el.previousElementSibling !== previous : container.firstElementChild !== el) {
				container.insertBefore(el, previous ? previous.nextSibling : container.firstChild);
			}
			previous = el;
			el.style.transform = `translate(${node.x}px, ${node.y}px)`;
			el.style.width = `${node.width}px`;
			el.style.height = `${node.height}px`;
			if (node.color) el.dataset.color = node.color;
			else delete el.dataset.color;
			const nstyle = this.#doc.nodeStyles[node.id];
			if (nstyle?.shape) el.dataset.nshape = nstyle.shape;
			else delete el.dataset.nshape;
			if (nstyle?.border) el.dataset.nborder = nstyle.border;
			else delete el.dataset.nborder;
			el.classList.toggle('is-bg-transparent', nstyle?.bg === 'transparent');
			el.style.opacity = nstyle?.opacity ?? '';
			el.classList.toggle('is-selected', this.#sel.nodes.has(node.id));
			el.classList.toggle('is-engaged', this.#engagedId === node.id);
			if (node.type === 'text' && this.#editingId !== node.id) {
				const content = el.querySelector('.canvas-text');
				if (content && content.dataset.cardText !== (node.text ?? '')) {
					setCardText(content, node.text);
				}
			}
			if (node.type === 'group') {
				const label = el.querySelector('.canvas-group-label');
				if (label && label.textContent !== (node.label ?? '')) label.textContent = node.label ?? '';
			}
		}
		for (const id of [...this.#nodeEls.keys()]) {
			if (!seen.has(id)) this.#removeNodeEl(id);
		}
	}

	#removeNodeEl(id) {
		this.#nodeEls.get(id)?.remove();
		this.#nodeEls.delete(id);
		const embed = this.#embeds.get(id);
		if (embed) {
			ipc.invoke(CH.RENDER_UNSUBSCRIBE, { path: embed.path }).catch(() => {});
			this.#embeds.delete(id);
		}
	}

	#nodeById(id) {
		return this.#doc.nodes.find((n) => n.id === id) ?? null;
	}

	#shapeById(id) {
		return this.#doc.shapes.find((s) => s.id === id) ?? null;
	}

	#strokeById(id) {
		return this.#doc.strokes.find((s) => s.id === id) ?? null;
	}

	#syncEdges() {
		const svg = this.#els.edges;
		const parts = [];
		for (const edge of this.#doc.edges) {
			const from = this.#nodeById(edge.fromNode);
			const to = this.#nodeById(edge.toNode);
			if (!from || !to) continue;
			parts.push(edgeSvg(edge, from, to, this.#sel.edges.has(edge.id), this.#doc.edgeStyles[edge.id]));
		}
		svg.innerHTML = parts.join('');
	}

	#syncStrokes() {
		const svg = this.#els.strokes;
		svg.innerHTML = this.#doc.strokes.map((stroke) =>
			strokeSvg(stroke, this.#sel.strokes.has(stroke.id))).join('');
	}

	#syncShapes() {
		const svg = this.#els.shapes;
		svg.innerHTML = this.#doc.shapes.map((shape) => shapeSvg(shape, this.#sel.shapes.has(shape.id))).join('');
	}

	#syncOverlay() {
		const svg = this.#els.overlay;
		const z = this.#camera.zoom;
		const parts = [];

		// Marquee.
		if (this.#drag?.type === 'marquee') {
			const r = normRect(this.#drag.start, this.#drag.current);
			parts.push(`<rect class="canvas-marquee" x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}"`
				+ ` style="stroke-width:${1.5 / z}"/>`);
		}

		// Temp edge while connecting.
		if (this.#drag?.type === 'edge') {
			const { fromNode, fromSide, current, snap } = this.#drag;
			const from = this.#nodeById(fromNode);
			if (from) {
				const a = model.anchorPoint(from, fromSide);
				const b = snap ?? current;
				parts.push(`<path class="canvas-temp-edge" d="M ${a.x} ${a.y} L ${b.x} ${b.y}" style="stroke-width:${2 / z}"/>`);
			}
		}

		// Temp shape while drawing one.
		if (this.#drag?.type === 'shape') {
			parts.push(shapeSvg(this.#drag.shape, false, true));
		}

		// Groups with anything selected get ONE dotted box, and their members
		// lose their individual outlines — a group should read as a single
		// object, not as a crowd of separately-outlined ones.
		const selectedGroups = (this.#doc.groups ?? []).filter((g) =>
			g.members.some((m) => this.#sel[MEMBER_TO_SEL[m.kind]].has(m.id)));
		const grouped = new Set();
		for (const g of selectedGroups) {
			for (const m of g.members) grouped.add(`${m.kind}:${m.id}`);
		}

		// Selected shapes: outline + handles when solo.
		const soloNode = this.#sel.nodes.size === 1 && this.#sel.shapes.size === 0
			&& this.#sel.strokes.size === 0
			? this.#nodeById([...this.#sel.nodes][0]) : null;
		const soloShape = this.#sel.shapes.size === 1 && this.#sel.nodes.size === 0
			&& this.#sel.strokes.size === 0
			? this.#shapeById([...this.#sel.shapes][0]) : null;
		for (const id of this.#sel.shapes) {
			const shape = this.#shapeById(id);
			if (!shape || shape === soloShape || grouped.has(`shape:${id}`)) continue;
			const r = model.shapeRect(shape);
			parts.push(`<rect class="canvas-sel-outline" x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}"`
				+ ` style="stroke-width:${1.5 / z}"/>`);
		}

		// Selected ink. The halo on the path shows WHICH stroke; this box gives
		// it a grab target with the same visual language as everything else.
		for (const id of this.#sel.strokes) {
			const stroke = this.#strokeById(id);
			if (!stroke || grouped.has(`stroke:${id}`)) continue;
			const r = model.strokeBounds(stroke);
			const pad = 3 / z;
			parts.push(`<rect class="canvas-sel-outline" x="${r.x - pad}" y="${r.y - pad}"`
				+ ` width="${r.width + 2 * pad}" height="${r.height + 2 * pad}"`
				+ ` style="stroke-width:${1.5 / z}"/>`);
		}

		for (const g of selectedGroups) {
			const b = model.groupBounds(this.#doc, g);
			if (!b) continue;
			const pad = 7 / z;
			parts.push(`<rect class="canvas-group-outline" x="${b.x - pad}" y="${b.y - pad}"`
				+ ` width="${b.width + 2 * pad}" height="${b.height + 2 * pad}"`
				+ ` style="stroke-width:${1.5 / z}"/>`);
		}

		const handleRect = (rect) => {
			const size = 8 / z;
			for (const pos of Object.values(model.handlePositions(rect))) {
				parts.push(`<rect class="canvas-handle" x="${pos.x - size / 2}" y="${pos.y - size / 2}"`
					+ ` width="${size}" height="${size}" style="stroke-width:${1.5 / z}"/>`);
			}
			parts.push(`<rect class="canvas-sel-outline" x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}"`
				+ ` style="stroke-width:${1.5 / z}"/>`);
		};

		if (soloNode && this.#tool === 'select' && !this.#drag) handleRect(model.nodeRect(soloNode));
		if (soloShape && this.#tool === 'select' && !this.#drag) {
			if (soloShape.kind === 'line' || soloShape.kind === 'arrow') {
				const size = 10 / z;
				for (const [hx, hy] of [[soloShape.x, soloShape.y], [soloShape.x + soloShape.width, soloShape.y + soloShape.height]]) {
					parts.push(`<circle class="canvas-handle" cx="${hx}" cy="${hy}" r="${size / 2}" style="stroke-width:${1.5 / z}"/>`);
				}
			} else {
				handleRect(model.shapeRect(soloShape));
			}
		}

		// Anchors on the hovered/selected node (for making connections).
		const anchorTarget = this.#tool === 'select' && !this.#drag
			? (this.#hoverId ? this.#nodeById(this.#hoverId) : soloNode) : null;
		if (anchorTarget) {
			for (const side of model.SIDES) {
				const p = model.anchorHandlePoint(anchorTarget, side, 14 / z);
				parts.push(`<circle class="canvas-anchor" cx="${p.x}" cy="${p.y}" r="${6 / z}" style="stroke-width:${1.5 / z}"/>`);
			}
		}

		// Eraser cursor.
		if (this.#drag?.type === 'erase') {
			const { current } = this.#drag;
			parts.push(`<circle class="canvas-eraser" cx="${current.x}" cy="${current.y}" r="${10 / z}" style="stroke-width:${1.5 / z}"/>`);
		}

		svg.innerHTML = parts.join('');
	}

	// ---- pointer machine ---------------------------------------------------

	#onPointerDown = (e) => {
		// Clicks on the app's own chrome are not canvas gestures. Without this
		// a style-bar click hit-tests as empty world space, which clears the
		// selection AND rebuilds the bar — destroying the button between
		// pointerdown and pointerup, so its click never fires at all.
		if (e.target.closest('.canvas-chrome, .canvas-inline-input')) return;
		if (this.#editingId) this.#commitEdit();
		this.#els.viewport.focus({ preventScroll: true });
		const p = this.#toWorld(e.clientX, e.clientY);
		const z = this.#camera.zoom;

		// Pan: middle button, space, or the pan tool.
		if (e.button === 1 || this.#spaceHeld || this.#tool === 'pan') {
			this.#startDrag(e, { type: 'pan', startCam: { ...this.#camera }, sx: e.clientX, sy: e.clientY });
			return;
		}
		if (e.button === 2) return; // context menu handles it

		if (this.#tool === 'select') {
			// An engaged node's content owns its events; pointerdown outside it disengages.
			if (this.#engagedId) {
				const engagedEl = this.#nodeEls.get(this.#engagedId);
				if (engagedEl && e.composedPath().includes(engagedEl)) return;
				this.#disengage();
			}

			// 1. Resize handles of the solo selection.
			const solo = this.#soloTarget();
			if (solo) {
				const handle = this.#handleAt(solo, p, 10 / z);
				if (handle) {
					this.#startDrag(e, {
						type: 'resize', target: solo, handle,
						startRect: solo.kind ? { x: solo.obj.x, y: solo.obj.y, width: solo.obj.width, height: solo.obj.height }
							: model.nodeRect(solo.obj),
						start: p, checkpointed: false,
					});
					return;
				}
			}

			// 2. Connection anchors (hovered or any node's side dots).
			const anchor = this.#anchorAt(p, 9 / z);
			if (anchor) {
				this.#startDrag(e, { type: 'edge', fromNode: anchor.node.id, fromSide: anchor.side, current: p, snap: null });
				return;
			}

			// 3. Nodes.
			const node = model.nodeAt(this.#doc, p.x, p.y);
			if (node) {
				if (e.shiftKey) {
					this.#toggleSelect('nodes', node.id);
				} else if (!this.#sel.nodes.has(node.id)) {
					this.#select('nodes', node.id);
				}
				this.#beginMove(e, p, node);
				return;
			}

			// 4. Ink strokes — tested BEFORE shapes because the strokes layer
			// is painted after the shapes layer (DOM order, no z-index), so
			// ink sits visually on top. Testing shapes first would make ink
			// drawn over a filled shape unselectable, since a filled shape
			// hits anywhere inside its rect. Nodes still win over ink: they
			// are interactive content, and a card must stay clickable even
			// with a stroke crossing it.
			const stroke = model.strokeAt(this.#doc, p.x, p.y, 8 / z);
			if (stroke) {
				if (e.shiftKey) this.#toggleSelect('strokes', stroke.id);
				else if (!this.#sel.strokes.has(stroke.id)) this.#select('strokes', stroke.id);
				this.#beginMove(e, p, null);
				return;
			}

			// 5. Shapes.
			const shape = model.shapeAt(this.#doc, p.x, p.y, 8 / z);
			if (shape) {
				if (e.shiftKey) this.#toggleSelect('shapes', shape.id);
				else if (!this.#sel.shapes.has(shape.id)) this.#select('shapes', shape.id);
				this.#beginMove(e, p, null);
				return;
			}

			// 6. Edges.
			const edge = this.#edgeAt(p, 8 / z);
			if (edge) {
				if (e.shiftKey) this.#toggleSelect('edges', edge.id);
				else this.#select('edges', edge.id);
				this.#syncEdges();
				this.#syncOverlay();
				return;
			}

			// 7. Empty: marquee.
			this.#startDrag(e, {
				type: 'marquee', start: p, current: p,
				base: e.shiftKey ? snapshotSel(this.#sel) : null,
			});
			if (!e.shiftKey) this.#clearSelection();
			return;
		}

		if (this.#tool === 'card') {
			this.#checkpoint();
			const node = this.#insertNode({
				type: 'text', text: '', x: p.x - 125, y: p.y - 50, width: 250, height: 100,
			});
			this.#setTool('select');
			this.#select('nodes', node.id);
			this.#mutated();
			this.#beginEdit(node);
			return;
		}

		if (this.#tool === 'draw') {
			this.#startDrag(e, {
				type: 'draw',
				stroke: {
					id: model.newId(), color: this.#ink.color, width: this.#ink.width,
					...(this.#shapeStyle.opacity < 1 ? { opacity: this.#shapeStyle.opacity } : {}),
					points: [round2(p.x), round2(p.y)],
				},
			});
			return;
		}

		if (this.#tool === 'erase') {
			this.#startDrag(e, { type: 'erase', current: p, erased: false });
			this.#eraseAt(p);
			return;
		}

		if (SHAPE_TOOLS.includes(this.#tool)) {
			this.#startDrag(e, {
				type: 'shape',
				shape: { id: model.newId(), kind: this.#tool, x: p.x, y: p.y, width: 0, height: 0, ...this.#shapeDefaults() },
			});
			return;
		}

		if (this.#tool === 'text') {
			this.#checkpoint();
			const st = this.#shapeStyle;
			const shape = {
				id: model.newId(), kind: 'text', x: p.x, y: p.y - st.fontSize * 0.8,
				width: 260, height: Math.round(st.fontSize * 1.7), text: '',
				...this.#shapeDefaults(), font: st.font, fontSize: st.fontSize,
			};
			this.#doc.shapes.push(shape);
			this.#setTool('select');
			this.#select('shapes', shape.id);
			this.#mutated();
			this.#beginTextEdit(shape);
		}
	};

	/** The style-bar defaults, as optional shape fields. */
	#shapeDefaults() {
		const st = this.#shapeStyle;
		return {
			color: st.color,
			...(st.fill ? { fill: true } : {}),
			...(st.fill && st.fillStyle === 'hachure' ? { fillStyle: 'hachure' } : {}),
			...(st.strokeStyle ? { strokeStyle: st.strokeStyle } : {}),
			...(st.rough !== 1 ? { rough: st.rough } : {}),
			...(st.opacity < 1 ? { opacity: st.opacity } : {}),
		};
	}

	#startDrag(e, drag) {
		this.#drag = drag;
		try { this.#els.viewport.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
	}

	#beginMove(e, p, node) {
		const targets = [];
		for (const id of this.#sel.nodes) {
			const n = this.#nodeById(id);
			if (n) targets.push({ obj: n, x: n.x, y: n.y });
		}
		// Dragging a group carries the nodes inside it.
		if (node?.type === 'group' && this.#sel.nodes.has(node.id)) {
			const rect = model.nodeRect(node);
			for (const n of this.#doc.nodes) {
				if (n.id === node.id || this.#sel.nodes.has(n.id)) continue;
				if (model.rectContains(rect, n.x + n.width / 2, n.y + n.height / 2)) {
					targets.push({ obj: n, x: n.x, y: n.y });
				}
			}
		}
		for (const id of this.#sel.shapes) {
			const s = this.#shapeById(id);
			if (s) targets.push({ obj: s, x: s.x, y: s.y });
		}
		// Strokes have no origin to offset — they carry a point array — so each
		// one moves from a snapshot taken here. Translating from the snapshot
		// rather than the live points keeps a long drag from accumulating
		// rounding error across hundreds of pointermove events.
		const strokeTargets = [];
		for (const id of this.#sel.strokes) {
			const s = this.#strokeById(id);
			if (s) strokeTargets.push({ obj: s, from: s.points.slice() });
		}
		this.#startDrag(e, { type: 'move', start: p, targets, strokeTargets, moved: false });
	}

	#onPointerMove = (e) => {
		if (!this.#drag) {
			// Hover tracking for anchors.
			if (this.#tool === 'select') {
				const p = this.#toWorld(e.clientX, e.clientY);
				const node = model.nodeAt(this.#doc, p.x, p.y);
				const id = node?.id ?? null;
				if (id !== this.#hoverId) {
					this.#hoverId = id;
					this.#syncOverlay();
				}
			}
			return;
		}
		const drag = this.#drag;
		const p = this.#toWorld(e.clientX, e.clientY);

		if (drag.type === 'pan') {
			this.#camera.x = drag.startCam.x + (e.clientX - drag.sx);
			this.#camera.y = drag.startCam.y + (e.clientY - drag.sy);
			this.#applyCamera();
			return;
		}

		if (drag.type === 'move') {
			const dx = p.x - drag.start.x;
			const dy = p.y - drag.start.y;
			if (!drag.moved && Math.hypot(dx, dy) * this.#camera.zoom > 3) {
				drag.moved = true;
				this.#checkpoint();
			}
			if (!drag.moved) return;
			for (const t of drag.targets) {
				t.obj.x = round2(t.x + dx);
				t.obj.y = round2(t.y + dy);
			}
			for (const t of drag.strokeTargets ?? []) {
				model.translateStroke(t.obj, t.from, dx, dy);
			}
			this.#syncNodes();
			this.#syncEdges();
			this.#syncShapes();
			this.#syncStrokes();
			this.#syncOverlay();
			return;
		}

		if (drag.type === 'resize') {
			if (!drag.checkpointed) {
				drag.checkpointed = true;
				this.#checkpoint();
			}
			const dx = p.x - drag.start.x;
			const dy = p.y - drag.start.y;
			const { target } = drag;
			if (target.kind === 'endpoint') {
				const s = target.obj;
				if (drag.handle === 'a') {
					s.x = round2(drag.startRect.x + dx);
					s.y = round2(drag.startRect.y + dy);
					s.width = round2(drag.startRect.width - dx);
					s.height = round2(drag.startRect.height - dy);
				} else {
					s.width = round2(drag.startRect.width + dx);
					s.height = round2(drag.startRect.height + dy);
				}
			} else {
				const minW = target.kind === 'shape' ? 12 : model.NODE_MIN_W;
				const minH = target.kind === 'shape' ? 12 : model.NODE_MIN_H;
				const next = model.resizeRect(drag.startRect, drag.handle, dx, dy, minW, minH);
				Object.assign(target.obj, {
					x: round2(next.x), y: round2(next.y),
					width: round2(next.width), height: round2(next.height),
				});
			}
			this.#syncNodes();
			this.#syncEdges();
			this.#syncShapes();
			this.#syncOverlay();
			return;
		}

		if (drag.type === 'edge') {
			drag.current = p;
			drag.snap = null;
			const over = model.nodeAt(this.#doc, p.x, p.y);
			if (over && over.id !== drag.fromNode) {
				const side = nearestSide(over, p);
				drag.snap = model.anchorPoint(over, side);
				drag.toNode = over.id;
				drag.toSide = side;
			} else {
				drag.toNode = null;
			}
			this.#syncOverlay();
			return;
		}

		if (drag.type === 'marquee') {
			drag.current = p;
			const rect = normRect(drag.start, drag.current);
			this.#sel.nodes = new Set(drag.base?.nodes ?? []);
			this.#sel.shapes = new Set(drag.base?.shapes ?? []);
			this.#sel.strokes = new Set(drag.base?.strokes ?? []);
			for (const n of this.#doc.nodes) {
				if (model.rectsIntersect(rect, model.nodeRect(n))) this.#sel.nodes.add(n.id);
			}
			for (const s of this.#doc.shapes) {
				if (model.rectsIntersect(rect, model.shapeRect(s))) this.#sel.shapes.add(s.id);
			}
			for (const s of this.#doc.strokes) {
				if (model.rectsIntersect(rect, model.strokeBounds(s))) this.#sel.strokes.add(s.id);
			}
			this.#expandToGroups();
			this.#syncNodes();
			this.#syncShapes();
			this.#syncStrokes();
			this.#syncOverlay();
			return;
		}

		if (drag.type === 'draw') {
			const pts = drag.stroke.points;
			const lx = pts[pts.length - 2], ly = pts[pts.length - 1];
			if (Math.hypot(p.x - lx, p.y - ly) * this.#camera.zoom < 2) return;
			pts.push(round2(p.x), round2(p.y));
			// Live preview: append to the strokes layer without a full sync.
			this.#els.strokes.innerHTML = this.#doc.strokes.map((s) =>
				strokeSvg(s, this.#sel.strokes.has(s.id))).join('') + strokeSvg(drag.stroke);
			return;
		}

		if (drag.type === 'erase') {
			drag.current = p;
			this.#eraseAt(p);
			this.#syncOverlay();
			return;
		}

		if (drag.type === 'shape') {
			drag.shape.width = round2(p.x - drag.shape.x);
			drag.shape.height = round2(p.y - drag.shape.y);
			this.#syncOverlay();
		}
	};

	#onPointerUp = (e) => {
		const drag = this.#drag;
		if (!drag) return;
		this.#drag = null;
		try { this.#els.viewport.releasePointerCapture(e.pointerId); } catch { /* released */ }

		if (drag.type === 'move' && drag.moved) {
			model.repickEdgeSides(this.#doc, new Set(drag.targets.map((t) => t.obj.id)));
			this.#mutated();
			return;
		}
		if (drag.type === 'resize' && drag.checkpointed) {
			model.repickEdgeSides(this.#doc, new Set([drag.target.obj.id]));
			this.#mutated();
			return;
		}
		if (drag.type === 'edge') {
			if (drag.toNode && drag.toNode !== drag.fromNode) {
				this.#checkpoint();
				this.#doc.edges.push({
					id: model.newId(),
					fromNode: drag.fromNode, fromSide: drag.fromSide,
					toNode: drag.toNode, toSide: drag.toSide,
				});
				this.#mutated();
			} else {
				this.#syncOverlay();
			}
			return;
		}
		if (drag.type === 'draw') {
			if (drag.stroke.points.length >= 4) {
				this.#checkpoint();
				this.#doc.strokes.push(drag.stroke);
				this.#mutated();
			} else {
				this.#syncStrokes();
			}
			return;
		}
		if (drag.type === 'erase') {
			if (drag.erased) this.#mutated();
			else this.#syncOverlay();
			return;
		}
		if (drag.type === 'shape') {
			const s = drag.shape;
			const big = Math.abs(s.width) > 8 || Math.abs(s.height) > 8;
			if (big) {
				if (s.kind !== 'line' && s.kind !== 'arrow') {
					// Normalize so width/height are positive for box shapes.
					const r = model.shapeRect(s);
					Object.assign(s, r);
				}
				this.#checkpoint();
				this.#doc.shapes.push(s);
				this.#setTool('select');
				this.#select('shapes', s.id);
				this.#mutated();
			} else {
				this.#setTool('select');
				this.#syncOverlay();
			}
			return;
		}
		if (drag.type === 'marquee' || drag.type === 'pan') this.#syncOverlay();
	};

	#eraseAt(p) {
		const threshold = 8 / this.#camera.zoom;
		const before = this.#doc.strokes.length;
		const survivors = this.#doc.strokes.filter((s) => !model.strokeHit(s, p.x, p.y, threshold));
		if (survivors.length !== before) {
			if (!this.#drag?.erased) {
				this.#checkpoint();
				if (this.#drag) this.#drag.erased = true;
			}
			this.#doc.strokes = survivors;
			model.pruneGroups(this.#doc);
			this.#syncStrokes();
			this.#save();
		}
	}

	// ---- hit helpers -------------------------------------------------------

	/** The solo selected node or shape, wrapped with handle semantics. Strokes
	 *  are deliberately absent: ink is a point array with no resize semantics,
	 *  so a selected stroke gets an outline but never handles. A stroke in the
	 *  selection also suppresses handles on anything else, since the drag
	 *  would then mean two different things at once. */
	#soloTarget() {
		if (this.#sel.strokes.size) return null;
		if (this.#sel.nodes.size === 1 && this.#sel.shapes.size === 0) {
			const node = this.#nodeById([...this.#sel.nodes][0]);
			return node ? { obj: node, kind: null } : null;
		}
		if (this.#sel.shapes.size === 1 && this.#sel.nodes.size === 0) {
			const shape = this.#shapeById([...this.#sel.shapes][0]);
			if (!shape) return null;
			if (shape.kind === 'line' || shape.kind === 'arrow') return { obj: shape, kind: 'endpoint' };
			return { obj: shape, kind: 'shape' };
		}
		return null;
	}

	#handleAt(solo, p, slop) {
		if (solo.kind === 'endpoint') {
			const s = solo.obj;
			if (Math.hypot(p.x - s.x, p.y - s.y) <= slop) return 'a';
			if (Math.hypot(p.x - (s.x + s.width), p.y - (s.y + s.height)) <= slop) return 'b';
			return null;
		}
		const rect = solo.kind === 'shape' ? model.shapeRect(solo.obj) : model.nodeRect(solo.obj);
		const positions = model.handlePositions(rect);
		for (const handle of model.HANDLES) {
			const pos = positions[handle];
			if (Math.hypot(p.x - pos.x, p.y - pos.y) <= slop) return handle;
		}
		return null;
	}

	#anchorAt(p, slop) {
		const candidates = [];
		if (this.#hoverId) {
			const node = this.#nodeById(this.#hoverId);
			if (node) candidates.push(node);
		}
		for (const id of this.#sel.nodes) {
			const node = this.#nodeById(id);
			if (node && !candidates.includes(node)) candidates.push(node);
		}
		const offset = 14 / this.#camera.zoom;
		for (const node of candidates) {
			for (const side of model.SIDES) {
				const a = model.anchorHandlePoint(node, side, offset);
				if (Math.hypot(p.x - a.x, p.y - a.y) <= slop) return { node, side };
			}
		}
		return null;
	}

	#edgeAt(p, slop) {
		for (let i = this.#doc.edges.length - 1; i >= 0; i--) {
			const edge = this.#doc.edges[i];
			const from = this.#nodeById(edge.fromNode);
			const to = this.#nodeById(edge.toNode);
			if (!from || !to) continue;
			if (model.edgeDistance(from, edge.fromSide, to, edge.toSide, p.x, p.y,
				this.#doc.edgeStyles[edge.id]?.path) <= slop) return edge;
		}
		return null;
	}

	// ---- selection ---------------------------------------------------------

	/** Every layer that can show selection state. */
	#syncSelectionViews() {
		this.#syncNodes();
		this.#syncShapes();
		this.#syncStrokes();
		this.#syncEdges();
		this.#syncOverlay();
	}

	/** How many groupable things are selected (edges are not groupable). */
	#selCount() {
		return this.#sel.nodes.size + this.#sel.shapes.size + this.#sel.strokes.size;
	}

	/** Grow the selection so that touching any group member takes the whole
	 *  group — the mechanism behind "moves as a unit". Every selection path
	 *  funnels through here, so a group can never be half-selected. */
	#expandToGroups() {
		if (!this.#doc.groups?.length) return;
		const next = model.expandSelection(this.#doc, this.#sel);
		this.#sel.nodes = next.nodes;
		this.#sel.shapes = next.shapes;
		this.#sel.strokes = next.strokes;
	}

	#select(kind, id) {
		this.#clearSelection(false);
		this.#sel[kind].add(id);
		this.#expandToGroups();
		this.#syncSelectionViews();
		this.#renderStylebar();
	}

	#toggleSelect(kind, id) {
		const memberKind = SEL_TO_MEMBER[kind];
		const group = memberKind ? model.groupOf(this.#doc, memberKind, id) : null;
		if (group) {
			// Shift-clicking one member toggles the whole group, so a group
			// never ends up partly selected and therefore partly moved.
			const on = this.#sel[kind].has(id);
			for (const m of group.members) {
				const set = this.#sel[MEMBER_TO_SEL[m.kind]];
				if (on) set.delete(m.id);
				else set.add(m.id);
			}
		} else if (this.#sel[kind].has(id)) {
			this.#sel[kind].delete(id);
		} else {
			this.#sel[kind].add(id);
		}
		this.#syncSelectionViews();
	}

	#clearSelection(sync = true) {
		this.#sel.nodes.clear();
		this.#sel.shapes.clear();
		this.#sel.strokes.clear();
		this.#sel.edges.clear();
		if (sync) this.#syncSelectionViews();
	}

	#selectAll() {
		this.#sel.nodes = new Set(this.#doc.nodes.map((n) => n.id));
		this.#sel.shapes = new Set(this.#doc.shapes.map((s) => s.id));
		this.#sel.strokes = new Set(this.#doc.strokes.map((s) => s.id));
		this.#syncAll();
	}

	/** Clone the selection (nodes, shapes, and edges between selected nodes),
	 *  offset a little, and select the clones. */
	#duplicateSelection() {
		if (this.#selCount() === 0) return;
		this.#checkpoint();
		const offset = 28;
		const idMap = new Map();
		const newNodes = [];
		for (const id of this.#sel.nodes) {
			const node = this.#nodeById(id);
			if (!node) continue;
			const clone = { ...node, id: model.newId(), x: node.x + offset, y: node.y + offset };
			idMap.set(id, clone.id);
			newNodes.push(clone);
		}
		this.#doc.nodes.push(...newNodes);
		for (const edge of [...this.#doc.edges]) {
			if (idMap.has(edge.fromNode) && idMap.has(edge.toNode)) {
				this.#doc.edges.push({
					...edge, id: model.newId(),
					fromNode: idMap.get(edge.fromNode), toNode: idMap.get(edge.toNode),
				});
			}
		}
		const newShapes = [];
		for (const id of this.#sel.shapes) {
			const shape = this.#shapeById(id);
			if (!shape) continue;
			const clone = { ...shape, id: model.newId(), x: shape.x + offset, y: shape.y + offset };
			idMap.set(id, clone.id);
			newShapes.push(clone);
		}
		this.#doc.shapes.push(...newShapes);
		const newStrokes = [];
		for (const id of this.#sel.strokes) {
			const stroke = this.#strokeById(id);
			if (!stroke) continue;
			const clone = {
				// Both coordinates shift by the same offset, so one map does.
				...stroke, id: model.newId(),
				points: stroke.points.map((v) => round2(v + offset)),
			};
			idMap.set(id, clone.id);
			newStrokes.push(clone);
		}
		this.#doc.strokes.push(...newStrokes);
		// Duplicating a whole group should yield a group, not loose parts.
		// Only groups entirely within the selection are reproduced; a partly
		// copied group would be a different grouping than the user sees.
		// Snapshotted: the loop pushes into the same array it reads.
		for (const g of [...(this.#doc.groups ?? [])]) {
			if (!g.members.every((m) => idMap.has(m.id))) continue;
			this.#doc.groups.push({
				id: model.newId(),
				members: g.members.map((m) => ({ kind: m.kind, id: idMap.get(m.id) })),
			});
		}
		this.#sel.nodes = new Set(newNodes.map((n) => n.id));
		this.#sel.shapes = new Set(newShapes.map((s) => s.id));
		this.#sel.strokes = new Set(newStrokes.map((s) => s.id));
		this.#sel.edges.clear();
		this.#mutated();
	}

	#deleteSelection() {
		if (this.#selCount() + this.#sel.edges.size === 0) return;
		this.#checkpoint();
		const gone = this.#sel.nodes;
		this.#doc.nodes = this.#doc.nodes.filter((n) => !gone.has(n.id));
		this.#doc.edges = this.#doc.edges.filter((e) =>
			!gone.has(e.fromNode) && !gone.has(e.toNode) && !this.#sel.edges.has(e.id));
		this.#doc.shapes = this.#doc.shapes.filter((s) => !this.#sel.shapes.has(s.id));
		this.#doc.strokes = this.#doc.strokes.filter((s) => !this.#sel.strokes.has(s.id));
		model.pruneGroups(this.#doc);
		const liveEdges = new Set(this.#doc.edges.map((e) => e.id));
		for (const id of Object.keys(this.#doc.nodeStyles)) {
			if (gone.has(id)) delete this.#doc.nodeStyles[id];
		}
		for (const id of Object.keys(this.#doc.edgeStyles)) {
			if (!liveEdges.has(id)) delete this.#doc.edgeStyles[id];
		}
		this.#clearSelection(false);
		this.#mutated();
	}

	// ---- creation ----------------------------------------------------------

	#insertNode(props) {
		const node = { id: model.newId(), ...props };
		this.#doc.nodes.push(node);
		return node;
	}

	#viewportCenterWorld() {
		const rect = this.#els.viewport.getBoundingClientRect();
		return this.#toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
	}

	#addFilePicker() {
		const files = [];
		const walk = (entries) => {
			for (const entry of entries ?? []) {
				if (entry.type === 'folder') walk(entry.children);
				else if (isNotePath(entry.path) || isViewablePath(entry.path)
					|| entry.path.toLowerCase().endsWith('.canvas')) files.push(entry.path);
			}
		};
		walk(vaultStore.tree);
		openListModal({
			placeholder: 'Add note or file to canvas…',
			items: files.map((path) => ({
				label: path.split('/').pop(),
				detail: path,
				run: () => this.#addFileNode(path),
			})),
			emptyText: 'No files',
		});
	}

	#addFileNode(path) {
		const c = this.#viewportCenterWorld();
		const size = isNotePath(path) ? { width: 420, height: 400 }
			: path.toLowerCase().endsWith('.pdf') ? { width: 480, height: 600 }
			: { width: 360, height: 280 };
		this.#checkpoint();
		const node = this.#insertNode({
			type: 'file', file: path,
			x: round2(c.x - size.width / 2), y: round2(c.y - size.height / 2), ...size,
		});
		this.#select('nodes', node.id);
		this.#mutated();
	}

	#addWebPrompt(initial = '') {
		this.#inlinePrompt({
			placeholder: 'https://…',
			value: initial,
			onCommit: (value) => {
				let url = value.trim();
				if (!url) return;
				if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
				const c = this.#viewportCenterWorld();
				this.#checkpoint();
				const node = this.#insertNode({
					type: 'link', url, x: round2(c.x - 240), y: round2(c.y - 180), width: 480, height: 360,
				});
				this.#select('nodes', node.id);
				this.#mutated();
			},
		});
	}

	/** Wrap the selected NODES in a JSON Canvas group node — a labelled frame
	 *  Obsidian also understands. Spatial: it carries whatever nodes sit inside
	 *  it. For grouping arbitrary objects (ink included) see #groupObjects. */
	#frameSelection() {
		const rects = [...this.#sel.nodes].map((id) => this.#nodeById(id)).filter(Boolean).map(model.nodeRect);
		if (rects.length === 0) return;
		const pad = 24;
		const minX = Math.min(...rects.map((r) => r.x)) - pad;
		const minY = Math.min(...rects.map((r) => r.y)) - pad - 24;
		const maxX = Math.max(...rects.map((r) => r.x + r.width)) + pad;
		const maxY = Math.max(...rects.map((r) => r.y + r.height)) + pad;
		this.#checkpoint();
		const group = { id: model.newId(), type: 'group', label: 'Group', x: round2(minX), y: round2(minY), width: round2(maxX - minX), height: round2(maxY - minY) };
		this.#doc.nodes.unshift(group); // groups paint first
		this.#select('nodes', group.id);
		this.#mutated();
	}

	// ---- object groups -----------------------------------------------------
	// Distinct from #frameSelection above. That creates a JSON Canvas group
	// NODE: a spatial frame Obsidian understands, which carries whatever nodes
	// happen to sit inside it. These are explicit membership sets that survive
	// members being moved apart and can hold ink and shapes — which the spec
	// has no concept of — so they live under the file's "clew" key.

	/** True when the selection touches any group (drives menu entries). */
	#selectionHasGroup() {
		return (this.#doc.groups ?? []).some((g) =>
			g.members.some((m) => this.#sel[MEMBER_TO_SEL[m.kind]].has(m.id)));
	}

	#groupObjects() {
		// Selection is pruned against the doc on every load and undo, so two
		// selected ids are two live objects.
		if (this.#selCount() < 2) return;
		this.#checkpoint();
		model.groupSelection(this.#doc, this.#sel);
		this.#expandToGroups();
		this.#mutated();
	}

	#ungroupObjects() {
		if (!this.#selectionHasGroup()) return;
		this.#checkpoint();
		model.ungroupSelection(this.#doc, this.#sel);
		this.#mutated();
	}

	// ---- text / label editing ---------------------------------------------

	#beginEdit(node) {
		if (node.type !== 'text') return;
		this.#editingId = node.id;
		const el = this.#nodeEls.get(node.id);
		if (!el) return;
		el.classList.add('is-editing');
		const textarea = document.createElement('textarea');
		textarea.className = 'canvas-text-input';
		textarea.value = node.text ?? '';
		textarea.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (e.key === 'Escape') this.#commitEdit();
		});
		textarea.addEventListener('blur', () => this.#commitEdit());
		el.append(textarea);
		textarea.focus();
		textarea.select();
	}

	#commitEdit() {
		if (!this.#editingId) return;
		const id = this.#editingId;
		this.#editingId = null;
		const el = this.#nodeEls.get(id);
		const textarea = el?.querySelector('.canvas-text-input');
		const node = this.#nodeById(id);
		let changed = false;
		if (textarea && node && textarea.value !== (node.text ?? '')) {
			this.#checkpoint();
			node.text = textarea.value;
			changed = true;
		}
		textarea?.remove();
		el?.classList.remove('is-editing');
		if (changed) this.#mutated();
		else this.#syncNodes();
	}

	/** Edit a text shape in place: a textarea overlaid in world space with
	 *  the shape's font, committed on blur/Escape. An empty commit deletes a
	 *  freshly created text shape. */
	#beginTextEdit(shape) {
		this.querySelector('.canvas-shape-text-input')?.remove();
		const r = model.shapeRect(shape);
		const textarea = document.createElement('textarea');
		textarea.className = 'canvas-shape-text-input';
		textarea.value = shape.text ?? '';
		textarea.style.left = `${r.x}px`;
		textarea.style.top = `${r.y}px`;
		textarea.style.width = `${Math.max(80, r.width)}px`;
		textarea.style.height = `${Math.max(28, r.height)}px`;
		textarea.style.fontFamily = TEXT_FONT_STACKS[shape.font] ?? TEXT_FONT_STACKS.hand;
		textarea.style.fontSize = `${shape.fontSize ?? 20}px`;
		textarea.style.color = inkColor(shape.color);
		// Hide the rendered shape while editing (the overlay replaces it).
		this.#els.strokes.querySelector(`[data-id="${shape.id}"]`)?.setAttribute('visibility', 'hidden');
		this.#els.shapes.querySelector(`[data-id="${shape.id}"]`)?.setAttribute('visibility', 'hidden');
		let done = false;
		const finish = (commit) => {
			if (done) return;
			done = true;
			const value = textarea.value;
			textarea.remove();
			this.#els.viewport.focus({ preventScroll: true });
			if (commit && value !== (shape.text ?? '')) {
				this.#checkpoint();
				if (value.trim() === '') {
					this.#doc.shapes = this.#doc.shapes.filter((x) => x.id !== shape.id);
					this.#sel.shapes.delete(shape.id);
				} else {
					shape.text = value;
					// Grow the box to fit new lines at the shape's line height.
					const lines = value.split('\n').length;
					const wanted = Math.round(lines * (shape.fontSize ?? 20) * 1.4 + 8);
					if (wanted > Math.abs(shape.height)) shape.height = wanted;
				}
				this.#mutated();
			} else {
				this.#syncShapes();
			}
		};
		textarea.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (e.key === 'Escape') finish(true);
		});
		textarea.addEventListener('blur', () => finish(true));
		textarea.addEventListener('pointerdown', (e) => e.stopPropagation());
		this.#els.world.append(textarea);
		textarea.focus();
		textarea.select();
	}

	/** Small floating input over the canvas (URLs, labels, group names). */
	#inlinePrompt({ placeholder, value, onCommit, at }) {
		this.querySelector('.canvas-inline-input')?.remove();
		const input = document.createElement('input');
		input.className = 'canvas-inline-input';
		input.placeholder = placeholder ?? '';
		input.value = value ?? '';
		const rect = this.#els.viewport.getBoundingClientRect();
		const pos = at ? this.#toScreen(at.x, at.y) : { x: rect.width / 2 - 160, y: rect.height / 3 };
		input.style.left = `${Math.max(8, Math.min(pos.x, rect.width - 328))}px`;
		input.style.top = `${Math.max(8, Math.min(pos.y, rect.height - 40))}px`;
		let done = false;
		const finish = (commit) => {
			if (done) return;
			done = true;
			const v = input.value;
			input.remove();
			this.#els.viewport.focus({ preventScroll: true });
			if (commit) onCommit(v);
		};
		input.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (e.key === 'Enter') finish(true);
			if (e.key === 'Escape') finish(false);
		});
		input.addEventListener('blur', () => finish(false));
		this.#els.viewport.append(input);
		input.focus();
		input.select();
	}

	// ---- engage (interactive content) -------------------------------------

	#engage(id) {
		if (this.#engagedId === id) return;
		this.#disengage();
		this.#engagedId = id;
		this.#nodeEls.get(id)?.classList.add('is-engaged');
	}

	#disengage() {
		if (!this.#engagedId) return;
		this.#nodeEls.get(this.#engagedId)?.classList.remove('is-engaged');
		this.#engagedId = null;
	}

	// ---- events: dblclick, keys, wheel, menu, paste ------------------------

	#onDblClick = (e) => {
		if (e.target.closest('.canvas-chrome, .canvas-inline-input')) return;
		const p = this.#toWorld(e.clientX, e.clientY);
		if (this.#tool !== 'select') return;

		const node = model.nodeAt(this.#doc, p.x, p.y);
		if (node) {
			if (node.type === 'text') this.#beginEdit(node);
			else if (node.type === 'group') this.#renameGroup(node);
			else if (node.type === 'file' && node.file?.toLowerCase().endsWith('.canvas')) {
				workspaceStore.openCanvas(node.file, { newTab: true });
			}
			else this.#engage(node.id);
			return;
		}
		const shape = model.shapeAt(this.#doc, p.x, p.y, 8 / this.#camera.zoom);
		if (shape) {
			if (shape.kind === 'text') this.#beginTextEdit(shape);
			else this.#editShapeLabel(shape);
			return;
		}
		const edge = this.#edgeAt(p, 8 / this.#camera.zoom);
		if (edge) {
			this.#editEdgeLabel(edge);
			return;
		}
		// Empty canvas: new card (the Obsidian gesture).
		this.#checkpoint();
		const card = this.#insertNode({ type: 'text', text: '', x: p.x - 125, y: p.y - 50, width: 250, height: 100 });
		this.#select('nodes', card.id);
		this.#mutated();
		this.#beginEdit(card);
	};

	#renameGroup(group) {
		this.#inlinePrompt({
			placeholder: 'Group name',
			value: group.label ?? '',
			at: { x: group.x, y: group.y - 34 },
			onCommit: (value) => {
				this.#checkpoint();
				group.label = value.trim();
				this.#mutated();
			},
		});
	}

	#editShapeLabel(shape) {
		const r = model.shapeRect(shape);
		this.#inlinePrompt({
			placeholder: 'Label',
			value: shape.label ?? '',
			at: { x: r.x + r.width / 2 - 80, y: r.y + r.height / 2 - 14 },
			onCommit: (value) => {
				this.#checkpoint();
				if (value.trim()) shape.label = value.trim();
				else delete shape.label;
				this.#mutated();
			},
		});
	}

	#editEdgeLabel(edge) {
		const from = this.#nodeById(edge.fromNode);
		const to = this.#nodeById(edge.toNode);
		if (!from || !to) return;
		const geo = model.edgeGeometry(from, edge.fromSide, to, edge.toSide);
		this.#inlinePrompt({
			placeholder: 'Edge label',
			value: edge.label ?? '',
			at: { x: geo.mid.x - 80, y: geo.mid.y - 14 },
			onCommit: (value) => {
				this.#checkpoint();
				if (value.trim()) edge.label = value.trim();
				else delete edge.label;
				this.#mutated();
			},
		});
	}

	#onKeyDown = (e) => {
		if (e.target.closest('input, textarea, [contenteditable], webview')) return;
		const mod = e.metaKey || e.ctrlKey;

		if (e.key === ' ') {
			this.#spaceHeld = true;
			this.#els.viewport.dataset.space = 'true';
			e.preventDefault();
			return;
		}
		if (mod && e.key.toLowerCase() === 'z') {
			e.preventDefault();
			e.stopPropagation();
			if (e.shiftKey) this.#redo();
			else this.#undo();
			return;
		}
		if (mod && e.key.toLowerCase() === 'a') {
			e.preventDefault();
			this.#selectAll();
			return;
		}
		if (mod && e.key.toLowerCase() === 'g') {
			e.preventDefault();
			e.stopPropagation();
			if (e.shiftKey) this.#ungroupObjects();
			else this.#groupObjects();
			return;
		}
		if (mod && e.key.toLowerCase() === 'd') {
			e.preventDefault();
			this.#duplicateSelection();
			return;
		}
		if (e.key === 'Backspace' || e.key === 'Delete') {
			e.preventDefault();
			this.#deleteSelection();
			return;
		}
		if (e.key === 'Escape') {
			if (this.#engagedId) this.#disengage();
			else if (this.#selCount() + this.#sel.edges.size) this.#clearSelection();
			else this.#setTool('select');
			return;
		}
		if (e.key === '!' || (e.shiftKey && e.key === '1')) {
			this.#zoomFit();
			return;
		}
		if (e.key.startsWith('Arrow')) {
			const step = (e.shiftKey ? 10 : 1);
			const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
			const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
			if (this.#sel.nodes.size + this.#sel.shapes.size > 0) {
				e.preventDefault();
				if (!this.#nudging) {
					this.#nudging = true;
					this.#checkpoint();
					setTimeout(() => { this.#nudging = false; }, 900);
				}
				for (const id of this.#sel.nodes) {
					const n = this.#nodeById(id);
					if (n) { n.x += dx; n.y += dy; }
				}
				for (const id of this.#sel.shapes) {
					const s = this.#shapeById(id);
					if (s) { s.x += dx; s.y += dy; }
				}
				this.#mutated();
			}
			return;
		}
		if (!mod) {
			const tool = TOOLS.find((t) => t.key === e.key.toLowerCase());
			if (tool) {
				this.#setTool(tool.id);
				return;
			}
		}
	};

	#nudging = false;

	#onKeyUp = (e) => {
		if (e.key === ' ') {
			this.#spaceHeld = false;
			delete this.#els.viewport.dataset.space;
		}
	};

	#onWheel = (e) => {
		e.preventDefault();
		const rect = this.#els.viewport.getBoundingClientRect();
		if (e.ctrlKey || e.metaKey) {
			const factor = Math.exp(-e.deltaY * 0.01);
			this.#zoomTo(this.#camera.zoom * factor, e.clientX - rect.left, e.clientY - rect.top);
		} else {
			this.#camera.x -= e.deltaX;
			this.#camera.y -= e.deltaY;
			this.#applyCamera();
		}
	};

	#onContextMenu = (e) => {
		e.preventDefault();
		if (e.target.closest('.canvas-chrome')) return;
		const p = this.#toWorld(e.clientX, e.clientY);
		const z = this.#camera.zoom;

		const node = model.nodeAt(this.#doc, p.x, p.y);
		if (node) {
			if (!this.#sel.nodes.has(node.id)) this.#select('nodes', node.id);
			this.#nodeMenu(node, e.clientX, e.clientY);
			return;
		}
		// Ink before shapes, matching both the paint order and #onPointerDown.
		const stroke = model.strokeAt(this.#doc, p.x, p.y, 8 / z);
		if (stroke) {
			if (!this.#sel.strokes.has(stroke.id)) this.#select('strokes', stroke.id);
			this.#strokeMenu(stroke, e.clientX, e.clientY);
			return;
		}
		const shape = model.shapeAt(this.#doc, p.x, p.y, 8 / z);
		if (shape) {
			if (!this.#sel.shapes.has(shape.id)) this.#select('shapes', shape.id);
			this.#shapeMenu(shape, e.clientX, e.clientY);
			return;
		}
		const edge = this.#edgeAt(p, 8 / z);
		if (edge) {
			this.#select('edges', edge.id);
			this.#syncEdges();
			this.#edgeMenu(edge, e.clientX, e.clientY);
			return;
		}
		this.#emptyMenu(p, e.clientX, e.clientY);
	};

	/** Group/Ungroup entries, shared by the node, shape and stroke menus.
	 *  Returns [] when neither applies, so callers can spread unconditionally. */
	#groupMenuItems() {
		const items = [];
		if (this.#selCount() > 1) items.push({ label: 'Group', click: () => this.#groupObjects() });
		if (this.#selectionHasGroup()) items.push({ label: 'Ungroup', click: () => this.#ungroupObjects() });
		if (items.length) items.push({ separator: true });
		return items;
	}

	#strokeMenu(stroke, x, y) {
		showCanvasMenu(x, y, [
			{ swatches: true, current: stroke.color ?? 'ink', onPick: (color) => {
				this.#checkpoint();
				for (const id of this.#sel.strokes) {
					const s = this.#strokeById(id);
					if (s) s.color = color;
				}
				this.#mutated();
			} },
			{ separator: true },
			...this.#groupMenuItems(),
			{ label: 'Bring to front', click: () => this.#reorderStrokes('front') },
			{ label: 'Send to back', click: () => this.#reorderStrokes('back') },
			{ separator: true },
			{ label: 'Delete', danger: true, click: () => this.#deleteSelection() },
		]);
	}

	#reorderStrokes(dir) {
		this.#checkpoint();
		if (model.reorder(this.#doc.strokes, this.#sel.strokes, dir)) this.#mutated();
	}

	#nodeMenu(node, x, y) {
		const items = [
			{ swatches: true, current: node.color ?? 'ink', onPick: (color) => {
				this.#checkpoint();
				for (const id of this.#sel.nodes) {
					const n = this.#nodeById(id);
					if (!n) continue;
					if (color === 'ink') delete n.color;
					else n.color = color;
				}
				this.#mutated();
			} },
			{ separator: true },
		];
		if (node.type === 'text') {
			items.push({ label: 'Edit card', click: () => this.#beginEdit(node) });
		}
		if (node.type === 'file') {
			items.push({ label: 'Open in tab', click: () => {
				if (isNotePath(node.file)) workspaceStore.openNote(node.file, { newTab: true });
				else if (node.file?.toLowerCase().endsWith('.canvas')) workspaceStore.openCanvas(node.file, { newTab: true });
				else workspaceStore.openFile(node.file, { newTab: true });
			} });
		}
		if (node.type === 'link') {
			items.push({ label: 'Open in browser', click: () => {
				ipc.invoke(CH.SHELL_OPEN_EXTERNAL, { url: node.url }).catch(() => {});
			} });
			items.push({ label: 'Edit URL…', click: () => this.#editLinkUrl(node) });
		}
		if (node.type === 'group') {
			items.push({ label: 'Rename group', click: () => this.#renameGroup(node) });
		}
		if (this.#selCount() > 1) {
			items.push({ label: 'Group', click: () => this.#groupObjects() });
		}
		if (this.#selectionHasGroup()) {
			items.push({ label: 'Ungroup', click: () => this.#ungroupObjects() });
		}
		if (this.#sel.nodes.size > 1) {
			items.push({ label: 'Enclose in frame', click: () => this.#frameSelection() });
		}
		const nstyle = this.#doc.nodeStyles[node.id] ?? {};
		if (node.type !== 'group') {
			items.push(
				{ separator: true },
				{ choices: true, label: 'Shape', current: nstyle.shape ?? null, options: [
					{ value: null, label: '▭', title: 'default' },
					{ value: 'pill', label: '⬭', title: 'pill (terminal)' },
					{ value: 'circle', label: '◯', title: 'circle' },
					{ value: 'diamond', label: '◇', title: 'diamond (decision)' },
					{ value: 'parallelogram', label: '▱', title: 'parallelogram (I/O)' },
					{ value: 'predefined', label: '▯▯', title: 'predefined process' },
				], onPick: (v) => this.#applyNodeStyle({ shape: v }) },
				{ choices: true, label: 'Border', current: nstyle.border ?? null, options: [
					{ value: null, label: '—', title: 'solid' },
					{ value: 'dashed', label: '- -', title: 'dashed' },
					{ value: 'dotted', label: '···', title: 'dotted' },
				], onPick: (v) => this.#applyNodeStyle({ border: v }) },
				{ choices: true, label: 'Fill', current: nstyle.bg ?? null, options: [
					{ value: null, label: '■', title: 'filled' },
					{ value: 'transparent', label: '□', title: 'transparent' },
				], onPick: (v) => this.#applyNodeStyle({ bg: v }) },
			);
		}
		items.push(
			{ separator: true },
			{ choices: true, label: 'Order', current: null, options: [
				{ value: 'front', label: '⤒', title: 'bring to front' },
				{ value: 'forward', label: '↑', title: 'bring forward' },
				{ value: 'backward', label: '↓', title: 'send backward' },
				{ value: 'back', label: '⤓', title: 'send to back' },
			], onPick: (dir) => {
				this.#checkpoint();
				const ids = this.#sel.nodes.size ? this.#sel.nodes : new Set([node.id]);
				if (model.reorder(this.#doc.nodes, ids, dir)) this.#mutated();
			} },
			{ separator: true },
			{ label: 'Delete', danger: true, click: () => this.#deleteSelection() },
		);
		showCanvasMenu(x, y, items);
	}

	/** Merge a style patch into every selected node's clew style entry. */
	#applyNodeStyle(patch) {
		this.#checkpoint();
		const ids = this.#sel.nodes.size ? this.#sel.nodes : new Set();
		for (const id of ids) {
			if (!this.#nodeById(id)) continue;
			const style = { ...(this.#doc.nodeStyles[id] ?? {}) };
			for (const [k, v] of Object.entries(patch)) {
				if (v == null) delete style[k];
				else style[k] = v;
			}
			if (Object.keys(style).length) this.#doc.nodeStyles[id] = style;
			else delete this.#doc.nodeStyles[id];
		}
		this.#mutated();
	}

	#editLinkUrl(node) {
		this.#inlinePrompt({
			placeholder: 'https://…',
			value: node.url,
			at: { x: node.x, y: node.y - 34 },
			onCommit: (value) => {
				let url = value.trim();
				if (!url) return;
				if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
				this.#checkpoint();
				node.url = url;
				this.#mutated();
			},
		});
	}

	#reorderNode(node, where) {
		this.#checkpoint();
		const list = this.#doc.nodes;
		list.splice(list.indexOf(node), 1);
		if (where === 'front') list.push(node);
		else list.unshift(node);
		this.#mutated();
	}

	#shapeMenu(shape, x, y) {
		const boxy = !['line', 'arrow'].includes(shape.kind);
		showCanvasMenu(x, y, [
			{ swatches: true, current: shape.color, onPick: (color) => {
				this.#checkpoint();
				for (const id of this.#sel.shapes) {
					const s = this.#shapeById(id);
					if (s) s.color = color;
				}
				this.#mutated();
			} },
			{ separator: true },
			...this.#groupMenuItems(),
			...(boxy ? [{ choices: true, label: 'Fill', current: shape.fill ? (shape.fillStyle ?? 'solid') : 'none', options: [
				{ value: 'none', label: '□' },
				{ value: 'solid', label: '■' },
				{ value: 'hachure', label: '▨' },
			], onPick: (v) => this.#applyShapeStyle(v === 'none'
				? { fill: false, fillStyle: 'solid' } : { fill: true, fillStyle: v }) }] : []),
			{ choices: true, label: 'Line', current: shape.strokeStyle ?? null, options: [
				{ value: null, label: '—' },
				{ value: 'dashed', label: '- -' },
				{ value: 'dotted', label: '···' },
			], onPick: (v) => this.#applyShapeStyle({ strokeStyle: v }) },
			{ choices: true, label: 'Slop', current: shape.rough ?? 1, options: [
				{ value: 0, label: '▭', title: 'clean' },
				{ value: 1, label: '≈', title: 'sketchy' },
				{ value: 2, label: '〰', title: 'scrawl' },
			], onPick: (v) => this.#applyShapeStyle({ rough: v }) },
			{ choices: true, label: 'Order', current: null, options: [
				{ value: 'front', label: '⤒', title: 'bring to front' },
				{ value: 'forward', label: '↑', title: 'bring forward' },
				{ value: 'backward', label: '↓', title: 'send backward' },
				{ value: 'back', label: '⤓', title: 'send to back' },
			], onPick: (dir) => {
				this.#checkpoint();
				const ids = this.#sel.shapes.size ? this.#sel.shapes : new Set([shape.id]);
				if (model.reorder(this.#doc.shapes, ids, dir)) this.#mutated();
			} },
			{ separator: true },
			...(shape.kind === 'text'
				? [{ label: 'Edit text', click: () => this.#beginTextEdit(shape) }]
				: [{ label: 'Edit label…', click: () => this.#editShapeLabel(shape) }]),
			{ separator: true },
			{ label: 'Delete', danger: true, click: () => this.#deleteSelection() },
		]);
	}

	#edgeMenu(edge, x, y) {
		showCanvasMenu(x, y, [
			{ swatches: true, current: edge.color ?? 'ink', onPick: (color) => {
				this.#checkpoint();
				if (color === 'ink') delete edge.color;
				else edge.color = color;
				this.#mutated();
			} },
			{ separator: true },
			{ choices: true, label: 'Arrows', current: `${edge.fromEnd ?? 'none'}-${edge.toEnd ?? 'arrow'}`, options: [
				{ value: 'none-arrow', label: '→' },
				{ value: 'arrow-arrow', label: '↔' },
				{ value: 'none-none', label: '—' },
			], onPick: (v) => {
				this.#checkpoint();
				const [fromEnd, toEnd] = v.split('-');
				if (fromEnd === 'arrow') edge.fromEnd = 'arrow'; else delete edge.fromEnd;
				if (toEnd === 'none') edge.toEnd = 'none'; else delete edge.toEnd;
				this.#mutated();
			} },
			{ choices: true, label: 'Line', current: this.#doc.edgeStyles[edge.id]?.dash ?? null, options: [
				{ value: null, label: '—' },
				{ value: 'dashed', label: '- -' },
				{ value: 'dotted', label: '···' },
			], onPick: (v) => this.#applyEdgeStyle(edge, { dash: v }) },
			{ choices: true, label: 'Path', current: this.#doc.edgeStyles[edge.id]?.path ?? null, options: [
				{ value: null, label: '↝', title: 'curved' },
				{ value: 'straight', label: '⟋', title: 'straight' },
				{ value: 'square', label: '⌐', title: 'square (flowchart)' },
			], onPick: (v) => this.#applyEdgeStyle(edge, { path: v }) },
			{ separator: true },
			{ label: 'Edit label…', click: () => this.#editEdgeLabel(edge) },
			{ separator: true },
			{ label: 'Delete', danger: true, click: () => this.#deleteSelection() },
		]);
	}

	#applyEdgeStyle(edge, patch) {
		this.#checkpoint();
		const style = { ...(this.#doc.edgeStyles[edge.id] ?? {}) };
		for (const [k, v] of Object.entries(patch)) {
			if (v == null) delete style[k];
			else style[k] = v;
		}
		if (Object.keys(style).length) this.#doc.edgeStyles[edge.id] = style;
		else delete this.#doc.edgeStyles[edge.id];
		this.#mutated();
	}

	#emptyMenu(p, x, y) {
		showCanvasMenu(x, y, [
			{ label: 'New card', click: () => {
				this.#checkpoint();
				const card = this.#insertNode({ type: 'text', text: '', x: p.x - 125, y: p.y - 50, width: 250, height: 100 });
				this.#select('nodes', card.id);
				this.#mutated();
				this.#beginEdit(card);
			} },
			{ label: 'Add note or file…', click: () => this.#addFilePicker() },
			{ label: 'Add web page…', click: () => this.#addWebPrompt() },
			{ separator: true },
			...(this.#selCount() > 1 ? [{ label: 'Group', click: () => this.#groupObjects() }] : []),
			...(this.#selectionHasGroup() ? [{ label: 'Ungroup', click: () => this.#ungroupObjects() }] : []),
			...(this.#sel.nodes.size > 1 ? [{ label: 'Enclose in frame', click: () => this.#frameSelection() }] : []),
			{ label: 'Select all', click: () => {
				this.#selectAll();
			} },
			{ label: 'Zoom to fit', click: () => this.#zoomFit() },
			{ separator: true },
			...(this.#doc.strokes.length || this.#doc.shapes.length ? [
				{ label: 'Export drawing as PNG…', click: () => this.exportDrawingPng() },
			] : []),
			{ label: 'Clear drawing', danger: true, click: () => {
				if (this.#doc.strokes.length === 0) return;
				this.#checkpoint();
				this.#doc.strokes = [];
				this.#mutated();
			} },
		]);
	}

	// ---- drawing export -------------------------------------------------------

	/**
	 * The drawing layer (ink strokes + shapes) as a standalone SVG document.
	 * shapeSvg/strokePath emit var(--clew-canvas-*) colors; the SVG carries the
	 * current theme's values inline, so it rasterizes identically anywhere.
	 */
	drawingSvg() {
		const items = [...this.#doc.strokes, ...this.#doc.shapes];
		if (items.length === 0) return null;
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		const grow = (x, y, m) => {
			minX = Math.min(minX, x - m); minY = Math.min(minY, y - m);
			maxX = Math.max(maxX, x + m); maxY = Math.max(maxY, y + m);
		};
		for (const s of this.#doc.strokes) {
			for (let i = 0; i < s.points.length; i += 2) grow(s.points[i], s.points[i + 1], s.width);
		}
		for (const s of this.#doc.shapes) {
			const r = model.shapeRect(s);
			grow(r.x, r.y, 6);
			grow(r.x + r.width, r.y + r.height, 6);
		}
		const pad = 24;
		const box = {
			x: minX - pad, y: minY - pad,
			width: maxX - minX + pad * 2, height: maxY - minY + pad * 2,
		};
		const style = getComputedStyle(this);
		const vars = ['bg', 'edge', 'ink', '1', '2', '3', '4', '5', '6']
			.map((k) => `--clew-canvas-${k}:${style.getPropertyValue(`--clew-canvas-${k}`).trim()};`)
			.join('');
		const strokes = this.#doc.strokes.map((stroke) => strokeSvg(stroke)).join('');
		const shapes = this.#doc.shapes.map((shape) => shapeSvg(shape, false)).join('');
		return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x} ${box.y} ${box.width} ${box.height}"`
			+ ` width="${Math.ceil(box.width)}" height="${Math.ceil(box.height)}">`
			+ `<style>:root{${vars}--clew-text-muted:${style.getPropertyValue('--clew-text-muted').trim()};}`
			+ `.canvas-stroke{fill:none;stroke-linecap:round;stroke-linejoin:round}`
			+ `.canvas-shape line,.canvas-shape rect,.canvas-shape ellipse,.canvas-shape polygon{stroke-width:2.5}`
			+ `.canvas-shape path{stroke-width:2.5}`
			+ `.canvas-shape-label{fill:var(--clew-text-muted);font:13px ${style.fontFamily.replace(/"/g, "'")}}`
			+ `</style>${strokes}${shapes}</svg>`;
	}

	/** Rasterize the drawing layer at 2x; resolves to a PNG data URL. */
	async drawingPngDataUrl() {
		const svg = this.drawingSvg();
		if (!svg) return null;
		const img = new Image();
		await new Promise((resolve, reject) => {
			img.onload = resolve;
			img.onerror = () => reject(new Error('drawing SVG failed to rasterize'));
			img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
		});
		const canvas = document.createElement('canvas');
		canvas.width = img.width * 2;
		canvas.height = img.height * 2;
		canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
		return canvas.toDataURL('image/png');
	}

	/** Menu action: rasterize and hand off to main for the save dialog.
	 *  `filePath` (smoke tests) skips the dialog. */
	async exportDrawingPng(filePath = null) {
		const dataUrl = await this.drawingPngDataUrl();
		if (!dataUrl) return null;
		const base = this.path.split('/').pop().replace(/\.canvas$/i, '');
		return ipc.invoke(CH.CANVAS_EXPORT_PNG, {
			data: dataUrl.slice('data:image/png;base64,'.length),
			name: `${base} drawing.png`,
			filePath,
		});
	}

	#onPaste = (e) => {
		if (e.target.closest('input, textarea, webview')) return;
		const text = e.clipboardData?.getData('text/plain')?.trim();
		if (!text) return;
		e.preventDefault();
		const c = this.#viewportCenterWorld();
		this.#checkpoint();
		let node;
		if (/^https?:\/\/\S+$/i.test(text)) {
			node = this.#insertNode({ type: 'link', url: text, x: round2(c.x - 240), y: round2(c.y - 180), width: 480, height: 360 });
		} else {
			node = this.#insertNode({ type: 'text', text, x: round2(c.x - 125), y: round2(c.y - 60), width: 250, height: 120 });
		}
		this.#select('nodes', node.id);
		this.#mutated();
	};

	// ---- live note embeds --------------------------------------------------

	#registerEmbed = (nodeId, iframe, path) => {
		this.#embeds.set(nodeId, { iframe, path, ready: false, pending: [] });
		ipc.invoke(CH.RENDER_SUBSCRIBE, { path }).catch(() => {});
	};

	#onMessage = (event) => {
		const msg = event.data;
		if (!msg || msg.source !== 'clew-preview') return;
		let embed = null;
		for (const candidate of this.#embeds.values()) {
			if (candidate.iframe.contentWindow === event.source) {
				embed = candidate;
				break;
			}
		}
		if (!embed) return;

		switch (msg.type) {
			case 'ready':
				embed.ready = true;
				this.#postEmbed(embed, { type: 'theme', theme: document.body.dataset.theme ?? 'dark' });
				for (const queued of embed.pending.splice(0)) this.#postEmbed(embed, queued);
				break;
			case 'link-click':
				actions.openWikilink(msg.target, { newTab: true });
				break;
			case 'external-link':
				ipc.invoke(CH.SHELL_OPEN_EXTERNAL, { url: msg.url }).catch(() => {});
				break;
			case 'checkbox-toggle':
				actions.toggleTaskLine(embed.path, msg.line, msg.checked);
				break;
			case 'task-toggle':
				actions.toggleTaskLine(msg.path, msg.line, msg.checked);
				break;
			case 'field-edit':
				// Kanban boards and query tables work ON the canvas too.
				actions.editNoteField(msg.path, msg.field, msg.value, msg.fieldSource);
				break;
			case 'api-request':
				handleApiRequest(msg, { sourcePath: embed.path })
					.then((response) => this.#postEmbed(embed, response));
				break;
			case 'morph-failed':
				embed.ready = false;
				embed.iframe.src = previewUrl(embed.path) + '?t=' + Date.now();
				break;
			// Canvas embeds ignore scroll sync and inverse search.
		}
	};

	#postEmbed(embed, msg) {
		if (!embed.ready) {
			embed.pending.push(msg);
			return;
		}
		embed.iframe.contentWindow?.postMessage({ source: HOST_SOURCE, ...msg }, '*');
	}

	async #refreshEmbeds(path) {
		const embeds = [...this.#embeds.values()].filter((embed) => embed.path === path);
		if (embeds.length === 0) return;
		try {
			const response = await fetch(previewUrl(path));
			const html = await response.text();
			for (const embed of embeds) this.#postEmbed(embed, { type: 'render', html });
		} catch (err) {
			console.error('Canvas embed refresh failed:', err);
		}
	}

	#broadcastTheme() {
		for (const embed of this.#embeds.values()) {
			this.#postEmbed(embed, { type: 'theme', theme: document.body.dataset.theme ?? 'dark' });
		}
	}
}

// ---- svg helpers -----------------------------------------------------------
// (inkColor/edgeColor/shapeSvg/edgeSvg/escapeXml live in canvas/shape-svg.js,
// shared with the read-only canvas embeds in note previews.)

function nearestSide(node, p) {
	let best = 'left';
	let bestDist = Infinity;
	for (const side of model.SIDES) {
		const a = model.anchorPoint(node, side);
		const d = Math.hypot(p.x - a.x, p.y - a.y);
		if (d < bestDist) {
			bestDist = d;
			best = side;
		}
	}
	return best;
}

function normRect(a, b) {
	return {
		x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
		width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y),
	};
}

/** Selection-set names <-> group member kinds. Edges appear in neither: they
 *  follow their endpoints and are not independently groupable. */
const MEMBER_TO_SEL = { node: 'nodes', shape: 'shapes', stroke: 'strokes' };
const SEL_TO_MEMBER = { nodes: 'node', shapes: 'shape', strokes: 'stroke' };

function snapshotSel(sel) {
	return { nodes: [...sel.nodes], shapes: [...sel.shapes], strokes: [...sel.strokes] };
}

function round2(n) {
	return Math.round(n * 100) / 100;
}

customElements.define('clew-canvas-view', ClewCanvasView);
