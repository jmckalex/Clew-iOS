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
import { makeNoteState, markdownCompartment } from './editor.js';
import { noteMarkdown } from './jmd/markdown-config.js';
import { vaultSettingsStore } from '../state/vault-settings-store.js';
import { settingsStore } from '../state/settings-store.js';
import { liveCompartment, liveEdit } from './live/index.js';
import { liveRebuild, liveStateField } from './live/reveal-field.js';
import { destroyCellEditor } from './live/table-cell-editor.js';
import { minimalChange } from './minimal-change.js';
import { readLiveConfig } from './live/config.js';
import { setViewNotePath } from './link-hover.js';
import { pluginEngineDeclarations, onPluginEngineDeclarations } from '../plugins.js';

/** Live edit refuses documents above this size (plan §9); source mode
 *  degrades on its own past the same threshold (jmd/overlay.js). */
export const LIVE_BIG_DOC = 500000;
const LIVE_SETTINGS = new Set(['liveReveal', 'liveRenderMath', 'liveRenderFences', 'liveRenderEmbeds', 'liveFrameCap']);
const liveConfig = () => readLiveConfig(settingsStore, vaultSettingsStore, pluginEngineDeclarations());

/** The vault's dialect switch, as the grammar wants it. */
const normalSyntax = () => vaultSettingsStore.get('normalSyntax') === true;

const AUTOSAVE_MS = 1000;
const STATE_CACHE_LIMIT = 25;

class EditorPool extends Emitter {
	/** @type {Map<string, {view, path, dirty, generation, save, handlerRef,
	 *                       conflict, lastWrittenText}>} */
	#entries = new Map();
	/** Undo history across navigation: path -> {state, handlerRef}. The cached
	 *  state is only reused when the file's content still matches it. */
	#stateCache = new Map();

	constructor() {
		super();
		// A normalSyntax flip changes the grammar: reconfigure every open
		// editor in place (undo history survives — it is a Compartment), and
		// drop the banked states, which hold the old grammar.
		vaultSettingsStore.on('vault-settings-changed', (key) => {
			if (key !== 'normalSyntax') return;
			const effects = markdownCompartment.reconfigure(noteMarkdown({ normalSyntax: normalSyntax() }));
			for (const entry of this.#entries.values()) entry.view?.dispatch({ effects });
			this.#stateCache.clear();
			this.reconfigureLive();
		});
		settingsStore.on('settings-changed', (key) => {
			if (LIVE_SETTINGS.has(key)) this.reconfigureLive();
		});
		// A plugin declaring fences or numbered environments came or went.
		onPluginEngineDeclarations(() => this.reconfigureLive());
	}

	/**
	 * Put a tab's editor in source or live edit: a reconfiguration of the
	 * live compartment of the SAME view (live/index.js). Returns the mode
	 * actually applied — 'source' for a live request over a document larger
	 * than LIVE_BIG_DOC, which the caller tells the user about.
	 *
	 * @param {string} tabId
	 * @param {'source'|'live'} mode
	 * @returns {'source'|'live'|null} null when the tab has no editor yet
	 */
	setMode(tabId, mode) {
		const entry = this.#entries.get(tabId);
		if (!entry?.view) return null;
		const effective = mode === 'live' && entry.view.state.doc.length <= LIVE_BIG_DOC ? 'live' : 'source';
		// What the editor HAS, not only what was last asked for: a state put
		// in since (open() re-pointing the tab) carries its own compartment,
		// and trusting `entry.mode` alone left a live tab undrawn — raw `#`
		// and `>` under a pressed live button (2026-10-02).
		const has = entry.view.state.field(liveStateField, false) ? 'live' : 'source';
		if (entry.mode !== effective || has !== effective) {
			const changed = entry.mode !== effective;
			entry.mode = effective;
			entry.view.dispatch({
				effects: liveCompartment.reconfigure(effective === 'live' ? liveEdit({ ...liveConfig(), notePath: entry.path, tabId }) : []),
			});
			if (changed) this.emit('mode-changed', { tabId, mode: effective });
		}
		return effective;
	}

	/** The mode a tab's editor is in ('source' | 'live'), or null. */
	modeOf(tabId) {
		return this.#entries.get(tabId)?.mode ?? null;
	}

	/** Live settings changed: rebuild every live editor's bundle. */
	reconfigureLive() {
		const config = liveConfig();
		for (const [tabId, entry] of this.#entries) {
			if (entry.mode === 'live' && entry.view) {
				entry.view.dispatch({ effects: liveCompartment.reconfigure(liveEdit({ ...config, notePath: entry.path, tabId })) });
			}
		}
	}

	/** What a construct means changed outside the editor (custom callout
	 *  types, renderer/callouts.js): rebuild every live editor's model. */
	rebuildLive() {
		for (const entry of this.#entries.values()) {
			if (entry.mode === 'live' && entry.view) entry.view.dispatch({ effects: liveRebuild.of(null) });
		}
	}

	/**
	 * Get (creating or re-pointing as needed) the editor for a note tab.
	 * Returns the entry whose `view.dom` the component adopts.
	 *
	 * An open of the same note already under way is WAITED FOR, never cut
	 * short: until 2026-10-02 a second caller (the tab shown again, moved to a
	 * split, re-rendered — all in one tick) got the entry back at once, with
	 * no view yet (its host gave up: an empty pane) or with the OLD view and
	 * its old mode, which the first open then replaced with a fresh state
	 * (live edit undrawn under a pressed live button).
	 */
	async open(tabId, path) {
		let entry = this.#entries.get(tabId);
		if (entry && entry.path === path) return entry.opening ?? entry;

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
		const opening = this.#load(tabId, entry, generation, path);
		entry.opening = opening;
		try {
			return await opening;
		} finally {
			if (entry.opening === opening) entry.opening = null;
		}
	}

	/** open()'s second half: read the note, then put its state in the view. */
	async #load(tabId, entry, generation, path) {
		const [content] = await Promise.all([
			ipc.invoke(CH.NOTE_READ, { path }).catch(() => ''),
			vaultSettingsStore.ready(),
		]);
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
			state = makeNoteState(content, handlerRef, { normalSyntax: normalSyntax() });
		}
		handlerRef.fn = (update) => {
			// Selection and doc changes, for what reflects the cursor (the
			// editor toolbar, the selection bubble).
			if (update.docChanged || update.selectionSet || update.focusChanged) this.emit('view-update', { tabId, update });
			if (!update.docChanged) return;
			this.#setDirty(tabId, true);
			// While a conflict banner is up, auto-save stays paused so typing
			// can't clobber the on-disk version behind the user's back.
			if (!entry.conflict) entry.save();
			this.emit('doc-changed', { tabId });
		};

		if (entry.view) entry.view.setState(state);
		else entry.view = new EditorView({ state });
		setViewNotePath(entry.view, path);
		// A cached state carries whatever its live compartment held when it
		// was banked; the next setMode decides afresh.
		entry.mode = null;
		entry.handlerRef = handlerRef;
		entry.dirty = false;
		entry.conflict = null;
		entry.lastWrittenText = content;
		// A host already showing this view puts its mode back (clew-editor-
		// view.js): the state just set has no compartment of its own.
		this.emit('state-replaced', { tabId });
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
		// The smallest change, not a wholesale replace: the cursor, and a
		// table cell being edited in place, map through it and survive.
		const change = minimalChange(view.state.doc.toString(), content);
		if (change) view.dispatch({ changes: change });
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
		for (const entry of this.#entries.values()) {
			entry.path = remap(entry.path);
			if (entry.view) setViewNotePath(entry.view, entry.path);
		}
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
		if (entry.view) destroyCellEditor(entry.view);
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
