// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// "Export as PDF (reading view)" — the note as the app draws it, printed.
//
// The other PDF export runs the note through the engine's LaTeX path and out
// through a TeX toolchain: a beautifully typeset document that looks nothing
// like the screen, and needs MacTeX installed. This one is the other wish —
// what you are looking at, on paper — so it prints the very same
// clew-preview:// document the reading pane shows, in a hidden window.
//
// Rendering is asynchronous in ways a screenshot tool has to respect: MathJax
// typesets after load, mermaid replaces its blocks with SVG, TikZ and
// MetaPost figures typeset in a wasm TeX, webfonts arrive when they arrive.
// printToPDF before any of that finishes captures a half-drawn note, so the
// window is polled until the page says it is done.
import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { writeFileAtomic } from './fs-utils.js';

const READY_TIMEOUT_MS = 30000;
const POLL_MS = 150;
// Chromium keeps painting for a beat after the last promise settles.
const SETTLE_MS = 350;

// Inches, and the same on every edge — Electron's printToPDF takes inches.
const MARGIN = 0.6;

const PAGE_SIZES = { a4: 'A4', letter: 'Letter', legal: 'Legal', tabloid: 'Tabloid' };

// A BOOK prints each chapter from a new page (book-mode.md, phase 3): the
// engine wraps every chapter file in `section.jmd-chapter`, a further
// numbered `#` in one starts a chapter of its own, and the master's
// bibliography and index follow the last chapter. Added by insertCSS — the
// browser's own sheet, which a restricted vault's CSP cannot refuse — and
// only to a book's print: a note's prints as it always has.
const BOOK_PRINT_CSS = `@media print {
	section.jmd-chapter, section.jmd-book-references, nav.index { break-before: page; }
	section.jmd-chapter > h1 ~ h1:not(.unnumbered) { break-before: page; }
}`;

/**
 * Arm the flag the probe reads: MathJax and document.fonts hand out promises
 * rather than state, so the page has to remember for us.
 *
 * They are chained rather than raced, because typesetting can ASK for a
 * webfont as it goes — a `document.fonts.ready` awaited up front resolves
 * against the fonts of that moment and would say "done" too early. (This
 * engine configures MathJax for SVG output, so its own glyphs are paths and
 * no font of its own is in play — measured, in both this window and the
 * app's. The chain is for the page's other faces, and for the day that
 * config changes.)
 */
const ARM_SCRIPT = `(() => {
	window.__clewPrintReady = false;
	(window.MathJax?.startup?.promise ?? Promise.resolve())
		.then(() => document.fonts.ready)
		.then(() => { window.__clewPrintReady = true; })
		.catch(() => { window.__clewPrintReady = true; });
	return true;
})()`;

// …and the probe re-checks the font status live, because anything else on the
// page may have asked for a face after that. A mermaid block is done when its
// source has become an <svg>.
const READY_PROBE = `(() => {
	if (document.readyState !== 'complete') return false;
	if (window.__clewPrintReady !== true) return false;
	if (document.fonts.status !== 'loaded') return false;
	for (const el of document.querySelectorAll('.mermaid')) {
		if (!el.querySelector('svg')) return false;
	}
	// TikZ/MetaPost figures take the longest of anything here: the first one
	// loads the wasm engines and the TeX files it needs. The preview client
	// counts them for us (preview-client/figures.js#figuresPending) — a
	// figure element with nothing in it yet counts, so a print cannot start
	// before the engines have even loaded.
	if (window.__clewFiguresPending?.() > 0) return false;
	return true;
})()`;

/**
 * Print one note's rendered preview to `outFile`.
 *
 * The page is asked to switch to the LIGHT theme first, whatever the app is
 * wearing: the engine's own inline CSS is written for a light page and the
 * dark palette is an override on top of it (preview.css), so light is the
 * faithful rendering — and a PDF is a paper artifact besides. The request
 * goes through the client's own theme handler, so mermaid re-themes with it.
 *
 * A folded `![[Note|collapsed]]` embed prints folded. That is the promise of
 * "as displayed": what is on screen is what comes out.
 *
 * `book`: `relPath` is a master, and what prints is its whole book as one
 * document (render-service.js#renderBook, built just before), each chapter
 * from a new page.
 */
export async function printNoteToPdf({ sessionId, callerToken = null, relPath, outFile, paperSize = 'a4', book = false }) {
	const encoded = relPath.split('/').map(encodeURIComponent).join('/');
	const url = `clew-preview://vault/${encodeURIComponent(sessionId)}/${encoded}.html${book ? '?book=1' : ''}`;

	const win = new BrowserWindow({
		show: false,
		width: 900,
		height: 1200,
		// A hidden window is a background window, and a throttled one would
		// stall the very timers this then waits on.
		webPreferences: { backgroundThrottling: false },
	});
	try {
		await win.loadURL(url);
		if (book) await win.webContents.insertCSS(BOOK_PRINT_CSS);
		await win.webContents.executeJavaScript(ARM_SCRIPT);
		win.webContents.executeJavaScript(
			`window.postMessage({ source: 'clew-preview-host', type: 'theme', theme: 'light' }, 'clew-preview://vault'); true;`);
		// The caller token (docs/dev/frame-bridge.md §1): this page is TOP-level,
		// with no host to answer its ask, so it is handed the token the same
		// way — a canvas embed's cards render through the fragment endpoint,
		// which runs nothing without it. At the top window.parent is window,
		// so the client believes this post.
		if (callerToken) {
			win.webContents.executeJavaScript(`window.postMessage({ source: 'clew-preview-host', type: 'caller-token', `
				+ `token: ${JSON.stringify(callerToken)} }, 'clew-preview://vault'); true;`);
		}

		const deadline = Date.now() + READY_TIMEOUT_MS;
		for (;;) {
			if (await win.webContents.executeJavaScript(READY_PROBE)) break;
			if (Date.now() > deadline) break; // print what we have, rather than nothing
			await new Promise((r) => setTimeout(r, POLL_MS));
		}
		await new Promise((r) => setTimeout(r, SETTLE_MS));

		const data = await win.webContents.printToPDF({
			printBackground: true,
			pageSize: PAGE_SIZES[String(paperSize).toLowerCase()] ?? 'A4',
			margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
		});
		if (!data?.length) throw new Error('the printer returned an empty document');
		fs.mkdirSync(path.dirname(outFile), { recursive: true });
		writeFileAtomic(outFile, data);
		return outFile;
	} finally {
		win.destroy();
	}
}
