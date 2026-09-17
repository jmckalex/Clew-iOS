// App-level settings on iOS: localStorage instead of Electron's userData
// file. Same keys and surface as vendor/clew/main/settings.js.
const DEFAULTS = {
	recentVaults: [],
	openVaults: [],
	newTabMode: 'source',
	explorerOpenMode: 'new-tab',
	diaryMode: 'files',
	diaryLogFile: 'Diary.md',
	lastVault: null,
	theme: 'dark',
	// Paper for "Export as PDF (reading view)" — upstream's default.
	printPaperSize: 'a4',
};

const STORE_KEY = 'clew-settings';

class Settings {
	#data = { ...DEFAULTS };

	load() {
		try {
			this.#data = { ...DEFAULTS, ...JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) ?? '{}') };
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

	rememberVault(vaultPath) {
		const recent = this.#data.recentVaults.filter((p) => p !== vaultPath);
		recent.unshift(vaultPath);
		this.#data.recentVaults = recent.slice(0, 10);
		this.#data.lastVault = vaultPath;
		this.#save();
	}

	#save() {
		try {
			globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(this.#data));
		} catch (err) {
			console.error('Failed to save settings:', err);
		}
	}
}

export const settings = new Settings();
settings.load();
