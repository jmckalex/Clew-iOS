// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The preview client, injected into every rendered note document served via
// clew-preview://. Bridges the iframe to the app (postMessage both ways) and
// morphdom-patches re-renders in place so scroll position and rendered math
// survive updates.
import morphdom from 'morphdom';
import { anchorTarget } from './anchors.js';
import { initCanvasEmbeds, refreshCanvasEmbeds, broadcastThemeToNested } from './canvas-embed.js';
import { initLeafletMaps } from './leaflet-maps.js';
import { initQueryInteract } from './query-interact.js';
import { initMetaBind } from './meta-bind.js';
import { initPdfEmbeds } from './pdf-embed.js';
import { initExcalidrawEmbeds } from './excalidraw-embed.js';

const HOST_SOURCE = 'clew-preview-host';
const post = (msg) => window.parent.postMessage({ source: 'clew-preview', ...msg }, '*');

// ---- inbound: host → preview ---------------------------------------------

window.addEventListener('message', (event) => {
	const msg = event.data;
	if (!msg || msg.source !== HOST_SOURCE) return;
	if (msg.type === 'render') applyRender(msg.html);
	else if (msg.type === 'scroll-to-line') scrollToLine(msg.line, msg.behavior ?? 'auto');
	else if (msg.type === 'theme') {
		document.documentElement.dataset.theme = msg.theme;
		configureMermaid(msg.theme);
		broadcastThemeToNested(msg.theme);
	}
	else if (msg.type === 'canvas-changed') refreshCanvasEmbeds(msg.path);
	else if (msg.type === 'app-chords') appChords = new Set(msg.chords ?? []);
	else if (msg.type === 'error') showError(msg.message);
	else if (msg.type === 'clear-error') showError(null);
});

// ---- mermaid theming -------------------------------------------------------
// mermaid.min.js loads in <head>; we take over its startup so diagrams render
// with a theme matching the app, and re-render (from snapshotted sources)
// when the theme changes.
let mermaidTheme = null;
window.mermaid?.initialize({ startOnLoad: false });

function runMermaid() {
	if (!window.mermaid) return;
	for (const div of document.querySelectorAll('.mermaid')) {
		if (!div.dataset.mermaidSrc) div.dataset.mermaidSrc = div.textContent;
	}
	window.mermaid.run({ querySelector: '.mermaid' }).catch?.(() => {});
}

function configureMermaid(appTheme) {
	if (!window.mermaid) return;
	const theme = appTheme === 'light' ? 'default' : 'dark';
	if (theme === mermaidTheme) return;
	mermaidTheme = theme;
	window.mermaid.initialize({ startOnLoad: false, theme });
	for (const div of document.querySelectorAll('.mermaid')) {
		if (div.dataset.mermaidSrc) {
			div.removeAttribute('data-processed');
			div.textContent = div.dataset.mermaidSrc;
		}
	}
	runMermaid();
}

function applyRender(html) {
	try {
		const next = new DOMParser().parseFromString(html, 'text/html');
		morphdom(document.body, next.body, {
			// Scripts must not be re-executed or replaced mid-flight; canvas
			// embed scenes are client-rendered (absent from incoming HTML).
			onBeforeElUpdated(fromEl, toEl) {
				if (fromEl.tagName === 'SCRIPT') return false;
				if (fromEl.id === '__clew_err') return false;
				// A Meta Bind widget mid-interaction must not be yanked back
				// to the on-disk value by an unrelated re-render.
				if (fromEl.classList?.contains('clew-mb') && fromEl === document.activeElement) return false;
				if (fromEl.classList?.contains('canvas-embed-scene')) return false;
				// Custom elements (vault scripts / Script: metadata) render
				// their own content, which the incoming HTML doesn't carry —
				// morphing their subtree would wipe it. Keep the element and
				// sync attributes instead, so attributeChangedCallback fires.
				if (fromEl.tagName.includes('-') && fromEl.tagName === toEl.tagName) {
					for (const attr of [...toEl.attributes]) {
						if (fromEl.getAttribute(attr.name) !== attr.value) {
							fromEl.setAttribute(attr.name, attr.value);
						}
					}
					for (const attr of [...fromEl.attributes]) {
						if (!toEl.hasAttribute(attr.name)) fromEl.removeAttribute(attr.name);
					}
					return false;
				}
				// Initialized maps hold live Leaflet state; replace only when
				// the fence config actually changed.
				if (fromEl.classList?.contains('clew-leaflet') && fromEl.dataset.leafletInit) {
					if (fromEl.dataset.leaflet === toEl.dataset?.leaflet) return false;
					fromEl.replaceChildren();
					delete fromEl.dataset.leafletInit;
				}
				return !fromEl.isEqualNode(toEl);
			},
			onBeforeNodeDiscarded(node) {
				if (node.tagName === 'SCRIPT') return false;
				if (node.id === '__clew_err') return false;
				// Chrome a plugin or vault script added to the document — a
				// banner, an overlay — is absent from the incoming HTML and
				// would be discarded on every morph, taking any running
				// animation or media playback down with it. Opt in to
				// surviving by setting data-clew-keep on the element.
				if (node.nodeType === 1 && node.hasAttribute?.('data-clew-keep')) return false;
				return true;
			},
		});
		showError(null);
		enableTaskCheckboxes();
		initCanvasEmbeds();
		initLeafletMaps();
		initPdfEmbeds();
		initExcalidrawEmbeds();
		retypeset();
		// Morphs never re-execute scripts; note-API controls re-bind on this.
		document.dispatchEvent(new CustomEvent('clew:render'));
	} catch (err) {
		console.error('morph failed', err);
		post({ type: 'morph-failed' });
	}
}

function retypeset() {
	if (window.MathJax?.typesetPromise) {
		window.MathJax.typesetClear?.();
		window.MathJax.typesetPromise().catch(() => {});
	}
	runMermaid();
}

// The engine renders task checkboxes disabled; make them live so clicks can
// write back to the source. Re-run after every morph.
function enableTaskCheckboxes() {
	for (const box of document.querySelectorAll('li input[type="checkbox"][disabled]')) {
		box.removeAttribute('disabled');
	}
}

document.addEventListener('change', (e) => {
	const box = e.target;
	if (box?.type !== 'checkbox') return;
	// Meta Bind toggles are FIELD edits, not task toggles; their own
	// handler (meta-bind.js) owns them.
	if (box.classList.contains('clew-mb')) return;
	// A ```tasks item carries its SOURCE note; route the toggle there.
	const remote = box.closest('[data-task-path]');
	if (remote) {
		post({
			type: 'task-toggle',
			path: remote.dataset.taskPath,
			line: Number(remote.dataset.taskLine),
			checked: box.checked,
		});
		return;
	}
	const stamped = box.closest('[data-source-line]');
	if (!stamped) return;
	post({
		type: 'checkbox-toggle',
		line: Number(stamped.dataset.sourceLine),
		checked: box.checked,
	});
});

function showError(message) {
	let el = document.getElementById('__clew_err');
	if (!message) {
		el?.remove();
		return;
	}
	if (!el) {
		el = document.createElement('div');
		el.id = '__clew_err';
		document.body.append(el);
	}
	el.textContent = message;
}

// ---- outbound: preview → host --------------------------------------------

// Internal/external link clicks. Capture phase so nothing in the rendered
// document can navigate the iframe away.
document.addEventListener('click', (e) => {
	// Cmd/Ctrl+click anywhere = inverse search (jump the editor to this line).
	if (e.metaKey || e.ctrlKey) {
		const stamped = e.target.closest?.('[data-source-line]');
		if (stamped && !e.target.closest('a')) {
			e.preventDefault();
			post({ type: 'source-line-click', line: Number(stamped.dataset.sourceLine) });
			return;
		}
	}
	const link = e.target.closest?.('a');
	if (!link) return;
	if (link.classList.contains('internal-link')) {
		e.preventDefault();
		post({ type: 'link-click', target: link.dataset.href, newTab: e.metaKey || e.ctrlKey });
		return;
	}
	const href = link.getAttribute('href') ?? '';
	if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('clew-preview:')) {
		e.preventDefault();
		post({ type: 'external-link', url: href });
	} else if (href.startsWith('#')) {
		// In-document anchor. The wild writes GitHub-style hashes
		// (#deep-work) while the engine ids headings toc-<slug>; resolve
		// rather than letting the browser silently miss (anchors.js). The
		// jump is browser-style navigation, so tell the host where we left
		// from and where we landed — that is what makes Back work.
		e.preventDefault();
		const target = anchorTarget(href);
		if (target) {
			post({ type: 'anchor-jump', fromLine: topVisibleLine(), toLine: lineOf(target) });
			target.scrollIntoView({ block: 'start' });
		}
	} else {
		e.preventDefault(); // unknown relative navigation — never leave the doc
	}
}, true);

// Forward app-level chords while the preview has focus — the iframe swallows
// keydown, so without this every app shortcut is dead the moment a click
// lands in reading mode (which read, from the outside, as "the menu commands
// are broken"). The host sends its full effective chord list on ready
// ('app-chords'); we forward exactly those, which also means chords the app
// does NOT own — Cmd+C, text selection, find — stay the browser's.
let appChords = null;
const isMacLike = /Mac|iP(hone|ad|od)/.test(navigator.platform);

// Mirrors the registry's chordOf(): same names, same order, so membership
// tests against the host's normalized chord list are exact.
function chordOf(e) {
	const parts = [];
	if (isMacLike) {
		if (e.metaKey) parts.push('Mod');
		if (e.ctrlKey) parts.push('Ctrl');
	} else {
		if (e.ctrlKey) parts.push('Mod');
		if (e.metaKey) parts.push('Meta');
	}
	if (e.altKey) parts.push('Alt');
	if (e.shiftKey) parts.push('Shift');
	let key = e.key;
	if (key === ' ') key = 'Space';
	if (key.length === 1) key = key.toLowerCase();
	if (['Meta', 'Control', 'Alt', 'Shift'].includes(key)) return null;
	parts.push(key);
	return parts.join('-');
}

window.addEventListener('keydown', (e) => {
	if (!(e.metaKey || e.ctrlKey)) return;
	if (appChords) {
		const chord = chordOf(e);
		if (chord && appChords.has(chord)) {
			e.preventDefault();
			post({ type: 'app-chord', chord });
		}
		return;
	}
	// Host predates 'app-chords' (a stale cached document): the historic four.
	const key = e.key.toLowerCase();
	if (['e', 'w', 't', '\\'].includes(key)) {
		e.preventDefault();
		post({ type: 'chord', key, shift: e.shiftKey, alt: e.altKey });
	}
});

// Clicking into the preview must focus its pane, exactly as clicking into an
// editor does — the app's pointerdown tracking cannot see inside this iframe.
window.addEventListener('pointerdown', () => post({ type: 'focused' }), true);

/** The topmost stamped line in view — where the reader currently "is". */
function topVisibleLine() {
	for (const el of document.querySelectorAll('[data-source-line]')) {
		if (el.getBoundingClientRect().bottom > 0) return Number(el.dataset.sourceLine) || 1;
	}
	return 1;
}

/** The source line an element belongs to: itself, a stamped ancestor, or
 *  the last stamped element before it in document order. */
function lineOf(el) {
	const stamped = el.closest?.('[data-source-line]');
	if (stamped) return Number(stamped.dataset.sourceLine) || 1;
	let line = 1;
	for (const s of document.querySelectorAll('[data-source-line]')) {
		if (s.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
			line = Number(s.dataset.sourceLine) || line;
		} else break;
	}
	return line;
}

// Report scroll position (topmost stamped block + fraction) for scroll-sync.
let scrollTicking = false;
window.addEventListener('scroll', () => {
	if (scrollTicking) return;
	scrollTicking = true;
	requestAnimationFrame(() => {
		scrollTicking = false;
		const stamped = [...document.querySelectorAll('[data-source-line]')];
		let topmost = null;
		for (const el of stamped) {
			const rect = el.getBoundingClientRect();
			if (rect.bottom > 0) { topmost = { el, rect }; break; }
		}
		if (topmost) {
			const { el, rect } = topmost;
			const fraction = rect.height > 0 ? Math.min(1, Math.max(0, -rect.top / rect.height)) : 0;
			post({ type: 'scrolled', line: Number(el.dataset.sourceLine), fraction });
		}
	});
}, { passive: true });

function scrollToLine(line, behavior) {
	const stamped = [...document.querySelectorAll('[data-source-line]')]
		.map((el) => ({ el, line: Number(el.dataset.sourceLine) }))
		.filter((x) => Number.isFinite(x.line))
		.sort((a, b) => a.line - b.line);
	if (stamped.length === 0) return;
	// Floor match: the stamped element with the greatest line ≤ requested.
	let target = stamped[0];
	for (const x of stamped) {
		if (x.line <= line) target = x;
		else break;
	}
	target.el.scrollIntoView({ behavior, block: 'start' });
}

enableTaskCheckboxes();
initCanvasEmbeds();
initLeafletMaps();
initPdfEmbeds();
initExcalidrawEmbeds();
initQueryInteract();
initMetaBind();
post({ type: 'ready' });
