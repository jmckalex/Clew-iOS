// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The app settings file (clew-settings.json) and what is read from it —
// settings.js holds the defaults and the one instance, at Electron's userData.
// Kept apart from Electron so the rules of reading and writing it are tested
// under plain node (tests/settings-store.test.js).
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './fs-utils.js';
import { FIGURE_ENGINE_CHOSEN, unpinFigureEngine } from './export-cache.js';

export class SettingsStore {
	#defaults;
	#fileOf;
	#data;
	#file = null;

	/**
	 * @param {object} defaults - every key's value when the file says nothing
	 * @param {() => string} fileOf - where the file is, asked at load
	 */
	constructor(defaults, fileOf) {
		this.#defaults = defaults;
		this.#fileOf = fileOf;
		this.#data = { ...defaults };
	}

	load() {
		this.#file = this.#fileOf();
		try {
			this.#data = { ...this.#defaults, ...unpinFigureEngine(JSON.parse(fs.readFileSync(this.#file, 'utf8'))) };
		} catch {
			this.#data = { ...this.#defaults };
		}
	}

	get(key) {
		return key === undefined ? { ...this.#data } : this.#data[key];
	}

	set(key, value) {
		this.#data[key] = value;
		// Every save writes every key, so a value is the user's only when
		// they set it (export-cache.js#unpinFigureEngine).
		if (key === 'exportFigureEngine') this.#data[FIGURE_ENGINE_CHOSEN] = true;
		this.#save();
	}

	addOpenVault(vaultPath) {
		const list = this.#data.openVaults.filter((p) => p !== vaultPath);
		list.push(vaultPath);
		this.#data.openVaults = list;
		this.#save();
	}

	removeOpenVault(vaultPath) {
		this.#data.openVaults = this.#data.openVaults.filter((p) => p !== vaultPath);
		this.#save();
	}

	rememberVault(vaultPath) {
		const recent = this.#data.recentVaults.filter((p) => p !== vaultPath);
		recent.unshift(vaultPath);
		this.#data.recentVaults = recent.slice(0, 10);
		this.#data.lastVault = vaultPath;
		this.#save();
	}

	#save() {
		// Smoke runs never persist: everything still works in memory, but
		// nothing a scenario does — opening a vault (rememberVault!),
		// flipping the theme — can leak into the user's real settings.
		// The 5k-note stress vault turning up in the owner's own launch
		// (via the lastVault fallback) is how this line was earned.
		if (process.env.CLEW_SMOKE) return;
		try {
			fs.mkdirSync(path.dirname(this.#file), { recursive: true });
			writeFileAtomic(this.#file, JSON.stringify(this.#data, null, 2));
		} catch (err) {
			console.error('Failed to save settings:', err);
		}
	}
}
