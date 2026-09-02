// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The vault key-value store behind the note API: clewdata.json in the vault
// root — a deliberately VISIBLE file, so app state written by note scripts
// travels with a shared or synced vault. Main owns the file (no write races
// between previews); values are JSON-safe; keys are written sorted so diffs
// and merges stay friendly. External edits (git pull, sync, hand editing)
// come back in through the vault watcher and broadcast per-key changes.
import fs from 'node:fs';
import path from 'node:path';
import { CH } from '../shared/channels.js';
import { writeFileAtomic } from './fs-utils.js';

export const KV_FILE = 'clewdata.json';
const SAVE_DEBOUNCE_MS = 300;

export class KvStore {
	root = null;
	/** @type {(channel: string, payload: any) => void} */
	send = () => {};
	#data = {};
	#lastWritten = null;
	#saveTimer = null;

	open(root) {
		this.close();
		this.root = root;
		this.#data = this.#readFile() ?? {};
	}

	close() {
		if (this.#saveTimer) this.flush();
		this.root = null;
		this.#data = {};
		this.#lastWritten = null;
	}

	get(key) {
		return this.#data[key];
	}

	set(key, value) {
		if (typeof key !== 'string' || !key) throw new Error('kv key must be a non-empty string');
		if (value === undefined || value === null) return this.delete(key);
		JSON.stringify(value); // throws early on non-JSON-safe values
		this.#data[key] = value;
		this.#changed(key, value);
		return value;
	}

	delete(key) {
		if (!(key in this.#data)) return null;
		delete this.#data[key];
		this.#changed(key, null);
		return null;
	}

	/** All entries whose key starts with `prefix` ('' for everything). */
	list(prefix = '') {
		const out = {};
		for (const key of Object.keys(this.#data).sort()) {
			if (key.startsWith(prefix)) out[key] = this.#data[key];
		}
		return out;
	}

	#changed(key, value) {
		this.send(CH.EV_KV_CHANGED, { changes: [{ key, value }] });
		clearTimeout(this.#saveTimer);
		this.#saveTimer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
	}

	flush() {
		clearTimeout(this.#saveTimer);
		this.#saveTimer = null;
		if (!this.root) return;
		const text = this.#serialize();
		if (text === this.#lastWritten) return;
		this.#lastWritten = text;
		try {
			writeFileAtomic(path.join(this.root, KV_FILE), text);
		} catch (err) {
			console.error('kv store save failed:', err);
		}
	}

	/** The vault watcher saw clewdata.json change (sync, git, hand edit). */
	externalChange() {
		if (!this.root) return;
		const next = this.#readFile();
		if (next === null) return;
		if (this.#serialize(next) === this.#serialize(this.#data)) return;
		const changes = [];
		for (const key of new Set([...Object.keys(this.#data), ...Object.keys(next)])) {
			if (JSON.stringify(this.#data[key]) !== JSON.stringify(next[key])) {
				changes.push({ key, value: next[key] ?? null });
			}
		}
		this.#data = next;
		if (changes.length) this.send(CH.EV_KV_CHANGED, { changes });
	}

	#readFile() {
		try {
			const text = fs.readFileSync(path.join(this.root, KV_FILE), 'utf8');
			this.#lastWritten = text;
			const json = JSON.parse(text);
			return json && typeof json === 'object' && !Array.isArray(json) ? json : {};
		} catch {
			return null; // missing or unparsable: keep current state
		}
	}

	#serialize(data = this.#data) {
		const sorted = {};
		for (const key of Object.keys(data).sort()) sorted[key] = data[key];
		return JSON.stringify(sorted, null, '\t') + '\n';
	}
}

export const kvStore = new KvStore();
