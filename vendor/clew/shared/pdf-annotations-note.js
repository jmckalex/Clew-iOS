// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What you highlighted in a PDF, as a note (docs/dev/live-edit.md §5.15) —
// the pure half: build the note, and MERGE into one that already exists.
//
// One entry per annotation, a single blockquote so that one block id names
// all of it — the highlighted text, the comment, the page link:
//
//     > the highlighted text
//     >
//     > the comment
//     >
//     > [[paper.pdf#page=3|p. 3]] ^pdf-<id>
//
// `^pdf-<id>` is an Obsidian block id, so `[[paper — Annotations#^pdf-<id>]]`
// quotes one highlight elsewhere. Re-running merges: an entry whose id is
// already in the note is left exactly as it stands (you may have written
// around it), a new one is appended under its page's heading in page order,
// and nothing is ever deleted. Unchanged input gives back the same bytes.

/** Today as YYYY-MM-DD in local time (toISOString is UTC: past midnight it
 *  names yesterday — measured). */
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Block ids are `[A-Za-z0-9-]`; an annotation id is made to fit. */
export const blockIdFor = (id) => `pdf-${String(id).replace(/[^A-Za-z0-9-]/g, '-').slice(0, 120)}`;

/** The note's name beside the PDF: `<basename> — Annotations.md`. */
export function annotationsNotePath(pdfPath) {
	return pdfPath.replace(/\.pdf$/i, '') + ' — Annotations.md';
}

const quote = (text) => text.split('\n').map((l) => (l.trim() ? `> ${l.trim()}` : '>')).join('\n');

/**
 * One annotation's entry.
 *
 * @param {string} pdfName - the PDF's file name, for the link
 * @param {{ id: string, page: number, kind: string, text?: string, contents?: string }} a
 *   `page` 1-based
 */
export function annotationEntry(pdfName, a) {
	const parts = [];
	const text = (a.text ?? '').trim();
	const contents = (a.contents ?? '').trim();
	if (text) parts.push(quote(text));
	else if (!contents) parts.push(quote(`(${a.kind || 'annotation'} — text not available)`));
	if (contents) parts.push(quote(contents));
	parts.push(`> [[${pdfName}#page=${a.page}|p. ${a.page}]] ^${blockIdFor(a.id)}`);
	return parts.join('\n>\n');
}

/**
 * The note for `annotations`, merged into `existing` when there is one.
 *
 * @param {string} pdfPath - vault path of the PDF
 * @param {{ id: string, page: number, kind: string, text?: string, contents?: string }[]} annotations
 * @param {string|null} existing - the note's current text, or null
 * @param {{ date?: string }} [options] - `extracted:` for a new note (ISO)
 * @returns {{ text: string, added: number }}
 */
export function annotationsNote(pdfPath, annotations, existing = null, { date = localDate() } = {}) {
	const pdfName = pdfPath.split('/').pop();
	// Stable by page: the viewer already gives reading order within a page.
	const sorted = [...annotations].sort((a, b) => a.page - b.page);
	if (existing == null) {
		const lines = ['---', `source: "[[${pdfName}]]"`, `extracted: ${date}`, '---', `# ${pdfName.replace(/\.pdf$/i, '')} — Annotations`, ''];
		let page = null;
		for (const a of sorted) {
			if (a.page !== page) { lines.push(`## Page ${a.page}`, ''); page = a.page; }
			lines.push(annotationEntry(pdfName, a), '');
		}
		return { text: lines.join('\n'), added: sorted.length };
	}
	const have = new Set([...existing.matchAll(/\^(pdf-[A-Za-z0-9-]+)\s*$/gm)].map((m) => m[1]));
	const fresh = sorted.filter((a) => !have.has(blockIdFor(a.id)));
	if (!fresh.length) return { text: existing, added: 0 };
	let text = existing;
	for (const a of fresh) text = appendUnderPage(text, a.page, annotationEntry(pdfName, a));
	return { text, added: fresh.length };
}

/** Put `entry` at the end of `## Page n`, creating that heading in page order. */
function appendUnderPage(text, page, entry) {
	const lines = text.split('\n');
	const headings = [];
	lines.forEach((l, i) => {
		const m = /^## Page (\d+)\s*$/.exec(l);
		if (m) headings.push({ page: Number(m[1]), line: i });
	});
	const own = headings.find((h) => h.page === page);
	if (own) {
		// The section runs to the next heading of level ≤ 2, or the end.
		let end = lines.length;
		for (let i = own.line + 1; i < lines.length; i += 1) if (/^#{1,2} /.test(lines[i])) { end = i; break; }
		let last = end;
		while (last > own.line + 1 && lines[last - 1].trim() === '') last -= 1;
		lines.splice(last, 0, '', entry);
		return lines.join('\n');
	}
	const next = headings.find((h) => h.page > page);
	const block = [`## Page ${page}`, '', entry, ''];
	if (next) lines.splice(next.line, 0, ...block);
	else {
		while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
		lines.push('', ...block);
	}
	return lines.join('\n');
}
