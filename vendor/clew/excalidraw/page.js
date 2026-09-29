// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The Excalidraw editor, hosted in a page of its own.
//
// WHY A PAGE AND NOT A COMPONENT. Excalidraw is React, and Clew is not: no
// frameworks anywhere else, by design. Rather than let React into the app's
// renderer bundle — where it would sit in memory for every user whether or not
// they own a single drawing — the editor lives in its own document under
// __clew_assets__/clewex/, loaded in an iframe by <clew-excalidraw-view>. React
// is downloaded, parsed and instantiated only when someone opens a drawing, and
// it can never reach the app's DOM or stores. It is the same containment the
// PDF viewer uses, for the same reason.
//
// WHY THIS FILE IS SHORT. It is a shim, not a port. Everything below is glue:
// fetch the file, hand the scene to <Excalidraw/>, take scenes back, save. No
// Excalidraw behaviour is reimplemented or patched, so upgrading is
// `npm install @excalidraw/excalidraw@latest` and a rebuild — nothing here
// should need to change. Resist the temptation to "improve" the editor here;
// anything worth fixing belongs upstream, where hundreds of thousands of
// people benefit from it.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, MainMenu } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { parseExcalidraw, serializeExcalidraw, embeddedFileLinks } from '../shared/excalidraw-file.js';

// Fonts and locale data, served from our own copy of the package. Without this
// Excalidraw fetches them from unpkg — a note app must open a drawing on a
// train, so nothing here is allowed to reach the network.
window.EXCALIDRAW_ASSET_PATH = '/__clew_assets__/excalidraw/';

const SAVE_DEBOUNCE_MS = 1000;

const params = new URLSearchParams(location.search);
const src = params.get('src');
const vaultPath = params.get('path');
// Embeds open read-only: reading a note should not put you one stray
// click away from altering a diagram.
const viewMode = params.get('view') === '1';
const root = document.getElementById('root');
const status = document.getElementById('status');
const setStatus = (text) => {
	status.textContent = text;
	status.style.opacity = text ? '1' : '0';
};

// ---- save bridge (editor → app page → main → disk) -------------------------

let saveSeq = 0;
const pending = new Map();

window.addEventListener('message', (event) => {
	const msg = event.data;
	// From the window the request went to, no other.
	if (!msg || msg.source !== 'clew-excalidraw-host' || event.source !== (window.top ?? window.parent)) return;
	const entry = pending.get(msg.id);
	if (!entry) return;
	pending.delete(msg.id);
	clearTimeout(entry.timer);
	if (msg.type === 'excalidraw-library-result') entry.resolve(msg.items ?? []);
	else if (msg.type === 'excalidraw-resolve-result') entry.resolve(msg.paths ?? {});
	else if (msg.ok) entry.resolve();
	else entry.reject(new Error(msg.error || 'save failed'));
});

/** Ask the app page something and wait for its reply. */
function ask(payload) {
	return new Promise((resolve, reject) => {
		const id = ++saveSeq;
		pending.set(id, {
			resolve, reject,
			timer: setTimeout(() => { pending.delete(id); reject(new Error('timed out')); }, 30_000),
		});
			// window.TOP, not window.parent. In a file tab or a canvas node the two
		// are the same, but an embed inside a rendered note sits two frames
		// deep — the parent there is the preview document, which has no bridge,
		// so a request to it simply never gets answered and boot() hangs.
		(window.top ?? window.parent).postMessage({ source: 'clew-excalidraw', id, ...payload }, '*');
	});
}

const saveText = (text) => ask({ type: 'excalidraw-save', path: vaultPath, text });

// ---- boot ------------------------------------------------------------------

async function boot() {
	setStatus('loading…');
	const text = await (await fetch(src)).text();
	const parsed = parseExcalidraw(text, vaultPath);
	if (!parsed) {
		setStatus('');
		root.textContent = 'This file does not contain an Excalidraw drawing.';
		return;
	}
	setStatus('');

	// The shape library is per vault, so a .excalidrawlib dropped onto the
	// canvas is still there tomorrow — Excalidraw itself keeps libraries in
	// browser storage, which for a note app means "until something clears it".
	// A read-only embed has no use for a shape library, and asking for one is
	// a round trip a note does not need while it renders.
	const libraryItems = viewMode ? [] : await ask({ type: 'excalidraw-library-load' }).catch(() => []);
	window.__clewExcalidrawLibraryCount = libraryItems.length;   // smoke hook

	// Obsidian's plugin keeps a pasted image OUT of the scene: the element has
	// only a fileId, the bytes live as a vault attachment, and the markdown's
	// "## Embedded Files" section maps one to the other. Resolve those links
	// (same resolution as a wikilink click, via the host) and rehydrate the
	// files map so the images actually appear — remembering which entries are
	// ours, because a save must strip them again or every save would copy the
	// image INTO the markdown.
	const { files: hydratedFiles, injected } = await rehydrateEmbeddedFiles(parsed);
	window.__clewExcalidrawInjected = injected.size;   // smoke hook

	// Excalidraw owns the scene from here; we keep only what saving needs.
	//
	// Nothing is written until the user actually does something. Excalidraw
	// fires onChange while mounting, and a normalised scene is rarely
	// byte-identical to what was on disk — so without this gate, merely opening
	// a drawing would rewrite it, showing up as a spurious change in every
	// vault under git or sync.
	let userHasEdited = false;
	const markEdited = () => { userHasEdited = true; };
	for (const type of ['pointerdown', 'keydown', 'paste', 'drop', 'wheel']) {
		window.addEventListener(type, markEdited, { capture: true, passive: true });
	}

	let saveTimer = null;
	let lastSaved = text;
	let saving = false;
	let again = false;

	const save = async (scene) => {
		if (saving) { again = true; return; }
		saving = true;
		try {
			const out = serializeExcalidraw(parsed, scene);
			if (out === lastSaved) { setStatus(''); return; }
			setStatus('saving…');
			await saveText(out);
			lastSaved = out;
			setStatus('saved');
			setTimeout(() => setStatus(''), 1500);
		} catch (err) {
			console.warn('[clew excalidraw] save failed:', err);
			setStatus('save failed');
		} finally {
			saving = false;
			if (again) { again = false; save(scene); }
		}
	};

	// onChange fires on pointer moves, selection, even hover — so the scene is
	// only assembled and written on a quiet debounce, and only when the bytes
	// actually differ from what is already on disk.
	const onChange = (elements, appState, files) => {
		if (!userHasEdited) return;
		clearTimeout(saveTimer);
		const kept = {};
		for (const [id, file] of Object.entries(files ?? parsed.scene.files ?? {})) {
			if (!injected.has(id)) kept[id] = file;
		}
		const scene = {
			...parsed.scene,
			type: 'excalidraw',
			version: 2,
			elements,
			appState: { ...parsed.scene.appState, ...pickPersisted(appState) },
			files: kept,
		};
		saveTimer = setTimeout(() => save(scene), SAVE_DEBOUNCE_MS);
	};

	createRoot(root).render(
		React.createElement(Excalidraw, {
			initialData: {
				elements: parsed.scene.elements ?? [],
				appState: { ...parsed.scene.appState, collaborators: new Map() },
				files: hydratedFiles,
				libraryItems,
				scrollToContent: true,
			},
			onChange: viewMode ? undefined : onChange,
			viewModeEnabled: viewMode,
			// Not in a read-only embed: it mounts with an EMPTY library (it
			// never loads one — see above), and Excalidraw reports that as a
			// change, which saved [] over the vault's library every time a
			// note embedding a drawing was opened (measured 2026-09-29).
			onLibraryChange: viewMode ? undefined : (items) => {
				ask({ type: 'excalidraw-library-save', items }).catch(() => {});
			},
			// Excalidraw's imperative handle. Kept on window so the smoke
			// harness can drive a real edit, and so a future host integration
			// (insert an image, react to a vault event) has the seam it needs
			// without reaching into React.
			excalidrawAPI: (api) => { window.__clewExcalidrawAPI = api; },
			theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
			UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false, export: false } },
		}, React.createElement(MainMenu, null,
			React.createElement(MainMenu.DefaultItems.ToggleTheme, null),
			React.createElement(MainMenu.DefaultItems.ChangeCanvasBackground, null),
		)),
	);
	window.__clewExcalidrawReady = true;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;

/**
 * The scene's files map, plus every image the markdown's Embedded Files
 * section can supply: resolve the wikilink targets to vault paths (host does
 * the resolving — same rules as clicking a wikilink), fetch the bytes over
 * the preview protocol this page already lives on, and hand Excalidraw
 * dataURL entries. A link that does not resolve, or points at something that
 * is not an image (the plugin also embeds note transclusions and drawing
 * areas this way), is simply left out — the element shows Excalidraw's own
 * missing-image placeholder, which is the truthful rendering.
 */
async function rehydrateEmbeddedFiles(parsed) {
	const files = { ...(parsed.scene.files ?? {}) };
	const injected = new Set();
	const needed = new Set((parsed.scene.elements ?? [])
		.filter((el) => el?.type === 'image' && el.fileId && !el.isDeleted && !files[el.fileId])
		.map((el) => el.fileId));
	const links = embeddedFileLinks(parsed.source).filter((l) => l.target && needed.has(l.id));
	if (!links.length) return { files, injected };

	const resolved = await ask({
		type: 'excalidraw-resolve-files',
		names: [...new Set(links.map((l) => l.target))],
	}).catch(() => ({}));
	// src is clew-preview://vault/<sid>/<path>; vault fetches share the sid.
	const sid = new URL(src, location.href).pathname.split('/')[1];

	await Promise.all(links.map(async (link) => {
		const path = resolved?.[link.target];
		if (!path || !IMAGE_EXT_RE.test(path)) return;
		try {
			const res = await fetch(`/${sid}/${path.split('/').map(encodeURIComponent).join('/')}`);
			if (!res.ok) return;
			const blob = await res.blob();
			const dataURL = await new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(reader.result);
				reader.onerror = () => reject(new Error('unreadable image'));
				reader.readAsDataURL(blob);
			});
			files[link.id] = {
				id: link.id,
				mimeType: blob.type || 'application/octet-stream',
				dataURL,
				created: Date.now(),
			};
			injected.add(link.id);
		} catch { /* placeholder rather than a failed open */ }
	}));
	return { files, injected };
}

/**
 * appState carries a lot of transient interface state (what is hovered, what
 * the cursor is doing). Only the drawing defaults are kept.
 *
 * Notably NOT scrollX/scrollY/zoom/theme. They are viewport state, not document
 * state, and they change the instant a drawing opens — scrollToContent recentres
 * it, and the theme follows the app — so persisting them meant every open and
 * every theme toggle rewrote the file.
 */
function pickPersisted(appState = {}) {
	const {
		gridSize, viewBackgroundColor, currentItemStrokeColor, currentItemBackgroundColor,
		currentItemFillStyle, currentItemStrokeWidth, currentItemStrokeStyle,
		currentItemRoughness, currentItemOpacity, currentItemFontFamily, currentItemFontSize,
		currentItemTextAlign, currentItemStartArrowhead, currentItemEndArrowhead,
	} = appState;
	return {
		gridSize, viewBackgroundColor, currentItemStrokeColor, currentItemBackgroundColor,
		currentItemFillStyle, currentItemStrokeWidth, currentItemStrokeStyle,
		currentItemRoughness, currentItemOpacity, currentItemFontFamily, currentItemFontSize,
		currentItemTextAlign, currentItemStartArrowhead, currentItemEndArrowhead,
	};
}

// The app owns the theme; follow it so a drawing is not a white slab in a dark
// window. Excalidraw re-reads `theme` from props, so a reload is not needed.
window.addEventListener('message', (event) => {
	const msg = event.data;
	if (msg?.source === 'clew-preview-host' && msg.type === 'theme') {
		document.documentElement.dataset.theme = msg.theme;
	}
});

boot().catch((err) => {
	console.warn('[clew excalidraw] failed to open:', err);
	window.__clewExcalidrawError = String(err?.message ?? err);
	setStatus('failed');
	root.textContent = `Could not open this drawing: ${err?.message ?? err}`;
});
