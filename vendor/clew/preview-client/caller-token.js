// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// A preview document's side of the caller token (docs/dev/frame-bridge.md
// §1). The document is never SERVED the token — its HTML is read too widely
// to hold a secret — so it ASKS its parent, the first time it needs to POST
// to a render endpoint (a canvas scene's cards), and keeps the answer here,
// in this module's closure: not a global, not the DOM. A document that never
// POSTs never holds it.
//
// Two WebKit facts shape the ask (the iOS session's): an iframe moved in the
// DOM keeps a stale WindowProxy and postMessage then drops silently both
// ways, so an ask is repeated every RETRY_MS and gives up after TRIES — the
// POST fails rather than hanging — and a restored page (pageshow) asks again.
//
// And the document answers its OWN frames by the rule the app page uses
// (shared/caller-token.js#answersAsk) — a canvas scene's nested note cards
// — asking for itself first if it must, so the token passes only down a
// chain of Clew clients.
import { answersAsk, tokenFrom, PREVIEW_ORIGIN, TOKEN_MESSAGE } from '../shared/caller-token.js';

const RETRY_MS = 1000;
const TRIES = 5;

let token = null;
/** The ask in flight: { promise, resolve, reject, tries, timer }. */
let waiting = null;

// A content-free signal, so '*' stays (frame-bridge.md §2.8 step 2): the
// answer is what is addressed, to this document's origin only.
const ask = () => window.parent.postMessage({ source: 'clew-preview', type: TOKEN_MESSAGE }, '*');

function tick() {
	if (!waiting) return;
	if (waiting.tries >= TRIES) {
		const lost = waiting;
		waiting = null;
		lost.reject(new Error('no caller token: the host did not answer'));
		return;
	}
	waiting.tries += 1;
	ask();
	waiting.timer = setTimeout(tick, RETRY_MS);
}

/**
 * The token, asked for on first use. Rejects after TRIES unanswered asks;
 * the next call asks afresh.
 *
 * @returns {Promise<string>}
 */
export function callerToken() {
	if (token) return Promise.resolve(token);
	if (!waiting) {
		let resolve;
		let reject;
		const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
		waiting = { promise, resolve, reject, tries: 0, timer: null };
		tick();
	}
	return waiting.promise;
}

window.addEventListener('message', (event) => {
	const given = tokenFrom(event, window);
	if (given) {
		token = given;
		if (waiting) {
			clearTimeout(waiting.timer);
			waiting.resolve(given);
			waiting = null;
		}
		return;
	}
	if (answersAsk(event, window)) {
		const child = event.source;
		callerToken()
			.then((t) => child.postMessage({ source: 'clew-preview-host', type: TOKEN_MESSAGE, token: t }, PREVIEW_ORIGIN))
			.catch(() => { /* the child's own ask gives up in its turn */ });
	}
});

window.addEventListener('pageshow', () => { if (waiting) ask(); });
