// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The editor pool owns every live EditorView, keyed by tab id. Components
// adopt/release the view's DOM node but never destroy it — layout changes and
// tab drags reparent editors losslessly. Views are destroyed only when their
// tab closes. The pool also owns dirty state, auto-save, a per-path
// EditorState cache (so undo history survives navigating away and back), and
// external-change conflict detection.
import { EditorView } from '@codemirror/view';
import { Emitter } from '../lib/emitter.js';
import { debounce } from '../lib/debounce.js';
import { ipc, CH } from '../ipc.js';
import { makeNoteState } from './editor.js';

const AUTOSAVE_MS = 1000;
const STATE_CACHE_LIMIT = 25;

class EditorPool extends Emitter {
	/** @type {Map<string, {view, path, dirty, generation, save, handlerRef,
	 *                       conflict, lastWrittenText}>} */
	#entries = new Map();
	/** Undo history across navigation: path -> {state, handlerRef}. The cached
	 *  state is only reused when the file's content still matches it. */
	#stateCache = new Map();

	/**
	 * Get (creating or re-pointing as needed) the editor for a note tab.
	 * Returns the entry whose `view.dom` the component adopts.
	 */
	async open(tabId, path) {
		let entry = this.#entries.get(tabId);
		if (entry && entry.path === path) return entry;

		if (entry) {
			// Same tab navigated to a different note: save the old one first and
			// bank its state so coming back restores undo history.
			entry.save.flush();
			this.#cacheState(entry);
			entry.generation++;
		} else {
			entry = {
				view: null, path: null, dirty: false, generation: 0,
				save: null, handlerRef: null, conflict: null, lastWrittenText: null,
			};
			entry.save = debounce(() => this.#save(tabId), AUTOSAVE_MS);
			this.#entries.set(tabId, entry);
		}

		const generation = entry.generation;
		entry.path = path;
		const content = await ipc.invoke(CH.NOTE_READ, { path }).catch(() => '');
		// The tab may have navigated again (or closed) while we read.
		if (this.#entries.get(tabId) !== entry || entry.generation !== generation) return entry;

		// Reuse the banked state (undo history, cursor) when the file on disk
		// still matches what that state holds; otherwise start fresh.
		let state;
		let handlerRef;
		const cached = this.#stateCache.get(path);
		if (cached && cached.state.doc.toString() === content) {
			({ state, handlerRef } = cached);
			this.#stateCache.delete(path); // it's live again
		} else {
			handlerRef = { fn: null };
			state = makeNoteState(content, handlerRef);
		}
		handlerRef.fn = (update) => {
			if (!update.docChanged) return;
			this.#setDirty(tabId, true);
			// While a conflict banner is up, auto-save stays paused so typing
			// can't clobber the on-disk version behind the user's back.
			if (!entry.conflict) entry.save();
			this.emit('doc-changed', { tabId });
		};

		if (entry.view) entry.view.setState(state);
		else entry.view = new EditorView({ state });
		entry.handlerRef = handlerRef;
		entry.dirty = false;
		entry.conflict = null;
		entry.lastWrittenText = content;
		return entry;
	}

	get(tabId) {
		return this.#entries.get(tabId) ?? null;
	}

	isDirty(tabId) {
		return this.#entries.get(tabId)?.dirty ?? false;
	}

	#cacheState(entry) {
		if (!entry.view || !entry.path || entry.conflict) return;
		this.#stateCache.set(entry.path, {
			state: entry.view.state,
			handlerRef: entry.handlerRef,
		});
		// LRU: Map iteration order is insertion order; drop the oldest.
		while (this.#stateCache.size > STATE_CACHE_LIMIT) {
			this.#stateCache.delete(this.#stateCache.keys().next().value);
		}
	}

	async #save(tabId) {
		const entry = this.#entries.get(tabId);
		if (!entry?.view || !entry.dirty || entry.conflict) return;
		const content = entry.view.state.doc.toString();
		try {
			await ipc.invoke(CH.NOTE_WRITE, { path: entry.path, content });
			entry.lastWrittenText = content;
			this.#setDirty(tabId, false);
		} catch (err) {
			console.error(`Failed to save ${entry.path}:`, err);
		}
	}

	#setDirty(tabId, dirty) {
		const entry = this.#entries.get(tabId);
		if (!entry || entry.dirty === dirty) return;
		entry.dirty = dirty;
		this.emit('dirty-changed', { tabId, dirty });
	}

	/** Flush a pending save immediately (blur, tab switch, close). */
	flush(tabId) {
		this.#entries.get(tabId)?.save.flush();
	}

	flushAll() {
		for (const entry of this.#entries.values()) entry.save.flush();
	}

	// ---- external changes and conflicts -----------------------------------

	/** A file changed on disk. Clean editors reload silently; editors with
	 *  unsaved changes get a conflict banner (and auto-save pauses). */
	async externalChange(path) {
		for (const [tabId, entry] of this.#entries) {
			if (entry.path !== path || !entry.view) continue;
			const disk = await ipc.invoke(CH.NOTE_READ, { path }).catch(() => null);
			if (disk === null || this.#entries.get(tabId) !== entry) continue;
			const current = entry.view.state.doc.toString();
			if (disk === current) {
				// Disk caught up with the editor (e.g. an identical external save).
				if (!entry.conflict) this.#setDirty(tabId, false);
				continue;
			}
			if (disk === entry.lastWrittenText) continue; // echo of our own save
			if (!entry.dirty && !entry.conflict) {
				this.#reload(tabId, entry, disk);
				continue;
			}
			// Local unsaved edits AND a different version on disk.
			entry.conflict = disk;
			entry.save.cancel();
			this.emit('conflict-changed', { tabId, active: true });
		}
	}

	#reload(tabId, entry, content) {
		const { view } = entry;
		const selection = view.state.selection;
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: content },
			selection: selection.main.anchor <= content.length ? selection : undefined,
		});
		entry.lastWrittenText = content;
		entry.save.cancel();
		this.#setDirty(tabId, false);
	}

	/** Resolve a conflict: 'keep' writes the editor's version over the disk
	 *  version; 'reload' discards local edits and loads the disk version. */
	async resolveConflict(tabId, choice) {
		const entry = this.#entries.get(tabId);
		if (!entry?.conflict) return;
		const disk = entry.conflict;
		entry.conflict = null;
		if (choice === 'reload') {
			this.#reload(tabId, entry, disk);
		} else {
			const content = entry.view.state.doc.toString();
			try {
				await ipc.invoke(CH.NOTE_WRITE, { path: entry.path, content });
				entry.lastWrittenText = content;
				this.#setDirty(tabId, false);
			} catch (err) {
				console.error(`Failed to save ${entry.path}:`, err);
			}
		}
		this.emit('conflict-changed', { tabId, active: false });
	}

	/** A file was renamed: keep editors and cached states pointed right. */
	remapPath(fromPath, toPath) {
		const remap = (p) => {
			if (p === fromPath) return toPath;
			if (p?.startsWith(fromPath + '/')) return toPath + p.slice(fromPath.length);
			return p;
		};
		for (const entry of this.#entries.values()) entry.path = remap(entry.path);
		for (const [path, cached] of [...this.#stateCache]) {
			const next = remap(path);
			if (next !== path) {
				this.#stateCache.delete(path);
				this.#stateCache.set(next, cached);
			}
		}
	}

	close(tabId) {
		const entry = this.#entries.get(tabId);
		if (!entry) return;
		entry.save.flush();
		entry.save.cancel();
		this.#cacheState(entry);
		entry.view?.destroy();
		this.#entries.delete(tabId);
	}

	/** Destroy editors whose tabs no longer exist. */
	reap(openTabIds) {
		for (const tabId of [...this.#entries.keys()]) {
			if (!openTabIds.has(tabId)) this.close(tabId);
		}
	}
}

export const editorPool = new EditorPool();
