// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Web PDFs a note's own frames name (docs/dev/pdf-unification.md §4), wired
// to the app: REGISTRATION, not a proxy. A render that meets
// `<iframe src="https://…/x.pdf">` registers the URL for its session
// (protocol.js#wrapPreviewDocument → pdf-frames-rewrite.js) and the frame
// becomes the read-only viewer on `__clew_remote_pdf__/<sha256(url)>`; that
// route serves a hash THIS session's renders registered and nothing else, so
// no page, script or frame can name a URL for Clew to fetch. The fetch
// itself is remote-fetch.js (the address guard, no credentials), the copy
// remote-pdf-cache.js (on the device, never in a vault).
import { app } from 'electron';
import fs from 'node:fs';
import { paths } from './paths.js';
import { fetchRemotePdf } from './remote-fetch.js';
import { createRemotePdfCache, remoteKey } from './remote-pdf-cache.js';

let cache = null;
function theCache() {
	cache ??= createRemotePdfCache({
		dir: paths.remotePdfs,
		fetchPdf: (url, options) => fetchRemotePdf(url, { ...options, userAgent: `Clew/${app.getVersion()}` }),
	});
	return cache;
}

/** Register `url` for `session` — its hash is what a render may serve — and
 *  start fetching it now, so the viewer usually finds it waiting. */
export function registerRemotePdf(session, url) {
	const key = remoteKey(url);
	session.remotePdfs.set(key, url);
	theCache().get(url).catch(() => { /* the route reports it, by name */ });
	return key;
}

/** The URL behind a hash this session registered, or null. */
export function registeredRemoteUrl(session, key) {
	return session.remotePdfs.get(key) ?? null;
}

/** { file, meta, error? } for a registered hash; null if not registered;
 *  throws the fetch's RemoteError when there is no copy at all. */
export async function remotePdfFile(session, key, { reload = false } = {}) {
	const url = registeredRemoteUrl(session, key);
	if (!url) return null;
	return theCache().get(url, { reload });
}

/** A name for a saved copy, from the URL's last segment: `paper.pdf`. */
export function copyNameFor(url) {
	let base = 'web.pdf';
	try {
		base = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? base);
	} catch { /* keep the default */ }
	base = base.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-').slice(0, 120) || 'web.pdf';
	return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

/** "Save a copy to the vault": the cached bytes into the attachment folder,
 *  never overwriting (saveAttachment de-duplicates the name). */
export function saveRemoteCopy(session, key, folder) {
	const url = registeredRemoteUrl(session, key);
	if (!url) throw new Error('That web PDF is not open in this window');
	const file = theCache().fileOf(key);
	if (!file || !fs.existsSync(file)) throw new Error('That web PDF has not been fetched yet');
	return session.vaults.saveAttachment(copyNameFor(url), fs.readFileSync(file), folder);
}

