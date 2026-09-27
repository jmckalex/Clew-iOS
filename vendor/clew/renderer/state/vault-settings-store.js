// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The open vault's own settings (`<vault>/.clew/vault-settings.json`), mirrored
// in the renderer. Main owns the file and reconfigures the engine on a write;
// this store exists because the EDITOR now depends on one of them too —
// `normalSyntax` decides the markdown grammar (editor/jmd/markdown-config.js)
// — and an editor cannot wait on an IPC round trip per keystroke.
//
// Loaded on every vault-opened (main.js); `ready()` is what anything built at
// boot awaits (the editor pool does, before making a state). Every write goes
// through `set`, which emits `vault-settings-changed` with the key and keeps
// the older window-level `clew:vault-settings-changed` event alive for the
// chrome that listens to it. Readers that only need a value once (note-api,
// the file explorer, the settings rows) may keep asking main directly.
import { Emitter } from '../lib/emitter.js';
import { ipc, CH } from '../ipc.js';

class VaultSettingsStore extends Emitter {
	data = {};
	#loaded = Promise.resolve();

	/** Fetch this window's vault settings (on vault-opened). */
	load() {
		this.#loaded = ipc.invoke(CH.VAULT_SETTINGS_GET)
			.catch(() => ({}))
			.then((data) => {
				this.data = data ?? {};
				this.emit('vault-settings-changed', null);
			});
		return this.#loaded;
	}

	/** Resolves once the current vault's settings are in. */
	ready() { return this.#loaded; }

	get(key) { return this.data[key]; }

	/** Write one key through main, then announce it. */
	async set(key, value) {
		this.data[key] = value;
		try {
			await ipc.invoke(CH.VAULT_SETTINGS_SET, { key, value });
		} finally {
			this.emit('vault-settings-changed', key);
			window.dispatchEvent(new CustomEvent('clew:vault-settings-changed', { detail: { key } }));
		}
	}
}

export const vaultSettingsStore = new VaultSettingsStore();
