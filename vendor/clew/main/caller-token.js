// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The caller token, server side (docs/dev/frame-bridge.md §1). The render
// endpoints (`__clew_fragment__`, `__clew_block__`) run the engine on the
// text a caller posts, and no request header tells a legitimate caller from
// any other document that can reach the scheme — the handler sees no Origin
// at all (measured 2026-09-29). So each session holds a secret, hands it only
// to its own window, and runs nothing for a body that does not carry it.
//
// Electron-free, so the check is unit-tested under plain node.
import crypto from 'node:crypto';

/** A render POST's body, whole (the text, its note's path, the token). */
export const RENDER_BODY_LIMIT = 100_000;

/** 32 random bytes, hex: memory only — never persisted, logged or in a URL. */
export function newCallerToken() {
	return crypto.randomBytes(32).toString('hex');
}

/** Constant-time: a wrong token takes as long to refuse as a nearly right one. */
export function tokenMatches(expected, given) {
	if (typeof expected !== 'string' || !expected || typeof given !== 'string') return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(given);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * A render POST's body, checked before the engine sees any of it:
 * `{ text, sourcePath, book }`, or `{ status, message }` to refuse with. The
 * body is JSON `{ token, text, sourcePath?, book? }` whatever its Content-Type — callers
 * send none (fetch's text/plain), because a JSON type makes the request
 * non-simple, and a preflight is an OPTIONS request the iOS handler does not
 * answer.
 *
 * @param {string} body
 * @param {string|null} expected - the session's token
 */
/** The most pieces a book's citation context may name. */
const BOOK_LIMIT = 2000;

export function readRenderBody(body, expected) {
	if (typeof body !== 'string' || body.length > RENDER_BODY_LIMIT) return { status: 413, message: 'Too large' };
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { status: 400, message: 'Bad request' };
	}
	if (!parsed || typeof parsed !== 'object') return { status: 400, message: 'Bad request' };
	if (!tokenMatches(expected, parsed.token)) return { status: 403, message: 'Forbidden' };
	const { text, sourcePath = null, book = null } = parsed;
	if (typeof text !== 'string') return { status: 400, message: 'Bad request' };
	if (sourcePath !== null && typeof sourcePath !== 'string') return { status: 400, message: 'Bad request' };
	// A chapter's citations render under its book's header (cite-text.js):
	// the master then the chapters, vault paths the route resolves in turn.
	if (book !== null && !(Array.isArray(book) && book.length <= BOOK_LIMIT && book.every((p) => typeof p === 'string'))) {
		return { status: 400, message: 'Bad request' };
	}
	return { text, sourcePath, book };
}
