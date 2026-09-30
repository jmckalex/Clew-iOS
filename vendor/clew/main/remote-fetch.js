// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The remote-PDF fetcher (docs/dev/pdf-unification.md §4): Clew fetches a
// web PDF a note's frame names — the page cannot, across origins — and so
// Clew fetches CAREFULLY:
//
//   - http(s) only, GET only; no cookies, no Authorization, no Referer; a
//     plain `User-Agent: Clew/<version>`.
//   - Every address the host resolves to is vetted (remote-guard.js) and
//     the connection is PINNED to a vetted one, so no second DNS answer
//     slips in between check and connect. Every redirect is re-vetted the
//     same way, at most five.
//   - 10 s to connect, 20 s to the headers, 120 s in all.
//   - 200 (or 304 to a conditional request), a PDF or generic binary
//     Content-Type — an HTML answer is named as such, the usual sign of a
//     login page — `%PDF-` within the first 1024 bytes, and the size cap
//     COUNTED while streaming, never trusted from Content-Length.
//
// Node's own http/https, not Electron's `net`: `net` shares the default
// session's cookies and cannot pin an address. The resolver and the
// transport are passed in, which is how tests/remote-fetch.test.js drives
// every rule with no network at all; the real ones are the defaults.
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { vetAddresses } from './remote-guard.js';

/** A fetch refused or failed, by name — the viewer shows `code`'s wording. */
export class RemoteError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

export const LIMITS = {
	maxBytes: 100 * 1024 * 1024,
	maxRedirects: 5,
	connectMs: 10_000,
	headersMs: 20_000,
	totalMs: 120_000,
};

const PDF_TYPES = /^(application\/(pdf|x-pdf|octet-stream|binary|force-download|download|x-download)|binary\/octet-stream)\b/i;

/** Every address `host` resolves to (the real resolver). */
export async function systemResolve(host) {
	return dns.lookup(host, { all: true, verbatim: true });
}

/**
 * The real transport: one GET to `url`, connected to `address` whatever the
 * name resolves to now (a pinned `lookup`), TLS still verified against the
 * URL's own host name. Resolves when the headers arrive, to
 * { status, headers, body: AsyncIterable<Buffer> }.
 */
export function nodeTransport({ url, address, family, headers, signal, connectMs }) {
	const lib = url.protocol === 'https:' ? https : http;
	return new Promise((resolve, reject) => {
		const req = lib.request(url, {
			method: 'GET',
			headers,
			signal,
			agent: false,    // no pooled socket from a request that resolved elsewhere
			lookup: (_host, options, callback) => {
				if (options?.all) callback(null, [{ address, family }]);
				else callback(null, address, family);
			},
		}, (res) => resolve({ status: res.statusCode, headers: res.headers, body: res }));
		const connectTimer = setTimeout(() => req.destroy(new RemoteError('connect-timeout', `no connection to ${url.host} within ${connectMs / 1000} s`)), connectMs);
		req.on('socket', (socket) => {
			const done = () => clearTimeout(connectTimer);
			socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', done);
			socket.once('close', done);
		});
		req.on('error', (err) => { clearTimeout(connectTimer); reject(err); });
		req.end();
	});
}

function checkUrl(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new RemoteError('bad-url', `not a URL: ${raw}`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RemoteError('bad-url', `only http and https are fetched, not ${url.protocol}`);
	if (url.username || url.password) throw new RemoteError('bad-url', 'a URL carrying credentials is not fetched');
	url.hash = '';
	return url;
}

/**
 * Fetch the PDF at `raw`.
 * @param {string} raw
 * @param {object} [options]
 * @param {(host: string) => Promise<{address: string, family: number}[]>} [options.resolve]
 * @param {Function} [options.transport] as nodeTransport
 * @param {string} [options.userAgent]
 * @param {{ etag?: string, lastModified?: string }} [options.validators] a
 *   cached copy's, for a conditional request
 * @param {Partial<typeof LIMITS>} [options.limits]
 * @returns {Promise<{ notModified: true, url: string } | { notModified: false,
 *   bytes: Buffer, url: string, etag: string|null, lastModified: string|null }>}
 *   `url` is where it finally came from, after any redirects
 */
export async function fetchRemotePdf(raw, {
	resolve = systemResolve, transport = nodeTransport, userAgent = 'Clew',
	validators = null, limits = {},
} = {}) {
	const lim = { ...LIMITS, ...limits };
	const controller = new AbortController();
	const total = setTimeout(() => controller.abort(new RemoteError('timeout', `the download took longer than ${lim.totalMs / 1000} s`)), lim.totalMs);
	try {
		let url = checkUrl(raw);
		for (let hop = 0; ; hop++) {
			const host = url.hostname.replace(/^\[|\]$/g, '');
			let answers;
			try {
				answers = await resolve(host);
			} catch (err) {
				throw err instanceof RemoteError ? err : new RemoteError('dns', `${host} could not be resolved (${err.code ?? err.message})`);
			}
			const pinned = vetAddresses(host, answers, RemoteError);
			const headers = { 'User-Agent': userAgent, Accept: 'application/pdf,*/*;q=0.5' };
			if (hop === 0 && validators?.etag) headers['If-None-Match'] = validators.etag;
			if (hop === 0 && validators?.lastModified) headers['If-Modified-Since'] = validators.lastModified;

			const headersTimer = setTimeout(() => controller.abort(new RemoteError('headers-timeout', `${url.host} sent no answer within ${lim.headersMs / 1000} s`)), lim.headersMs);
			let res;
			try {
				res = await abortable(
					transport({ url, address: pinned.address, family: pinned.family, headers, signal: controller.signal, connectMs: lim.connectMs }),
					controller.signal);
			} catch (err) {
				throw asRemote(err, controller, url);
			} finally {
				clearTimeout(headersTimer);
			}

			if ([301, 302, 303, 307, 308].includes(res.status)) {
				drain(res.body);
				const location = res.headers.location;
				if (!location) throw new RemoteError('http-status', `${url.host} redirected without saying where`);
				if (hop + 1 > lim.maxRedirects) throw new RemoteError('too-many-redirects', `more than ${lim.maxRedirects} redirects`);
				url = checkUrl(new URL(location, url).href);
				continue;
			}
			if (res.status === 304 && validators) {
				drain(res.body);
				return { notModified: true, url: url.href };
			}
			if (res.status !== 200) {
				drain(res.body);
				throw new RemoteError('http-status', `${url.host} answered ${res.status}`);
			}
			const type = String(res.headers['content-type'] ?? '').trim();
			if (/^text\/html|^application\/xhtml/i.test(type)) {
				drain(res.body);
				throw new RemoteError('web-page', 'the site answered with a web page, not a PDF — it may need you to sign in');
			}
			if (type && !PDF_TYPES.test(type)) {
				drain(res.body);
				throw new RemoteError('not-pdf', `the site answered with ${type.split(';')[0]}, not a PDF`);
			}
			const bytes = await readCapped(res.body, lim.maxBytes, controller, url);
			const head = bytes.subarray(0, 1024).toString('latin1');
			if (!head.includes('%PDF-')) throw new RemoteError('not-pdf', 'what came back is not a PDF');
			return {
				notModified: false,
				bytes,
				url: url.href,
				etag: res.headers.etag ?? null,
				lastModified: res.headers['last-modified'] ?? null,
			};
		}
	} finally {
		clearTimeout(total);
	}
}

function asRemote(err, controller, url) {
	if (err instanceof RemoteError) return err;
	if (controller.signal.aborted && controller.signal.reason instanceof RemoteError) return controller.signal.reason;
	return new RemoteError('network', `could not reach ${url.host} (${err.code ?? err.message})`);
}

// The timeouts must not depend on the transport honouring the signal: a
// socket that neither answers nor errors would otherwise hold the fetch
// forever. So every wait is raced against the abort.
function abortable(promise, signal) {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
			(err) => { signal.removeEventListener('abort', onAbort); reject(err); });
	});
}

function drain(body) {
	try { body?.destroy?.(); } catch { /* already gone */ }
}

async function readCapped(body, maxBytes, controller, url) {
	const chunks = [];
	let size = 0;
	const it = body[Symbol.asyncIterator]();
	try {
		for (;;) {
			const { value: chunk, done } = await abortable(it.next(), controller.signal);
			if (done) break;
			size += chunk.length;
			if (size > maxBytes) {
				throw new RemoteError('too-large', `larger than the ${Math.round(maxBytes / 1024 / 1024)} MB a web PDF may be`);
			}
			chunks.push(chunk);
		}
	} catch (err) {
		drain(body);
		it.return?.().catch?.(() => {});
		throw asRemote(err, controller, url);
	}
	return Buffer.concat(chunks);
}
