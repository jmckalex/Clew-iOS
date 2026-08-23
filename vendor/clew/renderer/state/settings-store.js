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
