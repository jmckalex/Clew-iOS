// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The update check's pure half (docs/dev/auto-update.md, v1: check and
// notify — the owner's answers of 2026-10-03). Clew asks the feed, compares
// versions, and says so; it downloads and installs nothing. Electron-free:
// main/updater.js does the fetching and the timing, tests/update-check.test.js
// holds this.

export const FEED_URL = 'https://clew-app.com/downloads/latest.json';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A version as [major, minor, patch, prerelease ids | null], or null. */
export function parseVersion(text) {
	const m = SEMVER.exec(String(text ?? '').trim());
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split('.') : null];
}

/** semver precedence: <0, 0 or >0. Unparseable versions compare equal. */
export function compareVersions(a, b) {
	const x = parseVersion(a);
	const y = parseVersion(b);
	if (!x || !y) return 0;
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
	// A release outranks its prereleases (0.12.1 > 0.12.1-dev.1).
	if (!x[3] && !y[3]) return 0;
	if (!x[3]) return 1;
	if (!y[3]) return -1;
	for (let i = 0; i < Math.max(x[3].length, y[3].length); i++) {
		const p = x[3][i];
		const q = y[3][i];
		if (p === undefined) return -1;
		if (q === undefined) return 1;
		const pn = /^\d+$/.test(p);
		const qn = /^\d+$/.test(q);
		if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
		if (pn !== qn) return pn ? -1 : 1;
		if (!pn && p !== q) return p < q ? -1 : 1;
	}
	return 0;
}

/** Which of the feed's files is THIS machine's (§4). */
export function platformKey({ platform = process.platform, arch = process.arch, appImage = process.env.APPIMAGE } = {}) {
	if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
	if (platform === 'win32') return 'win-x64';
	if (platform === 'linux') return appImage ? 'linux-appimage' : 'linux-deb';
	return null;
}

/**
 * The feed, checked: every URL resolved against the FEED's own URL and kept
 * only when it stays on the feed's origin (https; http only for a loopback
 * test feed) — a feed cannot send the user anywhere else.
 * @returns {{ version, released, notes, files: {key: {url, sha512, size}} } | null}
 */
export function readFeed(json, feedUrl) {
	if (!json || typeof json !== 'object') return null;
	if (!parseVersion(json.version)) return null;
	let base;
	try { base = new URL(feedUrl); } catch { return null; }
	const ok = (u) => u.origin === base.origin && (u.protocol === 'https:' || (u.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)));
	const resolve = (value) => {
		if (typeof value !== 'string' || !value) return null;
		try {
			const u = new URL(value, base);
			return ok(u) ? u.href : null;
		} catch {
			return null;
		}
	};
	const files = {};
	for (const [key, file] of Object.entries(json.files ?? {})) {
		const url = resolve(file?.url);
		if (url) files[key] = { url, sha512: typeof file.sha512 === 'string' ? file.sha512 : null, size: Number(file.size) || null };
	}
	return {
		version: String(json.version),
		released: typeof json.released === 'string' ? json.released : null,
		notes: resolve(json.notes),
		files,
	};
}

/**
 * What to tell the user. `manual` is Help → Check for Updates…, which always
 * answers and ignores a skipped version.
 * @returns {{ status: 'available'|'current'|'skipped', version, notes, download }}
 */
export function decide(feed, { current, skipped = null, manual = false, platform = {} }) {
	if (compareVersions(feed.version, current) <= 0) return { status: 'current', version: feed.version };
	if (!manual && skipped && compareVersions(feed.version, skipped) === 0) return { status: 'skipped', version: feed.version };
	const key = platformKey(platform);
	return {
		status: 'available',
		version: feed.version,
		released: feed.released,
		notes: feed.notes,
		download: (key && feed.files[key]?.url) ?? null,
	};
}
