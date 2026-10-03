// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What this device has let each app do (docs/dev/frame-bridge.md §9, R1,
// R3, choice C): userData/app-grants.json, keyed by the device-side vault
// identity (vault-trust.js#identityKey) and the manifest id — never stored
// in the vault, so a vault sent to someone arrives with no grants. Per app:
//
//   granted  { capability: when }   asked once each; a manifest asking for
//   denied   { capability: when }   more later asks for the new ones only
//   run      when | null            a RESTRICTED vault's app runs only after
//   runDenied when | null           its prompt (R1, choice B)
//   code     sha256 | null          choice C: a restricted vault's app that
//                                   holds `network` is pinned to the code
//                                   approved; new code asks again
//   folder   where it was granted (shown in Settings, never part of the key)
//
// Electron-free (main/app-registry.js holds the one instance);
// tests/app-grants.test.js.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './fs-utils.js';

export function createGrantStore({ file, persist = true, now = () => new Date().toISOString() }) {
	let data = null;
	const load = () => {
		if (data) return data;
		try {
			data = JSON.parse(fs.readFileSync(file, 'utf8'));
			if (!data || typeof data.apps !== 'object') throw new Error('malformed');
		} catch {
			data = { version: 1, apps: {} };
		}
		return data;
	};
	const save = () => {
		if (!persist) return;
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			writeFileAtomic(file, JSON.stringify(data, null, '\t') + '\n');
		} catch (err) {
			console.warn(`clew: could not write ${file}: ${err.message}`);
		}
	};
	const entry = (vault, id, create = false) => {
		load();
		const apps = data.apps[vault] ?? (create ? (data.apps[vault] = {}) : null);
		if (!apps) return null;
		return apps[id] ?? (create ? (apps[id] = { granted: {}, denied: {}, run: null, runDenied: null, code: null, folder: null }) : null);
	};

	return {
		/** The record for (vault, id), or null. */
		get(vault, id) {
			const e = entry(vault, id);
			return e ? structuredClone(e) : null;
		},

		/**
		 * The user answered the prompt: `granted` and `denied` capability
		 * lists (merged into what was asked before), `run` true/false for a
		 * restricted vault's run approval (undefined: not asked), `code` the
		 * hash to pin (or null to unpin).
		 */
		answer(vault, id, { granted = [], denied = [], run, code, folder } = {}) {
			const e = entry(vault, id, true);
			const at = now();
			for (const c of granted) { e.granted[c] = at; delete e.denied[c]; }
			for (const c of denied) { e.denied[c] = at; delete e.granted[c]; }
			if (run === true) { e.run = at; e.runDenied = null; }
			if (run === false) { e.run = null; e.runDenied = at; }
			if (code !== undefined) e.code = code;
			if (folder) e.folder = folder;
			save();
			return structuredClone(e);
		},

		/** Forget everything about an app here (Settings → Apps → Revoke). */
		revoke(vault, id) {
			load();
			if (!data.apps[vault]?.[id]) return false;
			delete data.apps[vault][id];
			if (Object.keys(data.apps[vault]).length === 0) delete data.apps[vault];
			save();
			return true;
		},

		/** Every app this device has answered about in one vault. */
		list(vault) {
			load();
			return structuredClone(data.apps[vault] ?? {});
		},
	};
}

/**
 * What the prompt still has to ask, and whether the app may run and hold a
 * port now. Pure: the registry calls it with the record and the manifest.
 *
 * @param {object|null} record   the grant record (createGrantStore#get)
 * @param {object} manifest      parseManifest's manifest
 * @param {{ restricted: boolean, code: () => string }} vault
 * @returns {{ ask: string[], askRun: boolean, changed: boolean,
 *   mayRun: boolean, granted: string[] }}
 */
export function grantState(record, manifest, { restricted, code }) {
	const granted = manifest.capabilities.filter((c) => record?.granted?.[c]);
	const answered = (c) => Boolean(record?.granted?.[c] || record?.denied?.[c]);
	const ask = manifest.capabilities.filter((c) => !answered(c));
	// Choice C: pinned code that no longer matches is a new app to the user.
	const changed = Boolean(restricted && record?.code && record.code !== code());
	let askRun = false;
	let mayRun = true;
	if (restricted) {
		if (record?.runDenied && !changed) { mayRun = false; }
		else if (!record?.run || changed) { askRun = true; mayRun = false; }
	}
	return { ask: changed ? [...manifest.capabilities] : ask, askRun, changed, mayRun, granted: changed ? [] : granted };
}
