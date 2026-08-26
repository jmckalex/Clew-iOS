// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// App-level settings persisted in Electron's userData directory:
// recent vaults, last vault, theme. Vault-level state lives in <vault>/.clew/.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
	recentVaults: [],
	openVaults: [], // one window each, restored at launch
	newTabMode: 'source',
	explorerOpenMode: 'new-tab', // how newly created note tabs open ('source'|'reading')
	diaryMode: 'files', // 'files' = one note per day, 'log' = single log note
	diaryLogFile: 'Diary.md',
	lastVault: null,
	theme: 'dark',
	// Optional 139 MB CJK font download for the PDF viewer, off by
	// default and fetched on demand — see src/main/pdf-fonts.js.
	pdfCjkFonts: false,
};

class Settings {
	#data = { ...DEFAULTS };
	#file = null;

	load() {
		this.#file = path.join(app.getPath('userData'), 'clew-settings.json');
		try {
			this.#data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.#file, 'utf8')) };
		} catch {
			this.#data = { ...DEFAULTS };
		}
	}

	get(key) {
		return key === undefined ? { ...this.#data } : this.#data[key];
	}

	set(key, value) {
		this.#data[key] = value;
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
		try {
			fs.mkdirSync(path.dirname(this.#file), { recursive: true });
			fs.writeFileSync(this.#file, JSON.stringify(this.#data, null, 2));
		} catch (err) {
			console.error('Failed to save settings:', err);
		}
	}
}

export const settings = new Settings();
