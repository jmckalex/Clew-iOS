// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// `@reveal[…]` — a presentation, live and interactive, inside a note.
//
//     @reveal[http://localhost:8888/prez/teaching/ph341/voting-theory/]
//     @reveal[Talks/intro/index.html]{height=520px}
//     @reveal[Talks/intro]{width=80% aspect=4/3 style="margin: 2em auto"}
//
// One registry entry serves three call shapes — the engine's named
// environments give `@reveal[…]` (inline), `@reveal+[…]` (block) and
// `@begin(reveal)…@end(reveal)` from a single definition
// (vendor/jmarkdown/src/begin-end-core.js). Nothing here is reveal.js
// specific: it is an iframe with sensible defaults for slides, and it will
// hold any page. The name says what it is FOR.
//
// TWO kinds of target, because presentations live in two places:
//
//   • an http(s) URL — what a presentation built by a server gives you, and
//     the only thing that works for one that is generated rather than
//     static (the owner's own decks are index.php behind a local Apache: a
//     .php served out of the vault would be its SOURCE, not a deck).
//   • a vault-relative path to an HTML file, or to a folder holding an
//     index.html — a reveal export that lives with the notes. Those go
//     through sitePath(), so they carry the window's session id in the
//     preview and are relativized per page depth by a site export, exactly
//     as every other vault URL is (wikilinks.js).
//
// Anything else is refused BY NAME rather than embedded blindly: a path
// that is not there, a `.php` that needs a server, a `javascript:` URL.
//
// NOT sandboxed, deliberately, and for the reason the preview itself is
// not (CLAUDE.md): `sandbox="allow-scripts"` hands the frame an opaque
// origin, and a presentation immediately fetches its own assets — a deck
// served from the vault would fail on every one of them. The frame is
// already cross-origin from the app, popups are denied window-wide, and
// what it loads is a file the author named in their own note.
import fs from 'node:fs';
import path from 'node:path';
import { sitePath } from './wikilinks.js';

const escapeAttr = (s) => String(s)
	.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
	.replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeHtml = escapeAttr;

/** The index file a folder target means, in the order a web server would. */
const INDEX_FILES = ['index.html', 'index.htm'];

// A CSS unit the engine's attribute grammar hands back as its own
// attribute. attributes-parser reads `height=300px` as TWO attributes —
// `{ height: 300, px: 'px' }` — and `aspect=16:9` as `{ aspect: 16, ':9':
// ':9' }`, because an unquoted value ends at the first non-word character
// (measured 2026-09-25). The parser is the engine's, shared with every
// other directive, so the fix belongs here: glue the orphan back onto the
// value it was severed from. Quoted values — `height="300px"` — arrive
// whole and never take this path.
const ORPHAN_UNIT = /^(?:px|%|r?em|v[hw]|pt|pc|cm|mm|in|ch|ex|fr|deg|m?s|[:/]\d+(?:\.\d+)?)$/;

/** `{width=… height=…}` as a plain lowercase object (the figures.js idiom). */
export function attrsOf(ctx) {
	const out = {};
	const attrs = ctx?.attrs;
	if (!attrs) return out;
	const pairs = [];
	if (typeof attrs.forEach === 'function' && typeof attrs.get === 'function') {
		attrs.forEach((value, key) => pairs.push([String(key), value]));
	} else {
		for (const [key, value] of Object.entries(attrs)) {
			if (typeof value === 'function') continue;
			pairs.push([key, value]);
		}
	}
	let last = null;
	for (const [rawKey, rawValue] of pairs) {
		const key = rawKey.toLowerCase();
		const value = String(rawValue);
		// A severed unit: it arrives as a key whose value is itself, right
		// after the number it belongs to.
		if (last && value === rawKey && ORPHAN_UNIT.test(key)) {
			out[last] += key;
			continue;
		}
		out[key] = value;
		last = key;
	}
	return out;
}

/**
 * What the bracket content points at.
 *
 * @returns {{ src: string } | { refusal: string }}
 */
export function resolveTarget(target, root = process.env.CLEW_VAULT_ROOT) {
	const clean = String(target ?? '').trim();
	if (!clean) return { refusal: '@reveal needs a target: a URL, or a path inside the vault.' };

	// A URL, if it looks like one. http(s) only — `javascript:` in a note is
	// a script the author probably did not mean to run, and `file:` reaches
	// outside everything Clew serves.
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(clean);
	if (scheme) {
		if (/^https?$/i.test(scheme[1])) return { src: clean };
		return {
			refusal: `@reveal will not embed a ${scheme[1]}: URL — only http(s), `
				+ 'or a path to an HTML file inside the vault.',
		};
	}

	// A vault path. Without a vault root (the CLI, a test) there is nothing
	// to resolve against, so the path is passed through as written.
	const rel = clean.replace(/^\.?\//, '').replace(/\/+$/, '');
	if (rel.split('/').includes('..')) {
		return { refusal: `@reveal target "${clean}" climbs out of the vault.` };
	}
	if (!root) return { src: sitePath(rel) };

	const abs = path.join(root, rel);
	let stat = null;
	try { stat = fs.statSync(abs); } catch { /* not there */ }
	if (!stat) {
		return { refusal: `@reveal found nothing at "${rel}" in this vault.` };
	}
	if (stat.isDirectory()) {
		const index = INDEX_FILES.find((name) => fs.existsSync(path.join(abs, name)));
		if (index) return { src: sitePath(`${rel}/${index}`) };
		// The common near-miss, and worth naming precisely: a deck that is
		// generated (index.php) is a deck only once a server has run it.
		const php = fs.existsSync(path.join(abs, 'index.php'));
		return {
			refusal: php
				? `@reveal found index.php in "${rel}", which is a program rather than a page: `
					+ 'embed the URL your web server gives it instead.'
				: `@reveal found no index.html in "${rel}".`,
		};
	}
	if (/\.(php|cgi|jsp|asp|aspx)$/i.test(rel)) {
		return {
			refusal: `@reveal cannot embed "${rel}": it is a program rather than a page. `
				+ 'Embed the URL your web server gives it instead.',
		};
	}
	return { src: sitePath(rel) };
}

/**
 * The style the frame gets. `width`, `height` and `aspect` are the shape of
 * a slide deck and so are first-class; anything else goes through `style=`
 * verbatim, which keeps the door open without inventing a second CSS.
 *
 * Height and aspect are alternatives: give a height and it is used, give
 * neither and the frame keeps 16/9, which is what a deck wants and what
 * makes the embed reflow with the note's width instead of being a fixed box.
 */
export function frameStyle(attrs) {
	// A bare number is pixels — `width=800` is what someone writes first,
	// and a unitless CSS length is simply ignored by the browser.
	const px = (v) => (/^\d+(?:\.\d+)?$/.test(String(v).trim()) ? `${String(v).trim()}px` : String(v).trim());
	const parts = [];
	parts.push(`width: ${attrs.width ? px(attrs.width) : '100%'}`);
	if (attrs.height) parts.push(`height: ${px(attrs.height)}`);
	else parts.push(`aspect-ratio: ${(attrs.aspect || '16/9').replace(/:/g, '/')}`);
	if (attrs.style) parts.push(String(attrs.style).replace(/;\s*$/, ''));
	return parts.join('; ');
}

/** The refusal, shaped so it is legal where an inline directive sits. */
export function embedRefusal(message) {
	return `<span class="clew-embed-refused">${escapeHtml(message)}</span>`;
}

/**
 * The registry entry. `mode: 'custom'` means the handler owns its output —
 * the engine does not wrap it — and `html` is called for every one of the
 * three call shapes.
 */
export const reveal = {
	mode: 'custom',
	html(ctx) {
		const target = String(ctx?.rawText ?? ctx?.text ?? '').trim();
		const attrs = attrsOf(ctx);
		const resolved = resolveTarget(target);
		if (resolved.refusal) return embedRefusal(resolved.refusal);
		const classes = ['reveal-embed', ...(attrs.class ? [attrs.class] : [])];
		// `allow=fullscreen` is what lets a deck's own fullscreen control
		// work from inside the frame; `loading=lazy` keeps a note full of
		// decks from booting all of them at once.
		return `<iframe class="${escapeAttr(classes.join(' '))}"`
			+ ` src="${escapeAttr(resolved.src)}"`
			+ ` style="${escapeAttr(frameStyle(attrs))}"`
			+ ` title="${escapeAttr(attrs.title || 'Embedded presentation')}"`
			+ ' allow="fullscreen" loading="lazy"></iframe>';
	},
};
