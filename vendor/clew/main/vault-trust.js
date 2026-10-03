// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Which vaults THIS DEVICE trusts to run their code, and what each may run
// (docs/dev/frame-bridge.md §4.2, §4.3, §4.6, §4.8).
//
// Trust gates every path in §4.1: the engine's `Run note code` (script
// blocks, function calls in prose, math.…(, Mathematica, the Load …/
// Extension … header keys — jmarkdown note-code.js), vault scripts
// (.clew/scripts), vault plugins, dataviewJs, the Note API, a note's inline
// scripts (the preview CSP, protocol.js) and its network (§4.9). Since the
// full §4 (2026-10-02) each vault's ENABLEMENTS live here too: which plugins
// (vault AND global — §4.7), whether vault scripts, the Note API, dataviewJs
// and the network are on. The vault's own vault-settings.json keys of those
// names are only its REQUEST (§4.2): the prompt shows them, a yes copies
// them here, and nothing the vault writes later changes a grant.
//
// The rules the design fixed:
//   - The record lives on the device (userData/vault-trust.json), never in
//     the vault: a vault that could say "trust me" would.
//   - A vault's identity is chosen by the device, never by the vault: the
//     root's realpath, plus a fingerprint (device, inode, birth time of the
//     root directory) checked on every open — a different vault unpacked at
//     a trusted vault's path is a different vault, and asks again, with none
//     of the old one's enablements. So does a moved or renamed one, once.
//   - Every vault this device already knew when the guard arrived (open and
//     recent vaults, 2026-09-30) was recorded as trusted, once, silently:
//     this device had already run their code. Their enablements are copied
//     from their own vault-settings.json the first time the full §4 sees
//     them (#legacy below), with the network ON for a trusted one — nothing
//     changes for their owner (§4.8).
//   - Trust gates what is the VAULT'S code; a GLOBAL plugin is the user's
//     own, so its per-vault enable is honoured in a restricted vault too
//     (§4.7) — plugins.js is where vault scope is dropped when untrusted.
//
// No electron here: main.js hands in the file path and the known-vault list,
// and tests/vault-trust.test.js runs it under plain node.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './fs-utils.js';

export const STORE_VERSION = 2;

/** What a vault may ASK for, and the device may enable (§4.6). */
export const ENABLE_KEYS = ['scripts', 'plugins', 'noteApi', 'dataviewJs', 'network'];

/** An enablement record with nothing on. */
export const NOTHING_ENABLED = Object.freeze({ scripts: false, plugins: Object.freeze([]), noteApi: false, dataviewJs: false, network: false });

/**
 * A vault's request (its vault-settings.json, or what the user ticked) as an
 * enablement record: only the five keys, only well-formed values. Vault
 * scripts have no request key — a vault asks for them by HAVING them — so
 * they come from `scripts`, the caller's answer to "does it have any".
 */
export function normalizeEnable(raw = {}, { scripts = false } = {}) {
	const ids = Array.isArray(raw?.plugins) ? raw.plugins.filter((id) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) : [];
	return {
		scripts: raw?.scripts === undefined ? scripts === true : raw.scripts === true,
		plugins: [...new Set(ids)],
		noteApi: raw?.noteApi === true,
		dataviewJs: raw?.dataviewJs === true,
		network: raw?.network === true,
	};
}

/**
 * What may run, given the device's record: trust gates the vault's own code
 * (scripts, the Note API, dataviewJs, the network, vault plugins); the
 * plugin ids stay as enabled, because which of them may load (a global one
 * always, a vault one only when trusted) is decided where plugins are
 * listed (plugins.js#enabledPlugins, which takes `trusted`).
 */
export function effectiveAccess(trusted, enable) {
	const e = enable ?? NOTHING_ENABLED;
	return {
		trusted: trusted === true,
		scripts: trusted === true && e.scripts === true,
		plugins: [...(e.plugins ?? [])],
		noteApi: trusted === true && e.noteApi === true,
		dataviewJs: trusted === true && e.dataviewJs === true,
		network: trusted === true && e.network === true,
	};
}

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

	// Is the entry about THIS vault — the one on disk now? A missing
	// fingerprint (migrated while away) is taken from the first sight.
	function current(entry, root) {
		if (!entry) return false;
		const fp = fingerprintOf(root);
		if (!fp) return false;
		if (!entry.fingerprint) {
			entry.fingerprint = fp;
			save();
			return true;
		}
		return sameFingerprint(entry.fingerprint, fp);
	}

	// An entry made before enablements lived here (the interim guard, store
	// version 1): this device ran whatever its vault-settings.json enabled,
	// so that is copied, once — the network on for a trusted vault, which
	// had it — and the decision counts as made (§4.8).
	function legacy(entry, root, readRequests) {
		if (entry.enable) return;
		let requests = null;
		try { requests = readRequests?.(root) ?? null; } catch { requests = null; }
		if (!requests) return;   // not readable now: try again next sight
		entry.enable = normalizeEnable(requests.enable, { scripts: true });
		// It had the network whatever it asked for: no CSP existed.
		if (entry.trusted === true) entry.enable.network = true;
		entry.decided = true;
		save();
	}

	function record(root, trusted, source, enable) {
		load();
		const key = identityKey(root);
		const old = data.vaults[key];
		// A new vault at a known path keeps nothing of the old one.
		const keep = old && current(old, root) ? old.enable : null;
		data.vaults[key] = {
			trusted, decided: true, fingerprint: fingerprintOf(root), source, at: now(),
			enable: enable ? normalizeEnable(enable, { scripts: true }) : (keep ?? normalizeEnable({}, { scripts: true })),
		};
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
			return entry?.trusted === true && current(entry, root);
		},

		/**
		 * What the vault at `root` may run on this device, plus whether the
		 * device has DECIDED about it (a vault never decided gets the prompt).
		 * `readRequests(root)` → `{ enable }`, the vault's own request (its
		 * vault-settings.json): read only to fill a legacy entry, never as a
		 * grant.
		 */
		accessFor(root, readRequests = null) {
			const entry = entryFor(root);
			if (!entry || !current(entry, root)) return { ...effectiveAccess(false, null), decided: false };
			legacy(entry, root, readRequests);
			return { ...effectiveAccess(entry.trusted === true, entry.enable), decided: entry.decided !== false };
		},

		/** The device's enablement record for `root` (not gated by trust). */
		enablements(root) {
			const entry = entryFor(root);
			return entry && current(entry, root) && entry.enable ? structuredClone(entry.enable) : normalizeEnable({}, { scripts: true });
		},

		/**
		 * The user said so (the prompt, Settings), or Clew made the vault.
		 * `enable` (optional) replaces the vault's enablements — the prompt's
		 * yes passes the vault's request — else they are kept.
		 */
		trust(root, source = 'user', enable = null) { record(root, true, source, enable); },

		/** Restricted, as the user's decision (Keep restricted, Revoke):
		 *  enablements are kept, for a later trust. */
		revoke(root) { record(root, false, 'user'); },

		/** One enablement changed in Settings → This vault. A vault never
		 *  decided about stays undecided: switching on a global plugin for it
		 *  is not an answer to the trust prompt. */
		setEnable(root, patch) {
			load();
			const key = identityKey(root);
			let entry = data.vaults[key];
			if (!entry || !current(entry, root)) {
				entry = data.vaults[key] = { trusted: false, decided: false, fingerprint: fingerprintOf(root), source: 'user', at: now(), enable: normalizeEnable({}, { scripts: true }) };
			}
			entry.enable = normalizeEnable({ ...(entry.enable ?? {}), ...patch }, { scripts: true });
			save();
			return structuredClone(entry.enable);
		},

		/** Forget the vault entirely (Settings → Trusted vaults): its next
		 *  open is a first open. */
		forget(root) {
			load();
			delete data.vaults[identityKey(root)];
			delete data.vaults[path.resolve(root)];
			save();
		},

		/** Forget by the stored key itself (a vault no longer on disk). */
		forgetKey(key) {
			load();
			delete data.vaults[key];
			save();
		},

		/**
		 * True ONCE, for a store that predates the full §4 (version 1): the
		 * one-time notice says what changed. A fresh store never shows it.
		 */
		takeNotice() {
			load();
			if ((data.version ?? 1) >= STORE_VERSION) return false;
			data.version = STORE_VERSION;
			save();
			return true;
		},

		/** For the tests and Settings → Trusted vaults: the raw records. */
		entries() { return structuredClone(load().vaults); },
	};
}
