// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// An app's SECRETS on this device (docs/dev/frame-bridge.md §9c; the owner,
// 2026-10-06: the Stock Ticker's Finnhub key "stored securely on the iPad",
// and on the desktop for parity): small strings an app keeps by name. Never
// in the vault — `app.kv` is clewdata.json, which travels with it — and
// encrypted at rest by a key the OS holds: Electron safeStorage here (the
// Keychain on macOS, DPAPI on Windows, a real keyring on Linux); Clew-iOS
// keeps them in the Keychain itself.
//
// Kept by vault identity → app id → name, so Revoke forgets one app's and
// Forget (Settings → Trusted vaults) every app's in a vault. The grant
// (`app.secrets`) and the limits are app-calls.js's, shared with Clew-iOS;
// this file only stores. A VALUE never reaches a log, an error message or
// any file but this one, and here only as ciphertext.
//
// Electron-free, so its tests run under plain node: the caller hands in the
// cipher — `{ available(), encrypt(string) → Buffer, decrypt(Buffer) →
// string }`, or null for none — and `persist: false` (smoke runs) keeps
// everything in memory.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './fs-utils.js';

/** An error the app is told about by code (app-calls.js#appError's shape). */
function storeError(code, message) {
	const err = new Error(message);
	err.code = code;
	return err;
}

export function createSecretStore({ file, cipher, persist = true }) {
	let data = null;
	const load = () => {
		if (data) return data;
		try {
			data = JSON.parse(fs.readFileSync(file, 'utf8'));
			if (!data || typeof data.vaults !== 'object' || !data.vaults) throw new Error('malformed');
		} catch {
			data = { version: 1, vaults: {} };
		}
		return data;
	};
	const save = () => {
		if (!persist) return;
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			writeFileAtomic(file, JSON.stringify(data, null, '\t') + '\n');
			// The owner's alone. writeFileAtomic keeps a file's mode from
			// then on.
			fs.chmodSync(file, 0o600);
		} catch (err) {
			console.warn(`clew: could not write ${path.basename(file)}: ${err.code ?? 'error'}`);
		}
	};
	const entry = (vault, id, create = false) => {
		load();
		const apps = data.vaults[vault] ?? (create ? (data.vaults[vault] = {}) : null);
		if (!apps) return null;
		return apps[id] ?? (create ? (apps[id] = {}) : null);
	};
	/** Drop an app with no secrets left, and a vault with no apps. */
	const tidy = (vault, id) => {
		const apps = data.vaults[vault];
		if (apps?.[id] && !Object.keys(apps[id]).length) delete apps[id];
		if (apps && !Object.keys(apps).length) delete data.vaults[vault];
	};
	const usable = () => {
		try { return Boolean(cipher?.available()); } catch { return false; }
	};

	return {
		/**
		 * The store ONE app sees — vault identity × manifest id, bound by the
		 * host from the port, never from the app's message: what app-calls.js
		 * gets as `ctx.secrets`.
		 */
		scoped(vault, id) {
			return {
				/** The value, or null — also for one this device cannot decrypt
				 *  (another build's key: dev and packaged share a profile). */
				get(name) {
					const sealed = entry(vault, id)?.[name];
					if (typeof sealed !== 'string' || !usable()) return null;
					try { return cipher.decrypt(Buffer.from(sealed, 'base64')); } catch { return null; }
				},
				set(name, value) {
					if (!usable()) throw storeError('unavailable', 'this device has no secure storage for secrets');
					entry(vault, id, true)[name] = cipher.encrypt(value).toString('base64');
					save();
					return true;
				},
				/** Whether there was one. */
				delete(name) {
					const e = entry(vault, id);
					if (!e || !Object.hasOwn(e, name)) return false;
					delete e[name];
					tidy(vault, id);
					save();
					return true;
				},
				names() {
					return Object.keys(entry(vault, id) ?? {});
				},
			};
		},

		/** How many secrets an app keeps here (Settings → Apps). */
		count(vault, id) {
			return Object.keys(entry(vault, id) ?? {}).length;
		},

		/** Revoke: the app's secrets go with its grants. */
		clearApp(vault, id) {
			const apps = entry(vault, id) ? data.vaults[vault] : null;
			if (!apps) return false;
			delete apps[id];
			tidy(vault, id);
			save();
			return true;
		},

		/** Forget a vault: every app's secrets in it. */
		clearVault(vault) {
			load();
			if (!data.vaults[vault]) return false;
			delete data.vaults[vault];
			save();
			return true;
		},
	};
}
