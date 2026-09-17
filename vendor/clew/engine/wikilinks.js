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
//     [[Note#^block-id]] — a block reference (see block-refs.js for the marker)
//     ![[Note]] / ![[Note#Heading]] / ![[Note#^block-id]] on its own line —
//     transclusion of the note, the section, or the single block
//
// This file runs inside a one-shot jmarkdown worker: module-level caches last
// exactly one build, so the lazy vault scan below is per-build by construction.
// The vault root comes from CLEW_VAULT_ROOT (set by Clew's render service);
// without it, links render unresolved but nothing breaks.
import fs from 'node:fs';
import path from 'node:path';
import { sliceBlock } from './block-refs.js';
import { renderBaseEmbed } from './bases.js';

const NOTE_EXT = /\.(md|jmd)$/i;
const IGNORED = new Set(['.obsidian', '.clew', '.git', 'node_modules', '.trash']);

const MEDIA_KIND = {
	'.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image',
	'.webp': 'image', '.avif': 'image', '.svg': 'image', '.bmp': 'image',
	'.pdf': 'pdf',
	'.mp3': 'audio', '.m4a': 'audio', '.wav': 'audio', '.ogg': 'audio', '.flac': 'audio',
	'.mp4': 'video', '.webm': 'video', '.mov': 'video',
	'.canvas': 'canvas',
	'.excalidraw': 'excalidraw',
	'.base': 'base',
	// Office documents embed as a cached static thumbnail by default, or as
	// a full live LibreOffice with the `|live` alias — the user's explicit
	// opt-in to a ~1.6 GB editor per embed (owner's decision, 2026-09-01).
	'.docx': 'office', '.xlsx': 'office', '.pptx': 'office',
	'.odt': 'office', '.ods': 'office', '.odp': 'office',
};
// An Obsidian drawing is `name.excalidraw.md` — a .md by extension, which the
// note path would otherwise claim and transclude as prose. The compound suffix
// is therefore tested first.
const mediaKind = (p) => {
	if (/\.excalidraw\.md$/i.test(p)) return 'excalidraw';
	return MEDIA_KIND[p.slice(p.lastIndexOf('.')).toLowerCase()] ?? null;
};

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

import { parseEmbedModes } from './embed-state.js';

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

// [[target]] / [[target#heading]] / [[target#^block-id]] / [[target|alias]] —
// target may be empty for same-file links ([[#Heading]], [[#^block-id]]).
const LINK_RE = /^\[\[([^\[\]|#\n]*)(?:#([^\[\]|\n]+))?(?:\|([^\[\]\n]+))?\]\]/;

function parseLink(match) {
	const target = match[1].trim();
	const fragment = match[2]?.trim() ?? null;
	// Obsidian overloads `#`: a leading caret means a block identifier rather
	// than a heading. They resolve against different things, so they are split
	// apart here once and never re-sniffed downstream.
	const isBlock = fragment !== null && fragment.startsWith('^');
	const block = isBlock ? fragment.slice(1).trim() : null;
	const heading = isBlock ? null : fragment;
	const alias = match[3]?.trim() ?? null;
	// § for a heading, ¶ for a block: the typographic marks for precisely these
	// two things, so a reader can see which kind of link it is without being
	// shown Obsidian's `#^` machinery.
	const section = block ? `¶ ${block}` : heading ? `§ ${heading}` : null;
	const label = alias ?? (target && section ? `${target} ${section}` : target || section || '');
	const full = target + (fragment ? `#${fragment}` : '');
	return { target, fragment, heading, block, alias, label, full };
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
		// Clew-native: `[[paper.pdf|external]]` hands the file to the OS
		// default app instead of opening a Clew tab — the same "the alias is
		// the consent" shape as the office `|live` embed. An alias that was
		// ONLY the mode is not a caption, so the label falls back to the name.
		const aliasParts = (token.alias ?? '').split('|').map((s) => s.trim());
		const wantsExternal = aliasParts.some((p) => p.toLowerCase() === 'external');
		if (wantsExternal && token.target) {
			const rest = aliasParts.filter((p) => p.toLowerCase() !== 'external').join('|');
			const label = escapeHtml(rest || token.target);
			const fileRel = resolveFileTarget(token.target) ?? resolveTarget(token.target);
			if (!fileRel) return `<span class="internal-link unresolved">${label}</span>`;
			// A static site has no OS shell to hand anything to: link to the
			// file itself, which is what "open this outside" means there.
			if (SITE_EXPORT) {
				return `<a class="internal-link" href="${escapeAttr(sitePath(fileRel))}">${label}</a>`;
			}
			return `<a class="internal-link external-file" href="#"`
				+ ` data-open-external="${escapeAttr(fileRel)}">${label}</a>`;
		}
		if (SITE_EXPORT) {
			const rel = token.target ? resolveTarget(token.target) : null;
			if (!rel) return `<span class="internal-link unresolved">${escapeHtml(token.label)}</span>`;
			const page = sitePath(rel.replace(NOTE_EXT, '')) + '.html'
				// A block anchor's id IS `^the-id`; browsers percent-decode a
				// fragment before matching, so `#%5Ethe-id` lands on it.
				+ (token.fragment ? `#${encodeURIComponent(token.fragment)}` : '');
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
		let fileRel = link.target ? resolveFileTarget(link.target) : null;
		// An Obsidian drawing is `name.excalidraw.md`, so it lives in the NOTE
		// index and resolveFileTarget never finds it. Without this it falls
		// through to note transclusion and the embed renders the wrapper's
		// prose and its base64 payload — the exact failure this feature exists
		// to prevent.
		if (!fileRel && link.target) {
			const noteRel = resolveTarget(link.target);
			if (noteRel && /\.excalidraw\.md$/i.test(noteRel)) fileRel = noteRel;
		}
		if (fileRel && mediaKind(fileRel)) {
			let alias = link.alias;
			token.media = { rel: fileRel, kind: mediaKind(fileRel) };
			// Office embeds: a `live` alias segment picks the live editor over
			// the default thumbnail, and is consumed before the caption/size
			// parse so it never becomes alt text.
			if (token.media.kind === 'office' && alias) {
				const parts = alias.split('|').map((s) => s.trim());
				token.media.live = parts.some((p) => p.toLowerCase() === 'live');
				alias = parts.filter((p) => p.toLowerCase() !== 'live').join('|') || null;
				// An alias that was ONLY the mode is not a caption.
				if (!alias) token.label = link.target;
			}
			// A note-embed keyword on a media embed does nothing — but it must
			// not become the alt text either, which is what it did before the
			// keywords existed to be mistaken for captions.
			if (alias) {
				const stripped = parseEmbedModes(alias);
				if (stripped.state || stripped.chrome) {
					alias = stripped.alias;
					if (!alias) token.label = link.target;
				}
			}
			const { alt, width, height } = parseMediaAlias(alias);
			token.media.width = width;
			token.media.height = height;
			// `![[Trips.base#Location]]` names a VIEW, not a heading — the one
			// embed whose fragment means something other than a place to scroll.
			if (token.media.kind === 'base') token.media.view = link.heading ?? null;
			// A pure-size alias ("300") is not a caption — fall back to the name.
			if (alias) token.label = alt ?? link.target;
			return token;
		}

		// `![[Note|collapsed]]` / `![[Note|open]]`: a note embed that discloses.
		// Read BEFORE the resolution guard so that even an embed that resolves
		// to nothing gets its title fixed — otherwise the "not found" box
		// would be titled "collapsed". Depth is recorded here, while the
		// embed stack still means something: only a top-level embed's line
		// number belongs to the note being rendered, and only that one can be
		// toggled back into its source (see the renderer).
		const modes = parseEmbedModes(link.alias);
		if (modes.state || modes.chrome) {
			// `bare` draws no title bar, so there is nothing to disclose and a
			// folded one would render as literally nothing. Chrome wins.
			token.embedChrome = modes.chrome;
			token.embedState = modes.chrome === 'bare' ? null : modes.state;
			token.label = modes.alias ?? link.target;
			token.embedDepth = embedStack.length;
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
		} else if (link.block) {
			const chunk = sliceBlock(content, link.block);
			if (chunk === null) { token.failed = 'missing-block'; return token; }
			content = chunk;
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
				case 'excalidraw':
					// A read-only Excalidraw view. The preview client turns this
					// into an iframe running the editor page in view mode, lazily
					// — each one is a React instance, so a note holding several
					// drawings must not build them all at once.
					return `<div class="internal-embed excalidraw-embed-box">`
						+ `<div class="embed-title"><a class="internal-link" href="#" data-href="${escapeAttr(token.full)}">${alt}</a></div>`
						+ `<div class="excalidraw-embed" data-excalidraw-src="${src}"`
						+ ` data-excalidraw-path="${escapeAttr(token.media.rel ?? '')}"></div></div>\n`;
				case 'base': {
					// An Obsidian Bases view, rendered server-side like a query
					// rather than shipped to the client — it is a table over the
					// vault, and the worker is where the vault is.
					const html = renderBaseEmbed(token.media.rel, token.media.view,
						(rel) => { try { return fs.readFileSync(path.join(vaultRoot(), rel), 'utf8'); } catch { return null; } });
					// The title is the base FILE. Its `§` label would read as a
					// heading, and the fragment here names a view — which the
					// rendered output captions for itself.
					const baseName = escapeHtml(token.media.rel.split('/').pop());
					return `<div class="internal-embed base-embed" data-href="${escapeAttr(token.full)}">`
						+ `<div class="embed-title"><a class="internal-link" href="#" data-href="${escapeAttr(token.full)}">${baseName}</a></div>`
						+ html + '</div>\n';
				}
				case 'office': {
					// Thumbnail by default (a cached PNG the preview client asks
					// the app to render — office-thumbs.js), or the |live editor:
					// the SAME ZetaOffice page the office tabs run, nested in the
					// preview. The iframe carries a stable id so morphdom matches
					// it across re-renders (a booted LibreOffice must not reload
					// because a paragraph above it changed) while a genuinely
					// deleted embed is still discarded. It dies with the preview
					// document itself (tab switch, mode toggle) — save first.
					if (SITE_EXPORT) {
						return `<div class="internal-embed office-embed-box"><div class="embed-title">${alt} (office document)</div></div>\n`;
					}
					if (token.media.live) {
						const h = token.media.height ?? 520;
						const frameId = 'office-live-' + token.media.rel.replace(/[^a-zA-Z0-9]+/g, '-');
						const pageUrl = '/__clew_assets__/clewzeta/zeta-page.html'
							+ `?src=${encodeURIComponent(src)}&path=${encodeURIComponent(token.media.rel)}`;
						return `<div class="internal-embed office-embed-box is-live">`
							+ `<div class="embed-title"><a class="internal-link" href="#" data-href="${escapeAttr(token.full)}">${alt}</a></div>`
							+ `<iframe class="office-embed-live" id="${escapeAttr(frameId)}"`
							+ ` allow="clipboard-read; clipboard-write"`
							+ ` style="height:${h}px" src="${escapeAttr(pageUrl)}"></iframe></div>\n`;
					}
					const style = token.media.height ? ` style="max-height:${token.media.height}px"` : '';
					return `<div class="internal-embed office-embed-box">`
						+ `<div class="embed-title"><a class="internal-link" href="#" data-href="${escapeAttr(token.full)}">${alt}</a></div>`
						+ `<a class="internal-link office-embed-thumb" href="#" data-href="${escapeAttr(token.full)}"`
						+ ` data-office-path="${escapeAttr(token.media.rel)}"${style}></a></div>\n`;
				}
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
			const reason = token.failed === 'cycle' ? 'circular embed'
				: token.failed === 'missing-block' ? 'no such block'
				: token.failed === 'missing-heading' ? 'no such heading'
				: 'not found';
			return `<div class="internal-embed unresolved" data-href="${target}">`
				+ `<div class="embed-title">${title}</div>`
				+ `<div class="embed-note">(${reason})</div></div>\n`;
		}
		const body = `<div class="embed-content">\n${this.parser.parse(token.tokens)}</div>`;
		// `|bare`: no frame, no title, no disclosure — the transcluded note
		// reads as part of this one. The wrapper stays (and keeps its class
		// and data-href) so the preview client's DOM contract and any vault
		// stylesheet still have something to hold on to; the CSS is what
		// takes the decoration away.
		if (token.embedChrome === 'bare') {
			return `<div class="internal-embed is-bare" data-href="${target}">${body}</div>\n`;
		}
		const chrome = token.embedChrome ? ` is-${token.embedChrome}` : '';
		if (token.embedState) {
			// A real <details>, so the disclosure works with no script at all —
			// in an export, on a static site, under any browser. The host only
			// has to hear about the toggle to write it back.
			//
			// data-embed-line is what it writes: the line of THIS `![[…]]` in
			// the note being rendered. A nested embed's line belongs to some
			// other file, so it is left unstamped and toggles for the session
			// only — the alternative is rewriting the wrong line of the wrong
			// note. The title stays an anchor: clicking it opens the note (the
			// client preventDefaults, which also stops the disclosure), while
			// clicking anywhere else in the summary discloses.
			const open = token.embedState === 'open' ? ' open' : '';
			const line = token.embedDepth === 0 && token.sourceLine !== undefined
				? ` data-embed-line="${token.sourceLine}"` : '';
			return `<details class="internal-embed is-collapsible${chrome}"${open}${line} data-href="${target}">`
				+ `<summary class="embed-title"><a class="internal-link" href="#" data-href="${target}">${title}</a></summary>`
				+ `${body}</details>\n`;
		}
		return `<div class="internal-embed${chrome}" data-href="${target}">`
			+ `<div class="embed-title"><a class="internal-link" href="#" data-href="${target}">${title}</a></div>`
			+ `${body}</div>\n`;
	},
};

export default [wikiembed, wikilink];
