// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Quote-and-cite from a PDF (FEATURE-IDEAS #2) — the pure half: what text
// you selected in a PDF becomes in a note, and where in the note it goes.
//
//     > The selected text, as one paragraph.
//     >
//     > \cite[p. 268]{parekh:2001} · [[Parekh.pdf#page=2|PDF p. 2]]
//
// The same shape as an entry of the annotations note (pdf-annotations-note.js):
// one blockquote, the page link last. The citation names the page the
// article PRINTS (printedPage: by hand, the PDF's page labels, its header
// and footer numbers); the link, the PDF's own page, which is what
// `#page=N` opens.

/**
 * The viewer's text — one string per page, its lines broken where the PDF's
 * lines break — as one paragraph. A word broken across a line by a hyphen is
 * joined (`evo-\nlutionary`), soft hyphens are dropped, and every run of
 * white space becomes one space.
 */
export function cleanPdfText(pages) {
	const list = Array.isArray(pages) ? pages : [pages];
	return list
		.map((page) => String(page ?? '')
			.replace(/[­￾\u0002]/g, '')
			.replace(/\r\n?/g, '\n')
			.replace(/(\p{L})-\n[ \t]*(\p{Ll})/gu, '$1$2'))
		.join('\n')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Prose kept as prose: what this dialect would read as markup is escaped.
 * Every rule below was checked by rendering through the engine (2026-10-03):
 * unescaped, `x^2` is a superscript, `H_2O` a subscript, `a*b*` strong,
 * ` /tmp/ ` italic, `==x==` a highlight, `a::b` mangled and `X:: Y` a
 * description list. Two need more than a backslash, and one needed it:
 *
 * - `$` is `\$`: since jmarkdown e02cd51 the engine wraps an escaped dollar
 *   in `span.escaped`, which MathJax (it typesets `$5 and $10` in the PAGE,
 *   after the engine) does not read a delimiter across, and a LaTeX export
 *   writes `\$`. Before it, the escape had to be `\\\$`.
 * - `[`: `\[` is display maths in this dialect, so a bracket is never
 *   backslashed (`[sic]` is plain text anyway); only `[[` (a wikilink) and
 *   `[@` (a pandoc citation) are hidden, as the entity `&#91;`.
 * - a backslash is doubled, so `\cite` or `\begin` in a PDF stays text.
 */
export function escapeProse(text, { normalSyntax = false } = {}) {
	let out = String(text)
		.replace(/\\/g, '\\\\')
		.replace(/[*_^~`<]/g, (c) => `\\${c}`)
		.replace(/\$/g, '\\$$')
		.replace(/\[(?=[[@])/g, '&#91;')
		.replace(/==/g, '\\=\\=')
		.replace(/::+/g, (run) => run.replace(/:/g, '\\:'))
		// A directive (and, with pandocCitations, a citation): `@name`.
		.replace(/(^|[\s(])@(?=[A-Za-z])/g, '$1\\@');
	// The dialect's /italic/ opens on a slash with nothing word-like before
	// it; `and/or` and URLs are already literal (jmarkdown 3134543).
	if (!normalSyntax) out = out.replace(/(^|[\s(])\/(?=\S)/g, '$1\\/');
	// What would make the paragraph's first line something else: a heading,
	// a list item, a table row, a callout.
	return out
		.replace(/^(\d+)([.)])(?=\s)/, '$1\\$2')
		.replace(/^(#|[-+](?=\s)|\||>)/, '\\$1');
}

// ---- printed page numbers --------------------------------------------------
// `p. N` should be the page the ARTICLE prints, not the PDF's page (the
// owner's Parekh scan's PDF page 2 is printed "268"). Measured on the
// owner's own PDFs (2026-10-03), a PDF's /PageLabels are not to be taken on
// trust: JSTOR writes "p. [523]" (a prefix, brackets for an unprinted
// number), labels some downloads one page AHEAD of what each page prints
// ("Identity, Supervision, and Work Groups": page 1 prints 212, labelled
// "p. 213"), and labels scans "image 1"; other PDFs label every page "1…N"
// from the first, which says nothing. So a label is cleaned, a set that says
// nothing is none, and a number the pages THEMSELVES print, consistently,
// outranks a numeric label that disagrees with it.

/** A page label as a page: "p. 524" → "524", "[523]" → "523", "xiv" stays;
 *  null for what is no page number ("image 1"). */
export function cleanPageLabel(raw) {
	let t = typeof raw === 'string' ? raw.trim() : '';
	t = t.replace(/^(?:pp?\.|pages?)\s*/i, '').trim();
	const bracketed = /^\[(.+)\]$/.exec(t);
	if (bracketed) t = bracketed[1].trim();
	// Digits; roman; or a letter prefix ("S12", "A-3", "e1234") — a few
	// journals number supplements and online-only articles that way.
	return /^(?:\d{1,5}|[ivxlcdm]{1,8}|[A-Za-z]{1,3}[-–.]?\d{1,5})$/i.test(t) ? t : null;
}

/** The PDF's page labels (one per page, as the engine reads them), cleaned —
 *  or null when they say nothing: none is a page number, or every page is
 *  labelled with its own PDF page number. */
export function usefulPageLabels(raw) {
	if (!Array.isArray(raw) || !raw.length) return null;
	const labels = raw.map(cleanPageLabel);
	if (labels.every((l) => l === null)) return null;
	if (labels.every((l, i) => l === null || l === String(i + 1))) return null;
	return labels;
}

/** A page-number candidate in a header or footer run: a number alone, or
 *  at either end of the run ("268  ECONOMICS AND PHILOSOPHY"), dashes
 *  allowed ("– 268 –"). Control characters count as spaces: EmbedPDF's
 *  text runs can carry a line break and stale bytes after the run's own
 *  text ("269\u001b\u0010", "267\r\n267tly, " — measured on the Parekh PDF). */
export function bandNumbers(text) {
	const t = String(text ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
	const out = [];
	const alone = /^[-–—(\[]?\s*(\d{1,4})\s*[-–—)\]]?$/.exec(t);
	if (alone) return [Number(alone[1])];
	const first = /^(\d{1,4})\s/.exec(t);
	const last = /\s(\d{1,4})$/.exec(t);
	if (first) out.push(Number(first[1]));
	if (last) out.push(Number(last[1]));
	return out;
}

/**
 * Which of a page's text runs may hold its printed number: those on the
 * page's two OUTERMOST lines at the top and at the bottom, wherever they
 * sit, and any in the top or bottom `band` of the page. The lines matter
 * because a fixed band misses generous margins — LaTeX's default `article`
 * prints its number about 1.5in up a letter page (Clew-docs' finding,
 * 2026-10-03) — and two of them because a footer may sit under a
 * "Downloaded from…" line or above it. A number in the body that lands on
 * such a line agrees with no other page, which textPageOffset requires.
 * @param {{ y: number, height: number }[]} rects - each run's box, y down
 * @param {number} height - the page's height
 * @returns {number[]} indexes into `rects`, ascending
 */
export function edgeRuns(rects, height, { band = 0.12, lines = 2 } = {}) {
	const items = (rects ?? []).map((r, i) => ({ i, top: r.y, bottom: r.y + r.height, mid: r.y + r.height / 2 }))
		.filter((it) => Number.isFinite(it.top) && Number.isFinite(it.bottom));
	// A line: runs whose centres fall within the extent of the one above.
	const groups = [];
	for (const it of [...items].sort((a, b) => a.mid - b.mid)) {
		const line = groups[groups.length - 1];
		if (line && it.mid <= line.bottom) {
			line.items.push(it);
			line.bottom = Math.max(line.bottom, it.bottom);
		} else groups.push({ bottom: it.bottom, items: [it] });
	}
	const keep = new Set();
	for (const line of [...groups.slice(0, lines), ...groups.slice(-lines)]) for (const it of line.items) keep.add(it.i);
	if (height > 0) for (const it of items) if (it.top <= height * band || it.bottom >= height * (1 - band)) keep.add(it.i);
	return [...keep].sort((a, b) => a - b);
}

/**
 * The offset from PDF page to printed page, read off the pages' own header
 * and footer numbers — or null when they do not say so CONSISTENTLY. Each
 * sample is a page (1-based) and the numbers found in its bands; an offset
 * counts once per page. Accepted only when at least `min` pages (3, or every
 * sampled page with a number when fewer) agree, and no other offset comes
 * within half of it — a year in a running header, a volume number, a figure
 * label agree with nothing.
 * @param {{ page: number, numbers: number[] }[]} samples
 * @returns {number|null}
 */
export function textPageOffset(samples, { min = 3 } = {}) {
	const support = new Map();
	let pagesWithNumbers = 0;
	for (const { page, numbers } of samples ?? []) {
		const offsets = new Set((numbers ?? []).map((n) => n - page).filter((o) => o + page >= 1));
		if (offsets.size) pagesWithNumbers += 1;
		for (const o of offsets) support.set(o, (support.get(o) ?? 0) + 1);
	}
	const ranked = [...support].sort((a, b) => b[1] - a[1]);
	if (!ranked.length) return null;
	const [best, count] = ranked[0];
	const runnerUp = ranked[1]?.[1] ?? 0;
	const need = Math.max(2, Math.min(min, pagesWithNumbers));
	if (count < need || runnerUp * 2 > count) return null;
	return best;
}

/**
 * What a quote cites as its page, in order: an offset set BY HAND (the
 * user's word); the number the pages print, by the offset their headers and
 * footers agree on, where the page's label is a different NUMBER (or there
 * is none); the PDF's page label (/PageLabels, cleaned — roman as printed,
 * "xiv", which no arabic offset speaks for); else the PDF's page.
 * @param {{ pdfPage: number, label?: string|null,
 *   meta?: { offset?: number, offsetSource?: string } | null,
 *   textOffset?: number|null }} q
 *   `label`: this page's, already cleaned (usefulPageLabels).
 * @returns {{ printed: string, source: 'manual'|'label'|'text'|'pdf' }}
 */
export function printedPage({ pdfPage, label = null, meta = null, textOffset = null }) {
	const page = Number(pdfPage) || 1;
	if (meta?.offsetSource === 'manual' && Number.isFinite(meta.offset) && page + meta.offset >= 1) {
		return { printed: String(page + meta.offset), source: 'manual' };
	}
	const clean = cleanPageLabel(label);
	const offset = Number.isFinite(textOffset) ? textOffset
		: meta?.offsetSource === 'text' && Number.isFinite(meta.offset) ? meta.offset : null;
	const fromText = offset !== null && page + offset >= 1 ? String(page + offset) : null;
	const contradicted = fromText && /^\d+$/.test(clean ?? '') && clean !== fromText;
	if (clean && !contradicted) return { printed: clean, source: 'label' };
	if (fromText) return { printed: fromText, source: 'text' };
	return { printed: String(page), source: 'pdf' };
}

/** The citation for `key` at `page`, in the vault's form. */
export function citation(key, page, { pandoc = false } = {}) {
	if (!key) return '';
	return pandoc ? `[@${key}, p. ${page}]` : `\\cite[p. ${page}]{${key}}`;
}

/**
 * The block to insert.
 * @param {{ text: string, page: number, printed?: string|null, link: string,
 *   key?: string|null, pandoc?: boolean, normalSyntax?: boolean }} q
 *   `page` is the PDF's (the link's); `printed`, the page the article prints
 *   (printedPage), cited when given.
 *   `text` already cleaned; `link` the PDF as a wikilink target (a bare
 *   name when the vault has one file by that name, else its path).
 */
export function quoteBlock({ text, page, printed = null, link, key = null, pandoc = false, normalSyntax = false }) {
	// The citation names the PRINTED page; the link stays the PDF's, which is
	// what the viewer opens — so the line says both ("p. 268" · "PDF p. 2").
	const shown = printed ?? String(page);
	const cite = citation(key, shown, { pandoc });
	const back = `[[${link}#page=${page}|PDF p. ${page}]]`;
	const lead = cite ? `${cite} · ` : shown !== String(page) ? `p. ${shown} · ` : '';
	return `> ${escapeProse(text, { normalSyntax })}\n>\n> ${lead}${back}`;
}

/**
 * Where `block` goes in `doc` for a cursor at `pos`: as a block of its own,
 * never inside another — on the blank line the cursor is on; before the
 * block whose first line the cursor starts; otherwise after the end of the
 * block the cursor is in (a paragraph, a quote, a list: up to the next blank
 * line — a heading ends at its own line) — with a blank line either side,
 * unless the document's edge or a blank line is already there.
 * @returns {{ from: number, to: number, insert: string, cursor: number }}
 *   `cursor` is where the caret goes afterwards: the line after the block,
 *   so a second quote lands beneath the first.
 */
export function placeQuote(doc, pos, block) {
	const at = Math.max(0, Math.min(Number(pos) || 0, doc.length));
	const lineStart = (i) => doc.lastIndexOf('\n', i - 1) + 1;
	const lineEnd = (i) => { const e = doc.indexOf('\n', i); return e === -1 ? doc.length : e; };
	const blankAt = (start) => !doc.slice(start, lineEnd(start)).trim();
	const start = lineStart(at);
	let from;
	let to;
	if (blankAt(start)) {
		// A blank line is the block's own (its spaces too).
		from = start;
		to = lineEnd(start);
	} else if (at === start && (start === 0 || blankAt(lineStart(start - 1)))) {
		from = to = start;
	} else {
		let end = lineEnd(start);
		if (!/^#{1,6}\s/.test(doc.slice(start, end))) {
			while (end < doc.length && !blankAt(end + 1)) end = lineEnd(end + 1);
		}
		from = to = end;
	}
	const before = doc.slice(0, from);
	const after = doc.slice(to);

	let lead = '';
	if (before && !before.endsWith('\n')) lead = '\n\n';
	else if (before && before.slice(lineStart(before.length - 1), -1).trim()) lead = '\n';
	let tail;
	if (!after) tail = '\n';
	else if (!after.startsWith('\n')) tail = '\n\n';
	else {
		const next = after.slice(1, after.indexOf('\n', 1) === -1 ? after.length : after.indexOf('\n', 1));
		tail = after === '\n' || !next.trim() ? '' : '\n';
	}
	return { from, to, insert: lead + block + tail, cursor: from + lead.length + block.length + 1 };
}
