// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// `@begin(clew-only)` … `@end(clew-only)` — what is for CLEW only (the
// owner's ask, 2026-11-24, and the name, the same day: marking essays, the
// controls at the top of each one — a "marked" button, a grade — have no place
// in the PDF that goes back to the student, nor in any page outside Clew,
// where they would do nothing). A Clew environment, as `@reveal` and `@app`
// are: one entry serves `@begin(clew-only)`, the block `@clew-only+[…]` and the
// inline `@clew-only[…]`.
//
// Its body is markdown, drawn in reading view and live edit as anywhere else,
// inside a `.clew-only` box that preview.css hides from PRINT — so the
// reading-view PDF (print-pdf.js prints the preview's own document: a note's, a
// book's, a batch's) leaves it out, with no gap where it was. Everything that
// leaves Clew leaves it out: a site export (the preview's configuration, run
// with CLEW_SITE_EXPORT), and every note or book export — HTML, LaTeX, PDF via
// LaTeX — which registers `clewOnlyExport` instead (export-config.js#
// EXPORT_ENVIRONMENTS): nothing in any format. Loaded by the preview's
// generated config (render-service.js `Environments`, this file's default
// export, by name).
//
// Not the engine's `print`/`web` pair: those choose an OUTPUT FORMAT (LaTeX,
// HTML), and the reading-view PDF is HTML — `@begin(web)` prints there.

const siteExport = () => globalThis.process?.env?.CLEW_SITE_EXPORT === '1';

/** Reading view and live edit: the box; a site export, nothing. */
export const clewOnly = {
	mode: 'markdown',
	html: (ctx) => {
		if (siteExport()) return '';
		const tag = ctx.inline ? 'span' : 'div';
		return `<${tag} class="clew-only">${ctx.inner}</${tag}>`;
	},
	latex: () => '',
};

/** A note's or a book's export, in every format: nothing. */
export const clewOnlyExport = {
	mode: 'markdown',
	html: () => '',
	latex: () => '',
};

// The engine's `Environments` config entry without `from` registers each key
// of the default export — the one way to give a handler a hyphenated name.
export default { 'clew-only': clewOnly };
