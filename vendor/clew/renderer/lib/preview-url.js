// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Session-scoped clew-preview:// URLs. Every vault URL carries the window's
// session id (multi-window: the protocol handler can't see which window is
// asking, so the URL says which vault it means). main.js sets the id from
// the vault-opened event before any preview renders.
let sessionId = 'none';

export function setPreviewSession(id) {
	sessionId = id ?? 'none';
}

const encode = (path) => path.split('/').map(encodeURIComponent).join('/');

/** Rendered-note URL (reading mode, canvas note embeds). */
export function previewUrl(path) {
	return `clew-preview://vault/${sessionId}/${encode(path)}.html`;
}

/** Raw vault file URL (images, PDFs, media). */
export function vaultFileUrl(path) {
	return `clew-preview://vault/${sessionId}/${encode(path)}`;
}

/**
 * Our EmbedPDF viewer page, wrapping a raw PDF URL. Used where a PDF is shown
 * in an iframe of its own (the file tab, canvas PDF nodes) rather than inside
 * a rendered note.
 */
export function pdfViewerUrl(fileUrl, { page = null } = {}) {
	// NB: no session id. Asset URLs sit at the root of the URL space
	// (vault/__clew_assets__/…); only vault FILES are sid-prefixed. The PDF
	// itself keeps its sid — it travels in the src parameter. `page`: open
	// there (`[[paper.pdf#page=12]]`, §5.15).
	return `clew-preview://vault/__clew_assets__/clewpdf/pdf-page.html`
		+ `?src=${encodeURIComponent(fileUrl)}${page ? `&page=${Number(page)}` : ''}`;
}

/**
 * The Excalidraw editor page, wrapping a drawing. Like pdfViewerUrl, the page
 * itself is an ASSET (no session id) while the file it edits is a vault path
 * (which carries one) — the two travel as separate parameters.
 */
export function excalidrawUrl(path) {
	return 'clew-preview://vault/__clew_assets__/clewex/page.html'
		+ `?src=${encodeURIComponent(vaultFileUrl(path))}&path=${encodeURIComponent(path)}`;
}

/**
 * The ZetaOffice (LibreOffice wasm) viewer page, wrapping an office
 * document. Same shape as excalidrawUrl: the page is an ASSET, the
 * document a vault path — src is fetched as bytes, path names the
 * save-back target.
 */
export function zetaOfficeUrl(path) {
	return 'clew-preview://vault/__clew_assets__/clewzeta/zeta-page.html'
		+ `?src=${encodeURIComponent(vaultFileUrl(path))}&path=${encodeURIComponent(path)}`;
}

/** Engine fragment-render endpoint (canvas cards; POST markdown → HTML). */
export function fragmentUrl() {
	return `clew-preview://vault/${sessionId}/__clew_fragment__`;
}

/** Live edit's block frames: POST `{text, sourcePath}` here for `{hash}`… */
export function blockUrl() {
	return `clew-preview://vault/${sessionId}/__clew_block__`;
}

/** …then frame the rendered block document at this URL. */
export function blockDocumentUrl(hash) {
	return `clew-preview://vault/${sessionId}/__clew_block__/${hash}`;
}

/** Base URL of the preview origin (rewrites root-relative asset paths). */
export function previewOrigin() {
	return 'clew-preview://vault';
}
