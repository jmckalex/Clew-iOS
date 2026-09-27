// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The vault as a table of PAGES — one row per note, with the implicit `file.*`
// fields Dataview and Bases both query over, and the link graph they both
// need. `query-fences.js` reads its own, simpler model; this is the richer one
// those two dialects share, so there is one place that decides what
// `file.inlinks` means.
//
// Everything is cached at module level, which in this codebase means "for
// exactly one build": the render worker is one-shot (see CLAUDE.md), so a
// note holding six queries scans the vault once, and the next render starts
// from a clean process.
//
// Deliberately does NOT import wikilinks.js. That file needs to reach bases.js
// to render a `![[Board.base]]` embed, so anything wikilinks imports must not
// import it back — hence the small resolver below rather than reusing
// `resolveTarget`.
import fs from 'node:fs';
import path from 'node:path';
import { readFrontmatter, extractTasks } from './query-fences.js';

const NOTE_FILE = /\.(md|jmd)$/i;
const IGNORED = new Set(['.obsidian', '.clew', '.git', 'node_modules', '.trash']);

// ---- links -----------------------------------------------------------------

/**
 * A link value. Dataview compares these by target, not by display text, so
 * `contains(this.file.inlinks, file.link)` works regardless of how either
 * side was written.
 */
export function makeLink(target, display = null, subpath = null) {
	return { __link: true, path: target, display, subpath };
}

export const isLink = (v) => v !== null && typeof v === 'object' && v.__link === true;

/**
 * Is this value a LINK in spirit — a link object, a page, a `file` namespace,
 * or a frontmatter string someone wrote as `[[Note]]`?
 *
 * The distinction matters because linkKey() will happily reduce any string,
 * and comparing two ordinary strings by their link identity would make
 * `contains(file.name, "ign")` a failed link lookup instead of a substring
 * test. Link rules apply only when at least one side really is a link.
 */
export function isLinkish(value) {
	if (isLink(value)) return true;
	if (typeof value === 'string') return /^\[\[[\s\S]*\]\]$/.test(value.trim());
	if (value !== null && typeof value === 'object') {
		return isLink(value.link) || isLink(value.file?.link) || typeof value.path === 'string';
	}
	return false;
}

/**
 * The comparable identity of a link, a page, a `file` namespace, or a plain
 * string. Bases writes `file.hasLink(this)`, where one side is a namespace
 * object and the other a page — both have to reduce to the same key.
 */
export function linkKey(value) {
	const target = linkTarget(value);
	return target === null ? null : canonicalKey(target);
}

function linkTarget(value) {
	if (isLink(value)) return value.path;
	if (value !== null && typeof value === 'object') {
		if (isLink(value.link)) return value.link.path;
		if (value.file && isLink(value.file.link)) return value.file.link.path;
		if (typeof value.path === 'string') return value.path;
	}
	if (typeof value === 'string') return value.replace(/^\[\[|\]\]$/g, '').split('|')[0].split('#')[0];
	return null;
}

const keyCache = new Map();

/**
 * A link target reduced to one identity.
 *
 * The two sides of a comparison rarely arrive in the same form: the model
 * builds links with FULL PATHS, while a frontmatter value is whatever the
 * author typed — `loc: "[[Japan]]"`. Keying those as "places/japan" and
 * "japan" made `list(loc).contains(this)` — kepano's commonest filter — match
 * nothing at all. So a bare name is resolved the way a wikilink would be, and
 * both sides end up at the same key.
 */
function canonicalKey(target) {
	const clean = stripExt(String(target).trim());
	if (!clean) return null;
	if (keyCache.has(clean)) return keyCache.get(clean);
	const resolved = resolvePath(clean);
	const key = stripExt(resolved ?? clean).toLowerCase();
	keyCache.set(clean, key);
	return key;
}

const stripExt = (p) => String(p).replace(NOTE_FILE, '');

// ---- the scan --------------------------------------------------------------

let cache = null;

const FENCE_MASK = /^(```|~~~)[^\n]*$[\s\S]*?^\1\s*$/gm;
const INLINE_CODE = /`[^`\n]*`/g;
const mask = (text) => text
	.replace(FENCE_MASK, (m) => m.replace(/[^\n]/g, ' '))
	.replace(INLINE_CODE, (m) => ' '.repeat(m.length));

const WIKILINK = /(!?)\[\[([^\[\]|#\n]*)(?:#([^\[\]|\n]+))?(?:\|([^\[\]\n]+))?\]\]/g;
const BODY_TAG = /(^|[\s(,;])#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g;

function walk(root) {
	const files = [];
	const seen = new Set();
	const step = (dir, rel) => {
		let real;
		try { real = fs.realpathSync(dir); } catch { return; }
		if (seen.has(real)) return;      // symlink cycles — vaults may contain them
		seen.add(real);
		let entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (entry.name.startsWith('.') || IGNORED.has(entry.name)) continue;
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			const abs = path.join(dir, entry.name);
			let stat;
			try { stat = fs.statSync(abs); } catch { continue; }   // follows symlinks
			if (stat.isDirectory()) step(abs, childRel);
			else files.push({ abs, rel: childRel, stat });
		}
	};
	step(root, '');
	return files;
}

/**
 * Every note in the vault as a page object. Non-note files are indexed by
 * name only, so a link to an attachment still resolves.
 */
export function scanPages() {
	if (cache) return cache;
	const root = process.env.CLEW_VAULT_ROOT;
	if (!root) return (cache = { pages: [], byPath: new Map(), byName: new Map() });

	const pages = [];
	const files = walk(root);
	const byName = new Map();
	const addName = (key, rel) => {
		const k = key.toLowerCase();
		if (!byName.has(k)) byName.set(k, []);
		byName.get(k).push(rel);
	};

	for (const { abs, rel, stat } of files) {
		const base = rel.split('/').pop();
		addName(base, rel);                                  // with extension
		if (NOTE_FILE.test(base)) addName(base.replace(NOTE_FILE, ''), rel);

		// Non-note files are pages too, with the file namespace and nothing
		// else. Dataview indexes only Markdown and filters them back out;
		// Bases queries attachments on purpose (kepano's vault has a whole
		// base for unused ones), so the model has to carry them.
		if (!NOTE_FILE.test(base)) {
			pages.push({
				path: rel, name: base.replace(/\.[^.]+$/, ''),
				folder: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
				ext: base.slice(base.lastIndexOf('.') + 1),
				size: stat.size, ctime: stat.birthtimeMs || stat.ctimeMs, mtime: stat.mtimeMs,
				isNote: false, tags: [], aliases: [], fields: {}, sources: {}, text: '',
				rawLinks: [], rawEmbeds: [], tasks: [], outlinks: [], inlinks: [], embeds: [],
			});
			continue;
		}

		let text;
		try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
		// Fields are frontmatter only: `Key:: value` is a description list
		// in this dialect, not data (query-fences.js says why).
		const fm = readFrontmatter(text);
		const sources = {};
		for (const key of Object.keys(fm)) sources[key] = 'fm';

		const name = base.replace(NOTE_FILE, '');
		const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
		const masked = mask(text);

		const tags = new Set();
		const fmTags = Array.isArray(fm.tags) ? fm.tags : fm.tags ? [fm.tags] : [];
		for (const t of fmTags) if (String(t).trim()) tags.add('#' + String(t).replace(/^#/, ''));
		for (const [, , tag] of masked.matchAll(BODY_TAG)) tags.add('#' + tag.replace(/\/+$/, ''));

		const aliases = Array.isArray(fm.aliases) ? fm.aliases
			: fm.aliases ? [fm.aliases] : Array.isArray(fm.alias) ? fm.alias : fm.alias ? [fm.alias] : [];

		const references = [...masked.matchAll(WIKILINK)].map((m) => ({
			target: m[2].trim(), display: m[4]?.trim() ?? null, embed: m[1] === '!',
		}));
		pages.push({
			path: rel, name, folder, ext: base.slice(base.lastIndexOf('.') + 1),
			size: stat.size, ctime: stat.birthtimeMs || stat.ctimeMs, mtime: stat.mtimeMs,
			isNote: true,
			tags: [...tags], aliases: aliases.map(String),
			fields: { ...fm },
			sources, text,
			rawLinks: references.filter((r) => !r.embed),
			rawEmbeds: references.filter((r) => r.embed),
			tasks: extractTasks(text),
			outlinks: [], inlinks: [], embeds: [],
		});
	}

	const byPath = new Map(pages.map((p) => [p.path, p]));
	cache = { pages, byPath, byName };

	// The link graph, resolved once. Obsidian's rule: an explicit path wins,
	// otherwise the shortest matching path.
	for (const page of pages) {
		for (const raw of page.rawLinks) {
			if (!raw.target) continue;                       // [[#heading]] — same note
			const target = resolvePath(raw.target);
			if (!target) continue;
			page.outlinks.push(makeLink(target, raw.display));
			const to = byPath.get(target);
			if (to && to !== page) to.inlinks.push(makeLink(page.path));
		}
		// An embed is a link too — Obsidian counts `![[x]]` as a backlink, and
		// Bases queries `file.embeds` to find, say, a note's first image.
		for (const raw of page.rawEmbeds) {
			if (!raw.target) continue;
			const target = resolvePath(raw.target);
			if (!target) continue;
			page.embeds.push(makeLink(target, raw.display));
			page.outlinks.push(makeLink(target, raw.display));
			const to = byPath.get(target);
			if (to && to !== page) to.inlinks.push(makeLink(page.path));
		}
		delete page.rawLinks;
		delete page.rawEmbeds;
	}
	return cache;
}

/** A wikilink target → vault-relative path, or null. */
export function resolvePath(target) {
	const { byName, byPath } = scanPages();
	const clean = String(target).trim();
	if (!clean) return null;
	if (clean.includes('/')) {
		for (const candidate of [clean, `${clean}.md`, `${clean}.jmd`]) {
			if (byPath.has(candidate)) return candidate;
		}
		return null;
	}
	const matches = byName.get(clean.toLowerCase());
	if (!matches?.length) return null;
	return [...matches].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

/**
 * The note being rendered, as an absolute path — `global.current_file`,
 * which the engine sets for every build (index.js). A FRAGMENT build (a
 * canvas card, a live-edit block) renders a temp file under
 * `.clew/cache/fragments/`; when render-service knows which note the
 * fragment belongs to it leaves a `<key>.source` sidecar naming it, and that
 * note is the current file — so `this` in a live-edit block is the note it
 * sits in, exactly as in reading mode.
 */
export function currentFilePath() {
	const file = global.current_file;
	if (!file || file === '<stdin>') return null;
	const root = process.env.CLEW_VAULT_ROOT;
	if (root && path.dirname(file) === path.join(root, '.clew', 'cache', 'fragments')) {
		try {
			const rel = fs.readFileSync(file.replace(/\.md$/, '.source'), 'utf8').trim();
			if (rel) return path.join(root, rel);
		} catch { /* no sidecar: an anonymous fragment */ }
	}
	return file;
}

/** The page a `.base` view or a query is being rendered INSIDE, or null.
 *  `global.current_file` is set by the engine for every build (index.js), the
 *  same way `global.isLatex` is — which is what makes `this` cost nothing. */
export function currentPage() {
	const file = currentFilePath();
	if (!file) return null;
	const root = process.env.CLEW_VAULT_ROOT;
	if (!root) return null;
	const rel = path.relative(root, file).split(path.sep).join('/');
	return scanPages().byPath.get(rel) ?? null;
}

/** Reset the per-build caches. Tests only — a real worker builds once. */
export function resetCache() { cache = null; keyCache.clear(); }

// ---- the `file.*` namespace -------------------------------------------------

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Dataview's implicit fields for a page. */
export function fileFields(page) {
	return {
		name: page.name,
		folder: page.folder,
		path: page.path,
		ext: page.ext,
		link: makeLink(page.path, null),
		size: page.size,
		ctime: new Date(page.ctime),
		cday: iso(page.ctime),
		mtime: new Date(page.mtime),
		mday: iso(page.mtime),
		tags: page.tags,
		etags: page.tags,
		aliases: page.aliases,
		inlinks: page.inlinks,
		outlinks: page.outlinks,
		backlinks: page.inlinks,          // Bases' name for the same thing
		links: page.outlinks,
		embeds: page.embeds,
		tasks: page.tasks,
		day: page.fields.date ?? null,
		// `image: file.file` in a cards view means "the file itself".
		file: makeLink(page.path, page.name),
	};
}

/**
 * Resolve a bare field name against a page: user fields first (frontmatter,
 * then inline), then the file namespace, so a note may not accidentally
 * shadow `file` but may define anything else.
 */
export function pageValue(page, field) {
	if (field === 'file') return fileFields(page);
	if (field === 'this') return page;
	if (field in page.fields) return page.fields[field];
	return undefined;
}
