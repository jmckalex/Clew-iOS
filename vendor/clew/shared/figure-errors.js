// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// A figure's error, where it helps editing (the owner's report, 2026-10-03:
// a TikZ typo showed the whole pdfTeX log over the very lines to fix). Two
// halves, both pure: the preview's figure (preview-client/figures.js) reads
// the FIRST error out of what mp-tikz-wasm printed, and the editor (the
// live preview pane) finds the source line it is about.
//
// The line TeX and MetaPost name is a line of the document they compiled —
// a fence's body WRAPPED in a preamble (standalone, tikz, Clew's fragments),
// so its number says nothing about the fence. What they also print is the
// context: `l.4 <the line up to the error>` and, under it, the rest of that
// line. That text IS the fence's text, whatever the wrapper added, so the
// line is found by its text.

/**
 * The first error in a figure's console text.
 * @param {string} text - what mp-tikz-wasm put in `.mpw-console`: its
 *   diagnostics (`error: Undefined control sequence. (line 4)`), then the log
 * @returns {{ message: string, docLine: number|null, before: string|null,
 *   after: string|null } | null}
 */
export function parseFigureError(text) {
	const t = String(text ?? '');
	if (!t.trim()) return null;
	const diag = /^(?:error|warning):\s*(.+?)(?:\s*\(line (\d+)\))?\s*$/m.exec(t);
	const bang = /^! (.+)$/m.exec(t);
	// `l.N <text up to the error>`, then the rest of the line, indented.
	const ctx = /^l\.(\d+) (.*)\r?\n(.*)$/m.exec(t);
	const message = (diag?.[1] ?? bang?.[1] ?? t.split('\n').find((l) => l.trim()) ?? '').trim();
	return {
		message,
		docLine: Number(ctx?.[1] ?? diag?.[2]) || null,
		before: ctx ? ctx[2] : null,
		after: ctx ? ctx[3].trim() : null,
	};
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Which of `lines` (a fence's source, delimiters included) the error is
 * about: 0-based, or -1. By the context TeX printed (its last 40 characters
 * — TeX elides the start of a long line as `...`); failing that, a line
 * number counted from the fence's first BODY line (`relLine`, mermaid's
 * "Parse error on line N", which needs no wrapper).
 * @param {string[]} lines
 * @param {{ before?: string|null, after?: string|null, relLine?: number|null }} err
 */
export function locateFigureError(lines, err) {
	if (err?.before) {
		const before = norm(err.before.replace(/^\.\.\./, ''));
		const tail = before.slice(-40);
		const candidates = [tail, norm(`${before} ${err.after ?? ''}`).slice(-40)].filter((n) => n.length >= 2);
		for (const needle of candidates) {
			const at = lines.findIndex((line) => norm(line).includes(needle));
			if (at >= 0) return at;
		}
	}
	if (Number.isInteger(err?.relLine) && err.relLine >= 1 && err.relLine < lines.length) return err.relLine;
	return -1;
}

/** Mermaid's parse error, `Parse error on line 3:` and the like, as relLine. */
export function mermaidErrorLine(message) {
	const m = /\bline (\d+)\b/i.exec(String(message ?? ''));
	return m ? Number(m[1]) : null;
}
