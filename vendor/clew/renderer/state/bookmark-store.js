// Bookmarked notes, persisted per vault to .clew/bookmarks.json.
import { Emitter } from '../lib/emitter.js';
import { ipc, CH } from '../ipc.js';

class BookmarkStore extends Emitter {
	/** @type {string[]} vault-relative note paths, in bookmark order */
	paths = [];

	async load() {
		const saved = await ipc.invoke(CH.VSTATE_LOAD, { name: 'bookmarks.json' }).catch(() => null);
		this.paths = Array.isArray(saved) ? saved : [];
		this.emit('bookmarks-changed');
	}

	has(path) {
		return this.paths.includes(path);
	}

	toggle(path) {
		if (this.has(path)) this.paths = this.paths.filter((p) => p !== path);
		else this.paths = [...this.paths, path];
		this.#save();
		this.emit('bookmarks-changed');
	}

	remap(fromPath, toPath) {
		let touched = false;
		this.paths = this.paths.map((p) => {
			if (p === fromPath) { touched = true; return toPath; }
			if (p.startsWith(fromPath + '/')) { touched = true; return toPath + p.slice(fromPath.length); }
			return p;
		});
		if (touched) {
			this.#save();
			this.emit('bookmarks-changed');
		}
	}

	#save() {
		ipc.invoke(CH.VSTATE_SAVE, { name: 'bookmarks.json', data: this.paths }).catch(() => {});
	}
}

export const bookmarkStore = new BookmarkStore();
