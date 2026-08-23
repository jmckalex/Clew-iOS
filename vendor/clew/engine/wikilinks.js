// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Obsidian-style wikilinks for jmarkdown, loaded into the render worker via
// the vault's generated .jmarkdown/config.json:
//
//     "Extensions": ["wikiembed, wikilink from <dist>/engine/wikilinks.js"]
//
// Syntax (Obsidian-compatible):
//     [[Note]]  [[Note|alias]]  [[Note#Heading]]  [[Note#Heading|alias]]
//     ![[Note]] / ![[Note#Heading]] on its own line — block embed (transclusion)
//
// This file runs inside a one-shot jmarkdown worker: module-level caches last
// exactly one build, so the lazy vault scan below is per-build by construction.
// The vault root comes from CLEW_VAULT_ROOT (set by Clew's render service);
// without it, links render unresolved but nothing breaks.
import fs from 'node:fs';
import path from 'node:path';

const NOTE_EXT = /\.(md|jmd)$/i;
const IGNORED = new Set(['.obsidian', '.clew', '.git', 'node_modules', '.trash']);

const MEDIA_KIND = {
	'.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image',
	'.webp': 'image', '.avif': 'image', '.svg': 'image', '.bmp': 'image',
	'.pdf': 'pdf',
	'.mp3': 'audio', '.m4a': 'audio', '.wav': 'audio', '.ogg': 'audio', '.flac': 'audio',
	'.mp4': 'video', '.webm': 'video', '.mov': 'video',
	'.canvas': 'canvas',
};
const mediaKind = (p) => MEDIA_KIND[p.slice(p.lastIndexOf('.')).toLowerCase()] ?? null;

let noteIndex = null; // Map<lowercased basename-no-ext, string[] of vault-relative paths>
let fileIndex = null; // Map<lowercased basename WITH ext, string[]> for non-note files

function vaultRoot() {
	return process.env.CLEW_VAULT_ROOT || null;
}

// Static-site exports (File → Export Vault as Website) render with this set:
// wikilinks become REAL relative hrefs to the exported .html pages instead of
// data-href anchors the app's click handler would resolve.
const SITE_EXPORT = process.env.CLEW_SITE_EXPORT === '1';

function buildIndexes(root) {
	noteIndex = new Map();
	fileIndex = new Map();
	const add = (index, key, rel) => {
		if (!index.has(key)) index.set(key, []);
		index.get(key).push(rel);
	};
	const walk = (dir, rel) => {
		let entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (entry.name.startsWith('.') || IGNORED.has(entry.name)) continue;
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
			else if (NOTE_EXT.test(entry.name)) {
				add(noteIndex, entry.name.replace(NOTE_EXT, '').toLowerCase(), childRel);
			} else {
				add(fileIndex, entry.name.toLowerCase(), childRel);
			}
		}
	};
	walk(root, '');
}

const shortestOf = (matches) =>
	matches?.length ? [...matches].sort((a, b) => a.length - b.length || a.localeCompare(b))[0] : null;

/**
 * Resolve a wikilink target to a vault-relative path, Obsidian-style:
 * an explicit path (contains '/') resolves directly; a bare name matches by
 * basename with the shortest path winning. Returns null when unresolved.
 */
export function resolveTarget(target) {
	const root = vaultRoot();
	if (!root) return null;
	if (noteIndex === null) buildIndexes(root);

	const clean = target.trim();
	if (!clean) return null;
	if (clean.includes('/')) {
		for (const candidate of [clean, `${clean}.md`, `${clean}.jmd`]) {
			if (fs.existsSync(path.join(root, candidate)) && NOTE_EXT.test(candidate)) return candidate;
		}
		return null;
	}
	return shortestOf(noteIndex.get(clean.replace(NOTE_EXT, '').toLowerCase()));
}

/** Resolve a non-note file target (attachment) to a vault-relative path. */
export function resolveFileTarget(target) {
	const root = vaultRoot();
	if (!root) return null;
	if (fileIndex === null) buildIndexes(root);

	const clean = target.trim();
	if (!clean) return null;
	if (clean.includes('/')) {
		return fs.existsSync(path.join(root, clean)) && !NOTE_EXT.test(clean) ? clean : null;
	}
	return shortestOf(fileIndex.get(clean.toLowerCase()));
}

/** Site-absolute URL path for a vault file. Preview documents live at
 *  clew-preview://vault/<sid>/<note path>, so vault URLs must carry the
 *  session id as their first segment (CLEW_SESSION_ID, set by the render
 *  service) — a bare "/rel/path" would resolve against the origin root and
 *  lose it. Without a session id (standalone CLI use), fall back to "/". */
export const sitePath = (rel) => {
	const sid = process.env.CLEW_SESSION_ID;
	const encoded = rel.split('/').map(encodeURIComponent).join('/');
	return sid ? `/${encodeURIComponent(sid)}/${encoded}` : `/${encoded}`;
};

const escapeAttr = (s) =>
	s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeHtml = escapeAttr;

/**
 * Obsidian media-embed alias: the segment after the last '|' may be a size —
 * "300" (width) or "300x200" (width × height) — with any earlier segments
 * forming the alt text: ![[img.png|300]], ![[img.png|A caption|300]].
 * Returns { alt, width, height } (alt null when the alias was only a size).
 */
export function parseMediaAlias(alias) {
	if (!alias) return { alt: null, width: null, height: null };
	const parts = alias.split('|').map((s) => s.trim());
	const m = /^(\d+)(?:x(\d+))?$/.exec(parts[parts.length - 1]);
	if (!m) return { alt: alias, width: null, height: null };
	return {
		alt: parts.slice(0, -1).join('|') || null,
		width: Number(m[1]),
		height: m[2] ? Number(m[2]) : null,
	};
}

// [[target]] / [[target#heading]] / [[target|alias]] — target may be empty
// for same-file heading links ([[#Heading]]).
const LINK_RE = /^\[\[([^\[\]|#\n]*)(?:#([^\[\]|\n]+))?(?:\|([^\[\]\n]+))?\]\]/;

function parseLink(match) {
	const target = match[1].trim();
	const heading = match[2]?.trim() ?? null;
	const alias = match[3]?.trim() ?? null;
	const label = alias ?? (target && heading ? `${target} § ${heading}` : target || heading || '');
	const full = target + (heading ? `#${heading}` : '');
	return { target, heading, alias, label, full };
}

export const wikilink = {
	name: 'wikilink',
	level: 'inline',
	start(src) { return src.indexOf('[['); },
	tokenizer(src) {
		const match = LINK_RE.exec(src);
		if (!match) return;
		const link = parseLink(match);
		if (!link.target && !link.heading) return; // [[]] is not a link
		return { type: 'wikilink', raw: match[0], ...link };
	},
	renderer(token) {
		if (global.isLatex) return token.label;
		if (SITE_EXPORT) {
			const rel = token.target ? resolveTarget(token.target) : null;
			if (!rel) return `<span class="internal-link unresolved">${escapeHtml(token.label)}</span>`;
			const page = sitePath(rel.replace(NOTE_EXT, '')) + '.html'
				+ (token.heading ? `#${encodeURIComponent(token.heading)}` : '');
			return `<a class="internal-link" href="${escapeAttr(page)}">${escapeHtml(token.label)}</a>`;
		}
		const resolved = token.target
			? resolveTarget(token.target) !== null || resolveFileTarget(token.target) !== null
			: true;
		const cls = resolved ? 'internal-link' : 'internal-link unresolved';
		return `<a class="${cls}" href="#" data-href="${escapeAttr(token.full)}">${escapeHtml(token.label)}</a>`;
	},
};

// Transclusion depth guard: embeds may nest (an embedded note with its own
// embeds) but cycles and runaway chains must not hang a build.
const embedStack = [];
const MAX_EMBED_DEPTH = 3;

/** Slice a heading's section out of a note: from the heading line to the next
 *  heading of the same or higher level. */
function sliceHeading(content, heading) {
	const lines = content.split('\n');
	const headingRe = /^(#{1,6})\s+(.*?)\s*(?:\{[^}]*\})?\s*$/;
	let start = -1;
	let level = 0;
	for (let i = 0; i < lines.length; i++) {
		const m = headingRe.exec(lines[i]);
		if (m && m[2].toLowerCase() === heading.toLowerCase()) {
			start = i;
			level = m[1].length;
			break;
		}
	}
	if (start === -1) return null;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		const m = headingRe.exec(lines[i]);
		if (m && m[1].length <= level) { end = i; break; }
	}
	return lines.slice(start, end).join('\n');
}

export const wikiembed = {
	name: 'wikiembed',
	level: 'block',
	start(src) { return src.indexOf('![['); },
	tokenizer(src) {
		// Own-line block embeds only; a mid-sentence ![[…]] falls through (the
		// '!' becomes text and [[…]] renders as an ordinary wikilink).
		const match = /^!\[\[([^\[\]|#\n]*)(?:#([^\[\]|\n]+))?(?:\|([^\[\]\n]+))?\]\][ \t]*(?:\n+|$)/.exec(src);
		if (!match) return;
		const link = parseLink(match);
		const token = { type: 'wikiembed', raw: match[0], ...link, tokens: [], failed: null };

		// Media embeds: ![[img.png]], ![[paper.pdf]], ![[clip.mp3]] …
		const fileRel = link.target ? resolveFileTarget(link.target) : null;
		if (fileRel && mediaKind(fileRel)) {
			const { alt, width, height } = parseMediaAlias(link.alias);
			token.media = { rel: fileRel, kind: mediaKind(fileRel), width, height };
			// A pure-size alias ("300") is not a caption — fall back to the name.
			if (link.alias) token.label = alt ?? link.target;
			return token;
		}

		const rel = link.target ? resolveTarget(link.target) : null;
		if (!rel) {
			token.failed = 'unresolved';
			return token;
		}
		const abs = path.join(vaultRoot(), rel);
		if (embedStack.includes(abs) || embedStack.length >= MAX_EMBED_DEPTH) {
			token.failed = 'cycle';
			return token;
		}
		let content;
		try { content = fs.readFileSync(abs, 'utf8'); } catch { token.failed = 'unreadable'; return token; }
		// Strip YAML frontmatter — the embed shows the body only.
		content = content.replace(/^---\n[\s\S]*?\n---\n/, '');
		if (link.heading) {
			const section = sliceHeading(content, link.heading);
			if (section === null) { token.failed = 'missing-heading'; return token; }
			content = section;
		}
		embedStack.push(abs);
		try {
			this.lexer.blockTokens(content, token.tokens);
		} finally {
			embedStack.pop();
		}
		return token;
	},
	renderer(token) {
		if (global.isLatex) {
			if (token.media) {
				// Images (and single-page PDFs) go through includegraphics; other
				// media has no LaTeX rendering. A |width in CSS px → pt (×0.75).
				if (token.media.kind === 'image' || token.media.kind === 'pdf') {
					const abs = path.join(vaultRoot(), token.media.rel);
					const w = token.media.width
						? `width=${token.media.width * 0.75}pt` : 'max width=\\linewidth';
					return `\\begin{center}\\includegraphics[${w}]{${abs}}\\end{center}\n`;
				}
				return '';
			}
			return token.failed ? '' : this.parser.parse(token.tokens);
		}
		if (token.media) {
			const src = sitePath(token.media.rel);
			const alt = escapeAttr(token.label);
			const dims = (token.media.width ? ` width="${token.media.width}"` : '')
				+ (token.media.height ? ` height="${token.media.height}"` : '');
			switch (token.media.kind) {
				case 'image':
					return `<img class="internal-media" src="${src}" alt="${alt}"${dims}>\n`;
				case 'pdf':
					return `<div class="internal-embed pdf-embed-box">`
						+ `<div class="embed-title"><a class="internal-link" href="#" data-href="${escapeAttr(token.full)}">${alt}</a></div>`
						+ `<embed class="pdf-embed" src="${src}" type="application/pdf"></div>\n`;
				case 'audio':
					return `<audio class="internal-media" controls src="${src}"></audio>\n`;
				case 'video':
					return `<video class="internal-media" controls src="${src}"${dims}></video>\n`;
				case 'canvas':
					// A live, read-only canvas view — the preview client fetches
					// the JSON at data-canvas-path and renders the scene into the
					// shell (canvas-embed.js). Static sites have no scene builder,
					// so exports show a labeled box instead.
					if (SITE_EXPORT) {
						return `<div class="internal-embed canvas-embed"><div class="embed-title">${alt} (canvas)</div></div>\n`;
					}
					return `<div class="internal-embed canvas-embed" data-canvas-path="${src}">`
						+ `<div class="embed-title"><a class="internal-link" href="#" data-href="${escapeAttr(token.full)}">${alt}</a></div>`
						+ `<div class="canvas-embed-scene"></div></div>\n`;
			}
		}
		const title = escapeHtml(token.label);
		const target = escapeAttr(token.full);
		if (token.failed) {
			const reason = token.failed === 'cycle' ? 'circular embed' : 'not found';
			return `<div class="internal-embed unresolved" data-href="${target}">`
				+ `<div class="embed-title">${title}</div>`
				+ `<div class="embed-note">(${reason})</div></div>\n`;
		}
		return `<div class="internal-embed" data-href="${target}">`
			+ `<div class="embed-title"><a class="internal-link" href="#" data-href="${target}">${title}</a></div>`
			+ `<div class="embed-content">\n${this.parser.parse(token.tokens)}</div></div>\n`;
	},
};

export default [wikiembed, wikilink];
