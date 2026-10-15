// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// How tall a PDF embed is: one page, at the width it is given (the iOS
// port's module, Clew-iOS 9b0b67e, upstreamed — pdf-embed.js calls it, so
// the port's build patches can go).
//
// pdf-embed.js used to give the viewer `height: 70vh`. In reading mode that
// is 70% of the pane. In live edit it is 70% of the block's own FRAME, and
// the frame is sized to its content (client.js#reportSize): each report
// shrinks the frame, each smaller frame shrinks the viewer, until the two
// settle near 200px — a toolbar over a sliver of page, the owner's
// screenshots (2026-10-15; on the desktop the frame went 480 → 176px). The
// owner's ask: the embed full width, as tall as one page, with sizes a note
// can set.
//
// - The page fills the width: the viewer's zoom is "fit width", where
//   EmbedPDF's default, "fit page", shrank the page to whatever height the
//   viewer had. A short viewer then scrolls a readable page.
// - By default the viewer is exactly one page tall: its tallest page at that
//   zoom, the viewport's gap above it and the gap to the next page below
//   (EmbedPDF scales that gap with the zoom; the viewport's own is fixed —
//   measured, and its layout code says the same). The next page starts at
//   the bottom edge, so nothing of it shows until scrolled. It follows the
//   width — a resize, a split, the ⟷ toggle, a sidebar opening beside the
//   page — and nothing in it reads its own height, so it cannot loop.
// - The note can set sizes in the link's fragment, Obsidian's syntax for a
//   PDF's height: `![[x.pdf#height=600]]`, `#width=480`, `#width=60%`,
//   joined by `&` (`#page=3&height=600`; what is not a size is left alone).
//   A height is the viewer's, in CSS pixels; a width narrows the box, and
//   the default height then follows it. The title shows the file's name,
//   not "x.pdf § height=600" (the engine's way with a fragment).
// - `#page=N` (Obsidian's, the owner's yes 2026-10-15) opens the viewer at
//   page N's top — framed as page one is, one page tall — combined with sizes
//   or not; out of range, the nearest page. A link edited to another page
//   goes there; a re-render that leaves the link as it was leaves the
//   reader's place alone.
//
// - A PDF EmbedPDF cannot open — not a PDF, damaged, or behind a password —
//   is as tall as the message EmbedPDF draws in its place (its error card, or
//   the password prompt; a password that opens it makes it one page again).
//   A viewer that failed outright shows Clew's line of text: as tall as that.
//
// The sizes are kept with the host (`.clew-pdf-inline`), which carries
// data-clew-keep and survives a morph; what is set on the engine-rendered
// box around it (its width, its title) is set again after every one.

const LETTER = 11 / 8.5;      // the guess before the PDF has said
const CHROME_GUESS = 56;      // EmbedPDF's toolbar, px, before it is measured
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 8000;
const MIN_WIDTH = 160;
const MAX_WIDTH = 8000;
const MAX_TRIES = 4;          // corrections per width (a sidebar under the page)
const MESSAGE_HEIGHT = 440;   // under the toolbar, until the card is measured: the password prompt is 388px wide open
const LINE_ROOM = 10;         // below a PDF of one page (see fitPdfToPage)
const QUIET_MS = 1000;        // after which a correction counts afresh
const ARRIVE_MS = 2000;       // how long a viewer sent to a page is put back there
const FIT_WIDTH = 'fit-width';   // EmbedPDF's ZoomMode.FitWidth
const FIT_PAGE = 'fit-page';     // and its default, ZoomMode.FitPage

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * The sizes a note asks of its PDF embed, from its link (the title link's
 * data-href: `x.pdf#height=600&width=60%`).
 * @returns {{ height: number|null, width: string|null }} height in px;
 *   width as CSS (`480px`, `60%`)
 */
export function pdfSizeOptions(href) {
	const out = { height: null, width: null };
	const text = String(href ?? '');
	const hash = text.indexOf('#');
	if (hash === -1) return out;
	for (const part of text.slice(hash + 1).split('&')) {
		const m = /^\s*(height|width)\s*=\s*(\d+(?:\.\d+)?)\s*(px|%)?\s*$/i.exec(part);
		if (!m) continue;
		const n = Number(m[2]);
		const percent = m[3] === '%';
		if (m[1].toLowerCase() === 'height') {
			if (!percent) out.height = Math.round(clamp(n, MIN_HEIGHT, MAX_HEIGHT));
		} else {
			out.width = percent ? `${clamp(n, 10, 100)}%` : `${Math.round(clamp(n, MIN_WIDTH, MAX_WIDTH))}px`;
		}
	}
	return out;
}

const OPTION = /^\s*(height|width|page)\s*=\s*[\d.]+\s*(px|%)?\s*$/i;

/**
 * The page a link opens its PDF at (`x.pdf#page=3`, `#page=3&height=600`),
 * or null: none, or not a whole number from 1.
 */
export function pdfPageOption(href) {
	const text = String(href ?? '');
	const hash = text.indexOf('#');
	if (hash === -1) return null;
	for (const part of text.slice(hash + 1).split('&')) {
		const m = /^\s*page\s*=\s*(\d+)\s*$/i.exec(part);
		if (m && Number(m[1]) >= 1) return Number(m[1]);
	}
	return null;
}

/**
 * Where page `page` (1-based; past the end, the last) starts in EmbedPDF's
 * vertical layout at `scale`: the scrollTop that frames it as page one is at
 * 0 — the viewport's gap above it, the next page's top at the bottom edge of
 * a one-page viewer. Spreads stacked with `pageGap` between them, both
 * scaled (the scroll plugin's createVirtualItems).
 */
export function pageTop({ spreads, page, scale, pageGap = 0 }) {
	let seen = 0;
	let y = 0;
	for (const [i, spread] of (spreads ?? []).entries()) {
		if (seen + spread.length >= page || i === spreads.length - 1) break;
		seen += spread.length;
		y += Math.max(...spread.map((p) => p.rotatedSize.height)) + pageGap;
	}
	return y * scale;
}

/**
 * The embed's title without its options: the engine titles
 * `![[x.pdf#height=600]]` "x.pdf § height=600", a fragment being a section
 * to it — but this one is sizes, not a place in the file. null when the
 * title is anything else (an alias, a real fragment) and stays as it is.
 */
export function plainTitle(href, title) {
	const text = String(href ?? '');
	const hash = text.indexOf('#');
	if (hash === -1) return null;
	const target = text.slice(0, hash);
	const fragment = text.slice(hash + 1).trim();
	if (!fragment || !fragment.split('&').every((part) => OPTION.test(part))) return null;
	return String(title ?? '').trim() === `${target} § ${fragment}` ? target : null;
}

/**
 * The viewport height that holds exactly one page at "fit width": the
 * viewport's gap above, the tallest page, then the gap to the next page —
 * or, for a PDF of one page, the viewport's gap below it. null before
 * there is anything to measure.
 *
 * EmbedPDF's sums (zoom: computeZoomForMode; scroll: the vertical layout):
 * fit width = (width − 2·viewportGap) / widest spread, a spread's width its
 * pages' and the gaps between them unscaled; pages stacked from
 * viewportGap down, pageGap·scale apart.
 * @param {{ spreads: Array<Array<{ rotatedSize: { width: number, height: number } }>>,
 *   pageGap?: number, viewportGap?: number, width: number }} layout
 */
export function onePageHeight({ spreads, pageGap = 0, viewportGap = 0, width }) {
	let widest = 0;
	let tallest = 0;
	for (const spread of spreads ?? []) {
		const across = spread.reduce((sum, page, i) => sum + page.rotatedSize.width + (i ? pageGap : 0), 0);
		widest = Math.max(widest, across);
		for (const page of spread) tallest = Math.max(tallest, page.rotatedSize.height);
	}
	const inner = width - 2 * viewportGap;
	if (!(widest > 0) || !(tallest > 0) || !(inner > 0)) return null;
	const scale = inner / widest;
	const below = spreads.length > 1 ? pageGap * scale : viewportGap;
	return viewportGap + tallest * scale + below;
}

// EmbedPDF's card for a PDF it could not open — its error, or the password
// prompt — centred in a padded area under its toolbar (the snippet's
// `.items-center.justify-center.p-8`, the card `.max-w-sm` in it).
export const MESSAGE_CARD = '.items-center.justify-center > .max-w-sm';

/**
 * How tall `host` must be to show that card whole: its toolbar, the card,
 * the area's padding. Measured — the card grows as the viewer narrows (the
 * password prompt 388px at 704 wide, 389 at 297, 430 on an iPad's 208 — 516
 * there before pdf-card-fit.js narrowed its padding: its
 * lock clipped and its buttons cut off at a fixed height). null before the
 * card is drawn.
 */
export function messageHeight(host) {
	const card = host.querySelector?.('*')?.shadowRoot?.querySelector(MESSAGE_CARD);
	const area = card?.parentElement;
	if (!card?.offsetHeight || !area?.offsetHeight) return null;
	const style = globalThis.getComputedStyle?.(area);
	const padding = (parseFloat(style?.paddingTop) || 0) + (parseFloat(style?.paddingBottom) || 0);
	return Math.ceil(host.offsetHeight - area.offsetHeight + card.offsetHeight + padding);
}

/** The height to hold before the PDF has opened: a portrait letter page. */
export function estimateHeight(width) {
	return Math.round(Math.max(width || 0, 240) * LETTER + CHROME_GUESS);
}

const sizes = new WeakMap();     // host → its note's sizes
const fitters = new WeakMap();   // host → refit(), once its viewer is up
const unopened = new WeakSet();  // hosts whose PDF EmbedPDF could not open

/**
 * Size `host` as its note asks — at mount, and again after every re-render
 * (an edit to the link changes the sizes; the host itself is kept).
 */
export function sizePdfHost(host) {
	// The title is engine-rendered, so every re-render puts the options
	// back into it; this runs after every one.
	const box = host.closest('.pdf-embed-box');
	const link = box?.querySelector('.embed-title a[data-href]');
	const href = link?.dataset.href;
	const title = link ? plainTitle(href, link.textContent) : null;
	if (title !== null) link.textContent = title;
	// A viewer that failed shows a line of text: as tall as that.
	if (host.querySelector(':scope > .clew-pdf-message')) {
		host.style.height = '';
		return;
	}
	const size = pdfSizeOptions(href);
	const before = sizes.get(host);
	sizes.set(host, { ...size, page: pdfPageOption(href) });
	// The width is the BOX's — the title bar narrows with the viewer, and a
	// percentage is of the note's column — set again after every morph,
	// which takes it off with the rest of the engine's markup. (⟷ wins:
	// its rule is !important, pdf-embed.js.)
	if (box) {
		box.style.width = size.width ?? '';
		box.style.maxWidth = size.width ? '100%' : '';
	}
	if (size.height && !unopened.has(host)) {
		host.style.height = `${size.height}px`;
		fitters.get(host)?.();   // the page, when the link changed it
		return;
	}
	const refit = fitters.get(host);
	if (refit) refit();
	else if (!before || before.height) host.style.height = `${estimateHeight(host.clientWidth)}px`;
}

const onWindowResize = (fn) => {
	globalThis.addEventListener?.('resize', fn);
	return () => globalThis.removeEventListener?.('resize', fn);
};

// The height is set on the next frame, never inside the resize report that
// asked for it: a size changed within a ResizeObserver callback is the
// "ResizeObserver loop completed with undelivered notifications" error.
const nextFrame = globalThis.requestAnimationFrame?.bind(globalThis) ?? ((fn) => setTimeout(fn, 0));

/**
 * Hold `host`'s viewer at "fit width", one page tall (unless the note set a
 * height), for as long as it lives: measured once the viewer is up, and
 * again whenever its viewport changes size, EmbedPDF re-zooms, or a
 * document opens or fails to.
 * @param {HTMLElement} host
 * @param {{ container?: { registry?: Promise<any> }, dispose?: Function }} handle
 *   pdf-core.js's createViewer handle
 */
export async function fitPdfToPage(host, handle) {
	let registry;
	try { registry = await handle?.container?.registry; } catch { return; }
	const viewport = registry?.getPlugin?.('viewport')?.provides?.();
	const scroll = registry?.getPlugin?.('scroll')?.provides?.();
	const documents = registry?.getPlugin?.('document-manager')?.provides?.();
	const zoom = registry?.getPlugin?.('zoom')?.provides?.();
	if (!viewport?.getMetrics || !scroll?.forDocument || !documents?.getActiveDocumentId) return;
	const widths = new Set();   // the widths corrected for since the last quiet
	let tries = 0;
	let lastTry = 0;
	let at = null;       // the page the viewer was sent to (none yet)
	let atScale = 0;     // and the scale it was at then
	let going = 0;       // until when it is put back there, not yet seen arrive
	let cardTries = 0;   // frames waited for EmbedPDF's message card
	let zoomed = false;  // the zoom is fit width, or the reader's own
	let pending = false;
	// Settled: the viewer at its page's top (pageTop). Sent there once per
	// page the link names, whatever the reader's place — at the start (page
	// one when there is no #page=), and when an edit to the link names
	// another — and put back there until it is seen to arrive (ARRIVE_MS at
	// most): EmbedPDF's re-zoom 150ms after a resize scrolls from where ITS
	// state last saw the document, which a scroll a moment before has not
	// reached yet — page three opened at page one (measured). After that only
	// when the document is NEAR it: that re-zoom moves a document that was at
	// a page's top by up to the viewport's gap times the change of scale (its
	// sums keep that gap unscaled). A reader's place further off is theirs.
	const place = (metrics, spreads) => {
		const count = spreads.reduce((n, spread) => n + spread.length, 0);
		if (!count) return;
		const page = Math.min(Math.max(sizes.get(host)?.page ?? 1, 1), count);
		const pageGap = scroll.getPageGap?.() ?? 0;
		const gap = viewport.getViewportGap?.() ?? 0;
		let scale = 0;
		try { scale = zoom?.getState?.()?.currentZoomLevel ?? 0; } catch { /* no zoom yet */ }
		if (!(scale > 0)) {
			// Fit width, as onePageHeight has it.
			const widest = Math.max(...spreads.map((spread) => spread.reduce((w, p, i) => w + p.rotatedSize.width + (i ? pageGap : 0), 0)));
			scale = (metrics.clientWidth - 2 * gap) / widest;
		}
		const y = pageTop({ spreads, page, scale, pageGap });
		const off = Math.abs((metrics.scrollTop ?? 0) - y);
		const drift = gap * Math.max(1, atScale ? Math.max(scale / atScale, atScale / scale) : 1);
		const now = performance.now();
		let send = false;
		if (page !== at) {
			at = page;
			going = now + ARRIVE_MS;
			send = true;
		} else if (going && (off < 0.5 || now > going)) {
			going = 0;   // arrived, or given up
		} else {
			send = going ? off >= 0.5 : off >= 0.5 && off < drift;
		}
		if (send) {
			try { viewport.scrollTo?.({ x: 0, y, behavior: 'instant' }); } catch { /* where it is */ }
		}
		atScale = scale;
	};
	const measure = () => {
		pending = false;
		if (!host.isConnected) return;
		let state = null;
		try { state = documents.getDocumentState?.(documents.getActiveDocumentId()); } catch { /* none yet */ }
		if (state?.status === 'error') {
			// EmbedPDF's message in place of its viewport (which it unmounts:
			// 0×0) — its error card, or the password prompt: as tall as that,
			// measured once it is drawn (a frame or two after the error).
			unopened.add(host);
			const height = messageHeight(host);
			if (height === null && cardTries++ < 30) refit();
			const want = height ?? CHROME_GUESS + MESSAGE_HEIGHT;
			if (Math.abs(host.offsetHeight - want) >= 1) host.style.height = `${want}px`;
			return;
		}
		let metrics;
		let spreads;
		try {
			metrics = viewport.getMetrics();
			spreads = scroll.forDocument(documents.getActiveDocumentId()).getSpreadPagesWithRotatedSize();
		} catch { return; }   // not mounted yet: its first resize will say
		if (!metrics?.clientWidth || !metrics.clientHeight) return;
		const set = sizes.get(host)?.height;
		if (unopened.delete(host)) {
			// Opened after all (a password): sized as any other, from the
			// resize this brings.
			host.style.height = `${set ?? estimateHeight(host.clientWidth)}px`;
			return;
		}
		// Fit width, asked once the viewport is up: asked before, EmbedPDF
		// applies its own default over it as the viewport mounts (measured).
		// Only over that default — a zoom the reader chose is theirs. Held at
		// the viewport's top-left corner, so the page grows down from the top:
		// EmbedPDF's own anchor, the viewport's centre, left the document
		// tens of pixels down (36 measured), and its re-zoom 150ms after each
		// resize (zoom plugin, recalcAuto) keeps whatever this one leaves.
		if (!zoomed && zoom?.getState) {
			try {
				const level = zoom.getState()?.zoomLevel;
				if (level === FIT_PAGE) zoom.requestZoom(FIT_WIDTH, { vx: 0, vy: 0 });
				else zoomed = true;
			} catch { zoomed = true; }
		}
		if (set) {
			place(metrics, spreads);
			return;
		}
		const need = onePageHeight({
			spreads,
			pageGap: scroll.getPageGap?.() ?? 0,
			viewportGap: viewport.getViewportGap?.() ?? 0,
			width: metrics.clientWidth,
		});
		if (need === null) return;
		// Down, never up: a pixel more would be the next page's edge. A PDF
		// of one page has none, and is given room instead: EmbedPDF's pages
		// sit in an inline-block, and the line box under it adds its descent
		// to the content (6.5px measured) when the page has no text laid out.
		// A viewport even a fraction short of the content scrolls, and where
		// scrollbars take room (the desktop's) the scrollbar came and went,
		// the width and EmbedPDF's zoom with it, for ever (measured: 676 ↔
		// 684px, three times a second).
		const target = spreads.length > 1 ? Math.floor(need) : Math.ceil(need) + LINE_ROOM;
		const now = performance.now();
		if (now - lastTry > QUIET_MS) {
			tries = 0;
			widths.clear();
		}
		// A new width has corrections of its own (a rotation, a split); one
		// seen already since the last quiet does not — two widths taking
		// turns would otherwise be corrected without end.
		if (!widths.has(metrics.clientWidth)) {
			widths.add(metrics.clientWidth);
			tries = 0;
		}
		const short = target - metrics.clientHeight;
		if (Math.abs(short) < 1) {
			place(metrics, spreads);
			return;
		}
		if (tries >= MAX_TRIES) return;
		tries += 1;
		lastTry = now;
		// offsetHeight, not the client rect: a canvas node's scale transform
		// would scale the one and not the other.
		host.style.height = `${host.offsetHeight + short}px`;
	};
	const refit = () => {
		if (pending) return;
		pending = true;
		nextFrame(measure);
	};
	// EmbedPDF re-zooms 150ms after a resize (its zoom plugin's recalcAuto),
	// which can move the document; and a document opens — after a password —
	// or fails to with no resize at all.
	const offs = [
		viewport.onViewportResize?.(refit),
		// On its way to a page: every scroll is measured, so one that put it
		// back elsewhere is seen.
		viewport.onScrollChange?.(() => { if (going) refit(); }),
		// A message's card is measured again as the viewer's width changes
		// (no viewport to report a resize: EmbedPDF has unmounted it).
		onWindowResize(() => { if (unopened.has(host)) refit(); }),
		zoom?.onZoomChange?.(refit),
		documents.onDocumentOpened?.(refit),
		documents.onDocumentError?.(refit),
	];
	fitters.set(host, refit);
	const dispose = handle.dispose;
	handle.dispose = function (...args) {
		for (const off of offs) off?.();
		fitters.delete(host);
		unopened.delete(host);
		return dispose?.apply(this, args);
	};
	refit();
}
