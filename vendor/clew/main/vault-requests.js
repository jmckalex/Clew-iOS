// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What a vault ASKS to run (docs/dev/frame-bridge.md §4.2): the keys of its
// own `.clew/vault-settings.json` that used to be grants — `plugins`,
// `noteApi`, `dataviewJs` — plus `network` (§4.9), read as a request list
// the trust prompt shows. Never a grant: what may run is the device's record
// (vault-trust.js). Electron-free, for the tests.
import fs from 'node:fs';
import path from 'node:path';

/** The request keys of a vault-settings object, as `{ enable }`. */
export function requestsOf(vaultSettings) {
	const v = vaultSettings ?? {};
	return {
		enable: {
			plugins: Array.isArray(v.plugins) ? v.plugins.filter((id) => typeof id === 'string') : [],
			noteApi: v.noteApi === true,
			dataviewJs: v.dataviewJs === true,
			network: v.network === true,
		},
	};
}

/** The vault at `root`'s request, or null when its settings cannot be read
 *  (a missing file is an empty request, not an unreadable one). */
export function readVaultRequests(root) {
	const file = path.join(root, '.clew', 'vault-settings.json');
	let text;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (err) {
		if (err.code === 'ENOENT') return requestsOf({});
		return null;
	}
	try {
		return requestsOf(JSON.parse(text));
	} catch {
		return requestsOf({});
	}
}
