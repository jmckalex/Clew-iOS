// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// A note's OWN PDF frames — `<iframe src="paper.pdf">`, `<embed src>`,
// `<object data>` written in its HTML — rewritten, as the rendered note is
// served, to Clew's viewer page, so they get EmbedPDF exactly as
// `![[paper.pdf]]` does (docs/dev/pdf-unification.md §3). Pure and
// electron-free: protocol.js runs it over note documents, live-edit block
// documents and fragments; a site export never does (an exported page keeps
// the author's iframe, and the reader's browser shows the PDF).
//
// What counts: a target whose path ends `.pdf`, or any target the element
// marks `type="application/pdf"`. A VAULT target — relative to the note,
// vault-absolute (`/Papers/x.pdf`), or already a session path — is
// rewritten; `#page=N` becomes the viewer's `&page=N`; width, height, style,
// class and id are kept. A web target (http/https) is returned in `remote`,
// and — when the caller registers web PDFs (`registerRemote`, §4) — opens
// in the viewer too, READ-ONLY, from the hash its registration returns; the
// URL itself never reaches the page as something to fetch. Left alone: the
// engine's own `![[x.pdf]]`
// placeholder (`class="pdf-embed"`, which pdf-embed.js upgrades), a frame
// already on the viewer page, anything else, and a relative path that would
// climb out of the vault.

const VIEWER = '/__clew_assets__/clewpdf/pdf-page.html';
const TAG = /<(iframe|embed)\b([^>]*?)(\/?)>|<object\b([^>]*)>[\s\S]*?<\/object\s*>/gi;
const KEEP = ['width', 'height', 'style', 'class', 'id', 'title'];

/** The attributes of a tag's attribute text, lower-cased names. */
export function parseAttrs(text) {
	const attrs = {};
	const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
	let m;
	while ((m = re.exec(text ?? ''))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
	return attrs;
}

const escapeAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const unescapeEntities = (v) => String(v).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Split a target into its path (decoded) and its `#page=N`. */
function splitTarget(raw) {
	const hash = raw.indexOf('#');
	const beforeHash = hash >= 0 ? raw.slice(0, hash) : raw;
	const fragment = hash >= 0 ? raw.slice(hash + 1) : '';
	const query = beforeHash.indexOf('?');
	const path = query >= 0 ? beforeHash.slice(0, query) : beforeHash;
	const page = /(?:^|&)page=(\d+)/.exec(fragment)?.[1] ?? null;
	let decoded = path;
	try { decoded = decodeURIComponent(path); } catch { /* keep it */ }
	return { path: decoded, page: page ? Number(page) : null };
}

/** A vault-relative path for `target` from a note in `noteDir`, or null. */
export function vaultPathOf(target, { sid, noteDir = '' }) {
	const t = target.trim();
	if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !t.startsWith('clew-preview://vault/')) return null;   // another scheme
	if (t.startsWith('//')) return null;                                                       // protocol-relative: web
	let rest = t;
	if (rest.startsWith('clew-preview://vault/')) rest = rest.slice('clew-preview://vault'.length);
	const { path } = splitTarget(rest);
	let parts;
	if (path.startsWith(`/${sid}/`)) parts = path.slice(sid.length + 2).split('/');
	else if (path.startsWith('/')) parts = path.slice(1).split('/');
	else parts = [...(noteDir ? noteDir.split('/') : []), ...path.split('/')];
	const out = [];
	for (const seg of parts) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') { if (!out.length) return null; out.pop(); continue; }
		out.push(seg);
	}
	return out.length ? out.join('/') : null;
}

const isPdfTarget = (target, attrs) => /\.pdf$/i.test(splitTarget(target).path) || /^application\/pdf\b/i.test(attrs.type ?? '');

/** The viewer page's URL for a registered WEB PDF (§4): read-only. */
export function remoteViewerUrl(sid, hash, url, page = null) {
	const src = `/${sid}/__clew_remote_pdf__/${hash}`;
	return `${VIEWER}?src=${encodeURIComponent(src)}&readonly=1&origin=${encodeURIComponent(url)}${page ? `&page=${page}` : ''}`;
}

/** The viewer page's URL for a vault PDF. */
export function viewerUrl(sid, rel, page = null) {
	const src = `/${sid}/${rel.split('/').map(encodeURIComponent).join('/')}`;
	return `${VIEWER}?src=${encodeURIComponent(src)}${page ? `&page=${page}` : ''}`;
}

/**
 * Rewrite a document's (or a fragment's) PDF frames.
 *
 * @param {string} html
 * @param {{ sid: string, noteDir?: string, registerRemote?: (url: string) => string|null }} ctx -
 *   the session id; the note's folder, vault-relative; and, to open web PDFs
 *   in the viewer, the registration that returns a URL's hash (null: leave it)
 * @returns {{ html: string, rewritten: number, remote: string[] }}
 */
export function rewritePdfFrames(html, { sid, noteDir = '', registerRemote = null }) {
	let rewritten = 0;
	const remote = [];
	const out = String(html ?? '').replace(TAG, (whole, tagName, iAttrs, _selfClose, oAttrs) => {
		const isObject = tagName === undefined;
		const attrs = parseAttrs(isObject ? oAttrs : iAttrs);
		const raw = unescapeEntities(isObject ? attrs.data ?? '' : attrs.src ?? '');
		if (!raw) return whole;
		if (/\bpdf-embed\b/.test(attrs.class ?? '')) return whole;          // ![[x.pdf]]: pdf-embed.js upgrades it
		if (raw.includes('/__clew_assets__/clewpdf/')) return whole;         // already the viewer
		if (!isPdfTarget(raw, attrs)) return whole;
		const { page } = splitTarget(raw);
		const kept = KEEP.filter((k) => attrs[k] !== undefined)
			.map((k) => ` ${k}="${escapeAttr(attrs[k])}"`).join('');
		if (/^https?:/i.test(raw) || raw.startsWith('//')) {
			const url = (raw.startsWith('//') ? `https:${raw}` : raw).replace(/#.*$/, '');
			remote.push(url);
			const hash = registerRemote?.(url);
			if (!hash) return whole;
			rewritten += 1;
			return `<iframe${kept} src="${escapeAttr(remoteViewerUrl(sid, hash, url, page))}" allow="fullscreen" data-clew-remote-pdf="${escapeAttr(hash)}"></iframe>`;
		}
		const rel = vaultPathOf(raw, { sid, noteDir });
		if (!rel) return whole;
		rewritten += 1;
		return `<iframe${kept} src="${escapeAttr(viewerUrl(sid, rel, page))}" allow="fullscreen" data-clew-pdf="${escapeAttr(rel)}"></iframe>`;
	});
	return { html: out, rewritten, remote };
}
