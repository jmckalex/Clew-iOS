// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Web PDFs, cached ON THE DEVICE (docs/dev/pdf-unification.md §4): never in
// the vault, whose `.clew/` travels (iCloud, a zip, git) — a shared vault
// could otherwise arrive with a planted copy served as that URL's bytes,
// around the whole fetch guard. One directory for the device, keyed by
// sha256(URL) alone, shared by every vault (a URL's bytes are the same
// whoever names it): `<key>.pdf` plus `<key>.json` (URL, when fetched and
// last checked, ETag, Last-Modified, size, last used).
//
// A cached copy is served at once and REVALIDATED — a conditional GET, in
// the background — at most once a day, when a note naming it asks. `reload`
// refetches now; if that fails and a copy exists, the copy is served with
// the failure attached ("a saved copy from <date>"). Least recently used
// copies go first past the cap (1 GB).
//
// Electron-free: the fetcher is passed in (remote-fetch.js by default), so
// tests/remote-pdf-cache.test.js runs it all under plain node.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './fs-utils.js';

export const CACHE_LIMITS = {
	maxTotalBytes: 1024 * 1024 * 1024,
	revalidateMs: 24 * 60 * 60 * 1000,
};

/** The device-wide key for a URL: sha256 of the URL alone. */
export function remoteKey(url) {
	return crypto.createHash('sha256').update(String(url)).digest('hex');
}

/**
 * @param {object} options
 * @param {string} options.dir the cache directory (userData/remote-pdfs)
 * @param {(url: string, opts: object) => Promise<object>} options.fetchPdf remote-fetch.js#fetchRemotePdf
 * @param {() => number} [options.now]
 * @param {Partial<typeof CACHE_LIMITS>} [options.limits]
 */
export function createRemotePdfCache({ dir, fetchPdf, now = Date.now, limits = {} }) {
	const lim = { ...CACHE_LIMITS, ...limits };
	const inflight = new Map();

	const files = (key) => ({ pdf: path.join(dir, `${key}.pdf`), meta: path.join(dir, `${key}.json`) });

	function readMeta(key) {
		try {
			const meta = JSON.parse(fs.readFileSync(files(key).meta, 'utf8'));
			return fs.existsSync(files(key).pdf) ? meta : null;
		} catch {
			return null;
		}
	}

	function writeMeta(key, meta) {
		writeFileAtomic(files(key).meta, JSON.stringify(meta, null, '\t') + '\n');
	}

	/** Least recently used out, until the whole cache is under the cap. */
	function evict(keep) {
		let entries;
		try {
			entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
				const key = f.slice(0, -5);
				const meta = readMeta(key);
				return meta ? { key, size: meta.size ?? 0, lastUsed: meta.lastUsed ?? 0 } : null;
			}).filter(Boolean);
		} catch {
			return;
		}
		let total = entries.reduce((sum, e) => sum + e.size, 0);
		for (const e of entries.sort((a, b) => a.lastUsed - b.lastUsed)) {
			if (total <= lim.maxTotalBytes) break;
			if (e.key === keep) continue;
			fs.rmSync(files(e.key).pdf, { force: true });
			fs.rmSync(files(e.key).meta, { force: true });
			total -= e.size;
		}
	}

	/** One network trip per key at a time; stores what came back. */
	function refresh(url, key, meta) {
		if (inflight.has(key)) return inflight.get(key);
		const job = (async () => {
			const got = await fetchPdf(url, { validators: meta ? { etag: meta.etag, lastModified: meta.lastModified } : null });
			fs.mkdirSync(dir, { recursive: true });
			const t = now();
			if (got.notModified) {
				const next = { ...meta, checkedAt: t };
				writeMeta(key, next);
				return next;
			}
			writeFileAtomic(files(key).pdf, got.bytes);
			const next = {
				url, finalUrl: got.url, fetchedAt: t, checkedAt: t, lastUsed: t,
				etag: got.etag, lastModified: got.lastModified, size: got.bytes.length,
			};
			writeMeta(key, next);
			evict(key);
			return next;
		})().finally(() => inflight.delete(key));
		inflight.set(key, job);
		return job;
	}

	return {
		/**
		 * The file for `url`: { file, meta, key, error? }. Throws the fetch's
		 * RemoteError when there is no copy to fall back on.
		 */
		async get(url, { reload = false } = {}) {
			const key = remoteKey(url);
			let meta = readMeta(key);
			if (meta && !reload) {
				meta = { ...meta, lastUsed: now() };
				writeMeta(key, meta);
				if (now() - (meta.checkedAt ?? 0) > lim.revalidateMs) refresh(url, key, meta).catch(() => {});
				return { file: files(key).pdf, meta, key };
			}
			try {
				const fresh = await refresh(url, key, reload ? meta : null);
				return { file: files(key).pdf, meta: fresh, key };
			} catch (error) {
				if (meta) return { file: files(key).pdf, meta, key, error };
				throw error;
			}
		},

		/** The cached file for a key, if any (Save a copy reads it). */
		fileOf(key) {
			return readMeta(key) ? files(key).pdf : null;
		},

		evict: () => evict(null),
	};
}
