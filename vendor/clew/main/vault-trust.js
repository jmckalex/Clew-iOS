// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Which vaults THIS DEVICE trusts to run their notes' code
// (docs/dev/frame-bridge.md §4.2, §4.3, §4.8).
//
// INTERIM GUARD (owner's approval, 2026-09-30). What trust decides here is
// ONE thing: whether the engine may run a note's code — script blocks,
// function calls in prose, math.…(, Mathematica, the Load …/Extension …
// header keys (the engine's `Run note code` switch, jmarkdown note-code.js).
// It does NOT yet cover vault scripts (.clew/scripts), vault plugins,
// dataviewJs, the Note API or a preview CSP: those arrive with the full §4,
// which extends THIS store and THIS identity rather than replacing them — so
// nothing trusted here is ever migrated again.
//
// The rules the full design fixed, kept here from the start:
//   - The record lives on the device (userData/vault-trust.json), never in
//     the vault: a vault that could say "trust me" would.
//   - A vault's identity is chosen by the device, never by the vault: the
//     root's realpath, plus a fingerprint (device, inode, birth time of the
//     root directory) checked on every open — a different vault unpacked at
//     a trusted vault's path is a different vault, and asks again. So does a
//     moved or renamed one, once.
//   - Every vault this device already knew when the guard arrived (open and
//     recent vaults) is recorded as trusted, once, silently: this device has
//     already run their code, and nothing should change for its owner.
//
// No electron here: main.js hands in the file path and the known-vault list,
// and tests/vault-trust.test.js runs it under plain node.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './fs-utils.js';

export const STORE_VERSION = 1;

/** The root directory's fingerprint, or null when it cannot be read. */
export function fingerprintOf(root) {
	try {
		const st = fs.statSync(root);
		return { dev: st.dev, ino: st.ino, birth: Math.round(st.birthtimeMs) };
	} catch {
		return null;
	}
}

/** The device-side key: the root's realpath (resolved when it is missing). */
export function identityKey(root) {
	try {
		return fs.realpathSync(root);
	} catch {
		return path.resolve(root);
	}
}

function sameFingerprint(a, b) {
	return a.dev === b.dev && a.ino === b.ino && a.birth === b.birth;
}

/**
 * @param {object} options
 * @param {string} options.file the store (userData/vault-trust.json)
 * @param {boolean} [options.persist] false under the smoke harness, which
 *   must never write the user's real userData (settings.js does the same)
 * @param {() => string} [options.now] clock, for the tests
 */
export function createTrustStore({ file, persist = true, now = () => new Date().toISOString() }) {
	let data = null;

	function load() {
		if (data) return data;
		try {
			data = JSON.parse(fs.readFileSync(file, 'utf8'));
			if (!data || typeof data !== 'object' || typeof data.vaults !== 'object') throw new Error('malformed');
		} catch (err) {
			// Missing: a first launch — migrate() fills it. Unreadable: start
			// empty AND call it migrated, so a damaged file can never re-trust
			// a vault its owner had revoked (restricted is the safe side).
			const missing = err?.code === 'ENOENT';
			if (!missing) console.warn(`clew: ${file} unreadable (${err.message}); every vault now asks again`);
			data = { version: STORE_VERSION, migratedAt: missing ? null : now(), vaults: {} };
		}
		return data;
	}

	function save() {
		if (!persist) return;
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			writeFileAtomic(file, JSON.stringify(data, null, '\t') + '\n');
		} catch (err) {
			console.warn(`clew: could not write ${file}: ${err.message}`);
		}
	}

	// The entry for `root`. One recorded while the vault was away (migrated
	// from an unplugged drive, say) sits under the path as the settings held
	// it, because a missing path has no realpath; the first sight of the
	// vault moves it to the realpath — only such an entry, one that has never
	// had a fingerprint to disagree with.
	function entryFor(root) {
		load();
		const key = identityKey(root);
		const plain = path.resolve(root);
		const early = data.vaults[plain];
		if (!data.vaults[key] && plain !== key && early && !early.fingerprint) {
			delete data.vaults[plain];
			data.vaults[key] = early;
		}
		return data.vaults[key] ?? null;
	}

	function record(root, trusted, source) {
		load();
		data.vaults[identityKey(root)] = { trusted, fingerprint: fingerprintOf(root), source, at: now() };
		save();
	}

	return {
		/**
		 * Once per device: every vault it already knows becomes trusted. A
		 * known vault that is not on disk right now (an unplugged drive) is
		 * recorded without a fingerprint, and takes the fingerprint it has
		 * when it is next opened.
		 * @param {string[]} knownVaults
		 * @returns {number} how many were recorded (0 once migrated)
		 */
		migrate(knownVaults) {
			load();
			if (data.migratedAt) return 0;
			let count = 0;
			for (const root of new Set(knownVaults.filter(Boolean))) {
				const key = identityKey(root);
				if (data.vaults[key]) continue;
				data.vaults[key] = { trusted: true, fingerprint: fingerprintOf(root), source: 'migrated', at: now() };
				count++;
			}
			data.migratedAt = now();
			save();
			return count;
		},

		/** Does this device trust the vault at `root`, as it is on disk now? */
		isTrusted(root) {
			const entry = entryFor(root);
			if (!entry?.trusted) return false;
			const current = fingerprintOf(root);
			if (!current) return false;
			if (!entry.fingerprint) {
				// Migrated while it was away: this is the first sight of it.
				entry.fingerprint = current;
				save();
				return true;
			}
			return sameFingerprint(entry.fingerprint, current);
		},

		/** The user said so (the banner, Settings), or Clew made the vault. */
		trust(root, source = 'user') { record(root, true, source); },

		revoke(root) { record(root, false, 'user'); },

		/** For the tests and a later Settings list: the raw records. */
		entries() { return structuredClone(load().vaults); },
	};
}
