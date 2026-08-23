// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// App settings mirror (theme etc.), loaded from main at boot.
import { Emitter } from '../lib/emitter.js';
import { ipc, CH } from '../ipc.js';

class SettingsStore extends Emitter {
	data = { theme: 'dark' };

	async load() {
		this.data = { ...this.data, ...(await ipc.invoke(CH.SETTINGS_GET).catch(() => ({}))) };
		this.emit('settings-changed');
	}

	get(key) { return this.data[key]; }

	set(key, value) {
		this.data[key] = value;
		ipc.invoke(CH.SETTINGS_SET, { key, value }).catch(() => {});
		this.emit('settings-changed', key);
	}
}

export const settingsStore = new SettingsStore();
