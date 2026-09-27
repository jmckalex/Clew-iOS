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
import { initOfficeEmbeds } from './office-embed.js';
import { figureMorph, initFigures, figuresPending } from './figures.js';

const HOST_SOURCE = 'clew-preview-host';
const post = (msg) => window.parent.postMessage({ source: 'clew-preview', ...msg }, '*');
// A live-edit BLOCK document (protocol.js `__clew_block__`): one rendered
// block in a frame sized to its content, inside the editor. It has no scroll
// of its own and no source lines worth reporting, so the reading-mode
// behaviours below stand down; instead it reports its height.
const BLOCK = document.documentElement.dataset.clewBlock === '1';

// ---- inbound: host → preview ---------------------------------------------

window.addEventListener('message', (event) => {
	const msg = event.data;
	if (!msg || msg.source !== HOST_SOURCE) return;
	if (msg.type === 'render') applyRender(msg.html);
	else if (msg.type === 'scroll-to-line') scrollToLine(msg.line, msg.behavior ?? 'auto');
	else if (msg.type === 'theme') {
		document.documentElement.dataset.theme = msg.theme;
		// Web Awesome widgets pick their palette from these classes.
		document.documentElement.classList.toggle('wa-dark', msg.theme !== 'light');
		document.documentElement.classList.toggle('wa-light', msg.theme === 'light');
		configureMermaid(msg.theme);
		broadcastThemeToNested(msg.theme);
	}
	else if (msg.type === 'canvas-changed') refreshCanvasEmbeds(msg.path);
	else if (msg.type === 'sidenotes') { sidenoteMode = msg.mode ?? 'auto'; layoutSidenotes(); }
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
				// Hydrated office thumbnails are client-rendered (the incoming
				// HTML carries an empty shell) — keep them unless the embed now
				// points at a different document.
				if (fromEl.classList?.contains('office-embed-thumb') && fromEl.dataset.officeRequested
					&& fromEl.dataset.officePath === toEl.dataset?.officePath) return false;
				// TikZ/MetaPost figures are custom elements too, but they own
				// a rendered SVG the incoming HTML does not carry AND must
				// re-typeset when the figure itself changes — neither of which
				// the generic rule below can tell apart (figures.js).
				const figure = figureMorph(fromEl, toEl);
				if (figure !== null) return figure;
				// Custom elements (vault scripts / Script: metadata) render
				// their own content, which the incoming HTML doesn't carry —
				// morphing their subtree would wipe it. Keep the element and
				// sync attributes instead, so attributeChangedCallback fires.
				// Web Awesome elements are the exception: their light DOM IS
				// the incoming HTML (a wa-badge's text, a wa-select's
				// options), so they take the normal morph — the focused-widget
				// guard above already protects mid-interaction state. But the
				// component owns its host inline style (wa-progress-bar keeps
				// --percentage there), which the incoming HTML never carries —
				// hand it across so the attribute sync doesn't strip it.
				if (fromEl.tagName.startsWith('WA-')) {
					if (fromEl.hasAttribute('style') && !toEl.hasAttribute('style')) {
						toEl.setAttribute('style', fromEl.getAttribute('style'));
					}
					return !fromEl.isEqualNode(toEl);
				}
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
			onBeforeNodeAdded(node) {
				// Incoming live office iframes never boot in the flow: the
				// hoisted holder (office-embed.js) owns the real editor, and a
				// flow iframe would start a second LibreOffice just for the
				// post-morph hydration to throw away. Neutralized, it becomes
				// the placeholder marker hydration expects.
				if (node.nodeType === 1 && node.classList?.contains('office-embed-live')) {
					node.dataset.liveSrc = node.getAttribute('src') ?? '';
					node.removeAttribute('src');
				}
				return node;
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
		initFigures();
		initPdfEmbeds();
		initExcalidrawEmbeds();
		initOfficeEmbeds();
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

// Collapsible note embeds (`![[Note|collapsed]]`). The disclosure is native
// <details>, so this listener is only about PERSISTING it: the state belongs
// to the note's own source, not to this session. `toggle` does not bubble,
// hence the capture phase. An embed with no data-embed-line is a nested one,
// whose line belongs to another file — it still discloses, just for now.
document.addEventListener('toggle', (e) => {
	const box = e.target;
	if (!box?.classList?.contains('internal-embed')) return;
	const line = Number(box.dataset.embedLine);
	if (!Number.isFinite(line) || line < 1) return;
	post({ type: 'embed-collapse', line, collapsed: !box.open });
}, true);

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
	if ((e.metaKey || e.ctrlKey) && !BLOCK) {
		const stamped = e.target.closest?.('[data-source-line]');
		if (stamped && !e.target.closest('a')) {
			e.preventDefault();
			post({ type: 'source-line-click', line: Number(stamped.dataset.sourceLine) });
			return;
		}
	}
	const link = e.target.closest?.('a');
	if (!link) return;
	// [[file|external]] — hand it to the OS rather than opening a Clew tab.
	if (link.dataset.openExternal) {
		e.preventDefault();
		post({ type: 'open-external-file', path: link.dataset.openExternal });
		return;
	}
	if (link.classList.contains('internal-link')) {
		e.preventDefault();
		post({ type: 'link-click', target: link.dataset.href, newTab: e.metaKey || e.ctrlKey });
		return;
	}
	const href = link.getAttribute('href') ?? '';
	if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('clew-preview:')) {
		e.preventDefault();
		post({ type: 'external-link', url: href });
	} else if (href.startsWith('#') && BLOCK) {
		e.preventDefault(); // a block has no document to jump around in
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
	if (scrollTicking || BLOCK) return;
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

// Block documents report their height: the frame layer sizes the frame and
// the editor's placeholder to it. Rendered content resizes late and on its
// own (MathJax, mermaid, figures, maps, images, fonts), so every change is
// watched and settled for 50ms before one `size` goes out — only when it
// moved by a pixel or more.
function reportSize() {
	let last = -1;
	let timer = null;
	const send = () => {
		timer = null;
		// The BODY's box, not documentElement.scrollHeight: the latter is
		// never less than the frame's own viewport, so a block would only
		// ever report the height it was given and could never shrink to fit
		// (measured: an 84px mermaid block in a 240px frame reported 236).
		const height = Math.ceil(document.body.getBoundingClientRect().height);
		if (Math.abs(height - last) < 1) return;
		last = height;
		post({ type: 'size', height });
	};
	const soon = () => { if (!timer) timer = setTimeout(send, 50); };
	new ResizeObserver(soon).observe(document.body);
	new MutationObserver(soon).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
	document.fonts?.ready.then(soon);
	window.addEventListener('load', soon);
	soon();
}

// Sidenotes (docs/dev/live-edit.md §5.16): when the page is wide enough,
// each footnote's body sits in the right margin beside the text that cites
// it. The engine's endnote list stays in the document (print and export are
// untouched) and is hidden by a body class; the notes are CLONES in a layer
// the morph keeps (data-clew-keep), laid out again after every render and
// on resize. `auto`: a page ≥ 960 px wide with ≥ 220 px of margin.
let sidenoteMode = 'auto';
const SIDENOTE_GAP = 24;
function layoutSidenotes() {
	let layer = document.querySelector('.clew-sidenotes');
	const refs = [...document.querySelectorAll('sup.footnote-ref a[href^="#fn-"]')];
	const body = document.body.getBoundingClientRect();
	const margin = window.innerWidth - body.right;
	const on = refs.length > 0 && sidenoteMode !== 'off'
		&& (sidenoteMode === 'on' || (window.innerWidth >= 960 && margin >= 220));
	document.body.classList.toggle('clew-sidenotes-on', on);
	if (!on) { layer?.remove(); return; }
	if (!layer) {
		layer = document.createElement('div');
		layer.className = 'clew-sidenotes';
		layer.setAttribute('data-clew-keep', '');
		document.body.append(layer);
	}
	const left = body.right + window.scrollX + SIDENOTE_GAP;
	const width = Math.max(140, Math.min(300, margin - SIDENOTE_GAP * 2));
	const notes = [];
	for (const a of refs) {
		const item = document.getElementById(a.getAttribute('href').slice(1));
		if (!item) continue;
		const note = document.createElement('aside');
		note.className = 'clew-sidenote';
		note.dataset.for = a.getAttribute('href').slice(1);
		const number = document.createElement('span');
		number.className = 'clew-sidenote-number';
		number.textContent = a.textContent;
		for (const child of item.childNodes) note.append(child.cloneNode(true));
		note.querySelectorAll('.footnote-backref').forEach((b) => b.remove());
		// The number runs into the note's first paragraph, as a sidenote's does.
		const first = note.querySelector('p') ?? note;
		first.prepend(number, ' ');
		notes.push({ note, top: a.getBoundingClientRect().top + window.scrollY });
	}
	layer.replaceChildren(...notes.map((n) => n.note));
	// Collisions: a note never starts above the previous one's bottom + 8.
	let floor = -Infinity;
	for (const { note, top } of notes) {
		Object.assign(note.style, { left: `${left}px`, width: `${width}px` });
		const at = Math.max(top, floor);
		note.style.top = `${at}px`;
		note.dataset.shift = String(Math.round(at - top));
		floor = at + note.getBoundingClientRect().height + 8;
	}
}

// Link hover previews (docs/dev/live-edit.md §5.11): reading mode tells the
// host which vault link is under the pointer, and where; the host owns the
// popover and its timing. Not from block documents — a live edit frame, or
// the popover's own preview — in v1.
function reportLinkHovers() {
	let current = null;
	let mod = false;
	// A vault link, or a resolved citation (Biblify's spans carry their keys
	// in data-bibtex — §5.14).
	const linkOf = (el) => el?.closest?.('a.internal-link, [data-bibtex]:not(.biblify-nocite)');
	const send = (link, withMod) => {
		const r = link.getBoundingClientRect();
		post({
			type: 'link-hover', target: link.dataset.href ?? '', cite: link.dataset.bibtex ?? null, mod: withMod,
			rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
		});
	};
	document.addEventListener('mouseover', (e) => {
		const link = linkOf(e.target);
		if (link === current) return;
		if (current) post({ type: 'link-unhover' });
		current = link && !link.dataset.openExternal ? link : null;
		mod = e.metaKey || e.ctrlKey;
		if (current) send(current, mod);
	});
	document.addEventListener('mousemove', (e) => {
		// ⌘ pressed or released over the same link (the `mod` setting).
		const now = e.metaKey || e.ctrlKey;
		if (current && now !== mod) { mod = now; send(current, mod); }
	});
	document.addEventListener('keydown', (e) => {
		if (current && (e.key === 'Meta' || e.key === 'Control') && !mod) { mod = true; send(current, true); }
	});
	document.addEventListener('mouseleave', () => { if (current) { current = null; post({ type: 'link-unhover' }); } });
	window.addEventListener('scroll', () => { if (current) { current = null; post({ type: 'link-unhover', scrolled: true }); } }, { passive: true });
}

if (BLOCK) reportSize();
if (!BLOCK) reportLinkHovers();
if (!BLOCK) {
	document.addEventListener('clew:render', () => layoutSidenotes());
	window.addEventListener('resize', () => layoutSidenotes());
	window.addEventListener('load', () => layoutSidenotes());
	document.fonts?.ready.then(() => layoutSidenotes());
}
enableTaskCheckboxes();
initCanvasEmbeds();
initLeafletMaps();
initFigures();
initPdfEmbeds();
initExcalidrawEmbeds();
initOfficeEmbeds();
initQueryInteract();
// Previews start dark until the host says otherwise (preview.css defaults).
document.documentElement.classList.add('wa-dark');
initMetaBind();
// print-pdf.js waits on this the way it waits on MathJax and mermaid.
window.__clewFiguresPending = figuresPending;
post({ type: 'ready' });
