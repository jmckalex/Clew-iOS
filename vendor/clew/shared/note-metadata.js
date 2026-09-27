// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Lightweight per-note metadata extraction for the vault index: frontmatter,
// headings, wikilinks, embeds, tags. Pure regex-level scanning — NEVER the
// rendering engine (this runs over every note in the vault on open and on
// every keystroke's save). Code fences, inline code, and math are masked
// first so links/tags inside them don't count.
//
// Drawings are handled here too (extractDrawingMetadata, below): lz-string is
// not the rendering engine, and reading a scene is the same kind of cheap
// structural parse as everything else in this file.
import { parseExcalidraw, drawingText } from './excalidraw-file.js';

const FENCE_RE = /^(```|~~~).*$[\s\S]*?^\1\s*$/gm;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const MATH_BLOCK_RE = /\$\$[\s\S]*?\$\$/g;
const INLINE_MATH_RE = /\$[^$\n]+\$/g;

/** Blank out masked spans (preserving offsets/line structure). */
export function maskSource(text) {
	const blank = (match) => match.replace(/[^\n]/g, ' ');
	return text
		.replace(FENCE_RE, blank)
		.replace(MATH_BLOCK_RE, blank)
		.replace(INLINE_CODE_RE, blank)
		.replace(INLINE_MATH_RE, blank);
}

/** Parse a leading ----fenced YAML frontmatter block (Obsidian style),
 *  extracting only the keys the index cares about: tags, aliases. */
export function parseFrontmatter(text) {
	const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
	if (!match) return { tags: [], aliases: [], end: 0 };
	const body = match[1];
	const lines = body.split('\n');
	const result = { tags: [], aliases: [], end: match[0].length };

	const collect = (key) => {
		const out = [];
		for (let i = 0; i < lines.length; i++) {
			const kv = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'i').exec(lines[i]);
			if (!kv) continue;
			const inline = kv[1].trim();
			if (inline.startsWith('[')) {
				// Inline list: [a, b, c]
				out.push(...inline.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')));
			} else if (inline) {
				out.push(...inline.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')));
			} else {
				// Block list: following "- item" lines
				for (let j = i + 1; j < lines.length; j++) {
					const item = /^\s*-\s+(.*)$/.exec(lines[j]);
					if (!item) break;
					out.push(item[1].trim().replace(/^["']|["']$/g, ''));
				}
			}
			break;
		}
		return out.filter(Boolean);
	};

	result.tags = collect('tags').map((t) => t.replace(/^#/, ''));
	result.aliases = [...collect('aliases'), ...collect('alias')];
	return result;
}

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
// Obsidian block identifiers: `^some-id` ending a line, or alone on one. The
// leading whitespace in the first form is required, and is what keeps a
// superscript (`x^2`) from being read as an identifier — the same rule the
// engine extension uses (src/engine/block-refs.js).
const BLOCK_ID_RE = /(?:^[ \t]*|[ \t])\^([A-Za-z0-9-]{1,128})[ \t]*$/;

/**
 * Replace the TEXT of the block a `^id` marker names, keeping the marker.
 *
 * This is the write half of block-bound widgets (`INPUT[text:^id]`): the
 * marker line's content is replaced wholesale, the ` ^id` tail survives
 * byte-for-byte, and nothing else in the note is touched. Fenced lines are
 * skipped the same way the indexer skips them, so a marker-shaped string
 * inside a code block can never be edited by accident. Multi-line values
 * are flattened to one line — a block marker names one block, and letting
 * a widget split it would detach the marker from the text it names.
 *
 * Returns the new note text, or null when the note has no such marker.
 */
export function rewriteBlockText(text, id, value) {
	const lines = String(text).split('\n');
	const flat = String(value).replace(/\s*\n\s*/g, ' ').trimEnd();
	const re = new RegExp(`^(.*?)([ \\t]+\\^${id})([ \\t]*)$`);
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
		if (inFence) continue;
		const m = re.exec(lines[i]);
		if (!m) continue;
		lines[i] = flat + m[2];
		return lines.join('\n');
	}
	return null;
}
const LINK_RE = /(!?)\[\[([^\[\]|#\n]*)(?:#([^\[\]|\n]+))?(?:\|([^\[\]\n]+))?\]\]/g;
// #tag with nesting; must not match the ### of headings (require non-# before)
// or pure numbers ("bug #123" style is still a tag in Obsidian — keep it).
const TAG_RE = /(^|[\s(,;])#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g;

// ---- cross-reference labels (docs/dev/live-edit.md §5.13) ----------------
//
// The engine's targets, regex-level: `{#key}` / `{id=key}` on a numbered
// environment's opener (`@begin(theorem)[Name]{#thm-a}`, `:::figure[Cap]{id=f}`)
// and `@label[key]` / `:label[key]` anywhere outside code and maths. The
// scanner in renderer/editor/jmd/ knows these shapes too, but shared/ must not
// reach into the renderer; the regexes below are the scanner's rules for an
// opener line, restated.

/** `@begin(name)[caption]{attrs}` / `:::name[caption]{attrs}` on its own line. */
const ENV_OPEN_RE = /^[ \t]*(?:@begin\(([\w*-]+)\)|(:{3,})[ \t]*([\w*-]+))(?:\[([^\]\n]*)\])?(?:\{([^}\n]*)\})?/;
const ENV_CLOSE_RE = /^[ \t]*(?:@end\(([\w*-]+)\)|(:{3,})[ \t]*$)/;
const LABEL_RE = /(^|[^\w@:\\])[@:]label\[([^\]\n]+)\]/g;
/** The same, for stripping a label out of a heading's title (a separate
 *  object: reusing LABEL_RE inside its own exec loop resets lastIndex). */
const LABEL_STRIP_RE = /(^|[^\w@:\\])[@:]label\[([^\]\n]+)\]/g;

/** Environments the engine numbers, and the counter each advances. */
export const THEOREM_KINDS = ['theorem', 'lemma', 'corollary', 'proposition', 'definition', 'example', 'remark'];
const NUMBERED_KINDS = new Set([...THEOREM_KINDS, 'equation', 'figure', 'subfigure', 'table', 'listing']);
/** Bodies the engine takes verbatim: an `@label` inside is not a label. */
const VERBATIM = new Set(['equation', 'TeX', 'HTML', 'comment', 'mermaid', 'TiKZ', 'tikz', 'tikzpicture', 'metapost']);

/**
 * The label key a `{…}` attribute group names: `#key` (the shorthand, which
 * cannot carry a colon — the engine's attribute grammar stops there) or
 * `id=key` / `id="key"`. Null when there is none.
 */
export function attrLabel(attrs) {
	if (!attrs) return null;
	const id = /(?:^|\s)id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s}]+))/.exec(attrs);
	if (id) return (id[1] ?? id[2] ?? id[3]).trim() || null;
	const hash = /(?:^|\s)#([A-Za-z0-9_-]+)(?=\s|$)/.exec(attrs);
	return hash ? hash[1] : null;
}

// ---- citations (docs/dev/live-edit.md §5.14) -------------------------------

/** `\cite`, `\citep`, `\citet`, `\fullcite`, `\parencite`, … — any command
 *  with "cite" in its name — starred, with up to two `[…]` notes. */
const CITE_RE = /\\([a-zA-Z]*cite[a-zA-Z]*)\*?(?:\[[^\]\n]*\]){0,2}\{([^}\n]*)\}/g;
/** Pandoc's bracketed `[@key]` / `[see @a, p. 3; @b]`. */
const PANDOC_BRACKET_RE = /\[[^\[\]\n]*@[^\[\]\n]*\]/g;
const PANDOC_KEY_RE = /(^|[^\w@])-?@([A-Za-z0-9_][\w:.#$%&+?<>~/-]*)/g;
/** A bare `@key` in prose — never a directive (`@begin(`, `@label[`) and
 *  never an address (a word character before the @). */
const PANDOC_BARE_RE = /(^|[^\w@\\[])@([A-Za-z0-9_][\w:.#$%&+?<>~/-]*)(?![\w(\[])/g;
const trimKey = (k) => k.replace(/[.:,;?!]+$/, '');

/**
 * Extract index metadata from a note's text.
 * Lines are 1-based. `links` includes embeds (flagged `embed: true`).
 */
export function extractNoteMetadata(text) {
	const frontmatter = parseFrontmatter(text);
	const masked = maskSource(text);
	const lines = masked.split('\n');
	const rawLines = text.split('\n');

	const headings = [];
	const links = [];
	const blocks = [];
	const labels = [];
	const citations = [];
	/** Open environments, innermost last: {name, kind, line, title, labels}. */
	const envs = [];
	const tags = new Map(); // tag -> [lines]

	// Line indices covered by a fenced block. A blank line INSIDE a fence is
	// content, not a block boundary, and the backward walk that locates a
	// block from its marker has to know the difference.
	const fenced = new Set();
	FENCE_RE.lastIndex = 0;
	for (const fence of text.matchAll(FENCE_RE)) {
		const first = text.slice(0, fence.index).split('\n').length - 1;
		const count = fence[0].split('\n').length;
		for (let k = 0; k < count; k++) fenced.add(first + k);
	}
	const isBoundary = (n) => rawLines[n].trim() === '' && !fenced.has(n);

	// Skip frontmatter lines for headings/tags/links scanning.
	const fmLineCount = frontmatter.end ? text.slice(0, frontmatter.end).split('\n').length - 1 : 0;

	for (let i = fmLineCount; i < lines.length; i++) {
		const line = lines[i];
		const lineNo = i + 1;

		const heading = HEADING_RE.exec(rawLines[i] ?? '');
		if (heading && HEADING_RE.test(line)) {
			headings.push({ level: heading[1].length, text: heading[2].trim(), line: lineNo });
		}

		// Citations: the \cite family, then pandoc's forms (flagged — the
		// vault's pandocCitations switch decides whether they count).
		CITE_RE.lastIndex = 0;
		for (let cm; (cm = CITE_RE.exec(line));) {
			for (const key of cm[2].split(',').map((k) => k.trim()).filter(Boolean)) {
				citations.push({ key, line: lineNo, command: cm[1], pandoc: false });
			}
		}
		const bracketed = [];
		PANDOC_BRACKET_RE.lastIndex = 0;
		for (let bm; (bm = PANDOC_BRACKET_RE.exec(line));) {
			bracketed.push([bm.index, bm.index + bm[0].length]);
			PANDOC_KEY_RE.lastIndex = 0;
			for (let km; (km = PANDOC_KEY_RE.exec(bm[0]));) {
				citations.push({ key: trimKey(km[2]), line: lineNo, command: '[@]', pandoc: true });
			}
		}
		PANDOC_BARE_RE.lastIndex = 0;
		for (let pm; (pm = PANDOC_BARE_RE.exec(line));) {
			const at = pm.index + pm[1].length;
			if (bracketed.some(([a, b]) => at >= a && at < b)) continue;
			citations.push({ key: trimKey(pm[2]), line: lineNo, command: '@', pandoc: true });
		}

		// Cross-reference labels: environment openers and closers first
		// (read from the raw line — maths masking must not hide an opener).
		const raw = rawLines[i] ?? '';
		const verbatim = envs.length > 0 && VERBATIM.has(envs[envs.length - 1].name);
		const close = !fenced.has(i) ? ENV_CLOSE_RE.exec(raw) : null;
		const open = !fenced.has(i) && !close ? ENV_OPEN_RE.exec(raw) : null;
		if (close && envs.length) {
			const name = close[1];
			// `@end(x)` closes the innermost open x; a bare `:::` the innermost
			// ::: directive.
			let at = envs.length - 1;
			if (name) while (at >= 0 && envs[at].name !== name) at--;
			else while (at >= 0 && !envs[at].colons) at--;
			if (at >= 0) {
				for (const env of envs.splice(at)) for (const l of env.labels) l.host.to = lineNo;
			}
		} else if (open && !verbatim) {
			const name = open[1] ?? open[3];
			const kind = NUMBERED_KINDS.has(name) ? name : `env:${name}`;
			const env = { name, kind, colons: Boolean(open[2]), line: lineNo, title: (open[4] ?? '').trim(), labels: [] };
			envs.push(env);
			const key = attrLabel(open[5]);
			if (key) {
				const label = { key, kind, line: lineNo, col: raw.indexOf(open[5]), title: env.title, host: { from: lineNo, to: lineNo } };
				labels.push(label);
				env.labels.push(label);
			}
		} else if (!verbatim) {
			LABEL_RE.lastIndex = 0;
			let lm;
			while ((lm = LABEL_RE.exec(line)) !== null) {
				const col = lm.index + lm[1].length;
				// The host, as the post-processor decides it: a footnote's
				// body, else the innermost NUMBERED environment, else this
				// heading, else nothing (a plain label, numberless).
				const before = line.slice(0, col);
				const inFootnote = /\[(?:fn:|\^)[^\]]*$/.test(before) || /^\[\^[^\]]+\]:/.test(raw);
				const host = [...envs].reverse().find((e) => NUMBERED_KINDS.has(e.kind) || e.kind.startsWith('env:'));
				let label;
				if (inFootnote) label = { kind: 'footnote', title: '', host: { from: lineNo, to: lineNo } };
				else if (host) label = { kind: host.kind, title: host.title, host: { from: host.line, to: host.line } };
				else if (heading) label = { kind: 'section', title: heading[2].replace(LABEL_STRIP_RE, '$1').trim(), host: { from: lineNo, to: lineNo } };
				else label = { kind: 'plain', title: '', host: { from: lineNo, to: lineNo } };
				const entry = { key: lm[2].trim(), line: lineNo, col, ...label };
				labels.push(entry);
				if (host && !inFootnote) host.labels.push(entry);
			}
		}

		// Block identifiers. The recorded line is the one to SCROLL TO, which
		// for a marker on its own line is the top of the block above it, not
		// the marker: landing on the marker would leave the table or the code
		// fence it names sitting off the top of the window.
		const blockId = BLOCK_ID_RE.exec(line);
		if (blockId && !heading) {
			// The walk reads rawLines, not the masked copy: masking blanks a
			// fenced block wholesale, so a masked walk would stride straight
			// over the very code block the marker was put there to name.
			let at = i;
			if (/^[ \t]*\^/.test(line)) {
				at = i - 1;
				while (at >= 0 && isBoundary(at)) at--;
				while (at > 0 && !isBoundary(at - 1)) at--;
			}
			if (at >= 0) blocks.push({ id: blockId[1], line: at + 1 });
		}

		LINK_RE.lastIndex = 0;
		let m;
		while ((m = LINK_RE.exec(line)) !== null) {
			const target = m[2].trim();
			const heading_ = m[3]?.trim() ?? null;
			if (!target && !heading_) continue;
			links.push({
				target,
				heading: heading_,
				alias: m[4]?.trim() ?? null,
				embed: m[1] === '!',
				line: lineNo,
			});
		}

		// Tags — but not on heading lines' leading #s (regex requires non-# lead-in
		// or start; a "# Heading" line starts with "# " so the space rule holds).
		if (!heading) {
			TAG_RE.lastIndex = 0;
			while ((m = TAG_RE.exec(line)) !== null) {
				const tag = m[2].replace(/\/+$/, '');
				if (/^\d+$/.test(tag)) continue; // pure numbers ("#123") are not tags (Obsidian rule)
				if (!tags.has(tag)) tags.set(tag, []);
				tags.get(tag).push(lineNo);
			}
		}
	}

	for (const tag of frontmatter.tags) {
		const clean = tag.replace(/^#/, '');
		if (clean && !tags.has(clean)) tags.set(clean, [0]);
	}

	return {
		aliases: frontmatter.aliases,
		headings,
		blocks,
		labels,
		citations,
		links,
		tags: [...tags.entries()].map(([tag, lineNos]) => ({ tag, lines: lineNos })),
	};
}

/**
 * Metadata for an Excalidraw drawing, in the same shape as a note's.
 *
 * The drawing's text elements are treated as the document's text, so the
 * existing scanner finds the links and tags written inside it — no second
 * implementation, and a drawing joins the graph on equal terms with a note.
 * Falls back to null when the file holds no scene, which lets the caller
 * treat it as ordinary text.
 */
export function extractDrawingMetadata(text, path) {
	const parsed = parseExcalidraw(text, path);
	if (!parsed) return null;
	const meta = extractNoteMetadata(drawingText(parsed.scene));
	// The markdown wrapper's frontmatter still carries tags and aliases when
	// there is one; a plain .excalidraw has none.
	const frontmatter = parseFrontmatter(text);
	return {
		...meta,
		aliases: frontmatter.aliases?.length ? frontmatter.aliases : meta.aliases,
		tags: [...meta.tags, ...frontmatter.tags.map((tag) => ({ tag, lines: [1] }))],
	};
}

/**
 * A context snippet for a backlink: the trimmed line containing it.
 */
export function lineSnippet(text, lineNo, maxLength = 200) {
	const line = text.split('\n')[lineNo - 1] ?? '';
	const trimmed = line.trim();
	return trimmed.length > maxLength ? trimmed.slice(0, maxLength) + '…' : trimmed;
}
