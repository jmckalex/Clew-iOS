// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The note API dispatcher: rendered notes (reading-mode previews and canvas
// embeds) send {type:'api-request', id, method, params} over postMessage;
// this module is the single, explicitly-whitelisted gateway between those
// scripts and the app. Gated per vault (Settings → This vault → note API,
// default off); every request carries the path of the note it came from.
// Note scripts live on the clew-preview:// origin with no Node access —
// nothing here can exceed what the renderer itself may do over clew:* IPC.
import { vaultStore, isNotePath } from './state/vault-store.js';
import { settingsStore } from './state/settings-store.js';
import { runCommand } from './commands/registry.js';
import * as actions from './commands/actions.js';
import { parseProperties, serializeProperties } from '../shared/frontmatter.js';
import { ipc, CH } from './ipc.js';

// Text files the API may read and write (vault-relative, main-validated).
const TEXT_EXT = ['.md', '.jmd', '.canvas', '.json', '.txt', '.csv', '.bib'];
const isTextPath = (p) => typeof p === 'string' && TEXT_EXT.some((ext) => p.toLowerCase().endsWith(ext));

let gate = null; // null = unknown, else boolean
ipc.on(CH.EV_VAULT_OPENED, () => { gate = null; });

/** Called by the settings view when the vault toggle changes. */
export function invalidateNoteApiGate() {
	gate = null;
}

async function apiEnabled() {
	if (gate === null) {
		const vaultSettings = await ipc.invoke(CH.VAULT_SETTINGS_GET).catch(() => ({}));
		gate = vaultSettings?.noteApi === true;
	}
	return gate;
}

const requireTextPath = (path) => {
	if (!isTextPath(path)) throw new Error(`Not a text file the API may touch: ${path}`);
	return path;
};

const METHODS = {
	// ---- context ----------------------------------------------------------
	'context': async (_p, { sourcePath }) => ({
		path: sourcePath,
		vault: vaultStore.vault?.name ?? null,
		theme: settingsStore.get('theme') ?? 'dark',
	}),

	// ---- query ------------------------------------------------------------
	'notes.list': async () => vaultStore.notePaths(),
	'notes.read': async ({ path }) => ipc.invoke(CH.NOTE_READ, { path: requireTextPath(path) }),
	'index.get': async ({ path }) => {
		const meta = vaultStore.index?.[path];
		return meta ? JSON.parse(JSON.stringify(meta)) : null;
	},
	'index.backlinks': async ({ path }) => vaultStore.backlinksFor(path),
	'search': async ({ query }) => ipc.invoke(CH.SEARCH, { query: String(query ?? '') }),
	'properties.get': async ({ path }) => {
		const text = await ipc.invoke(CH.NOTE_READ, { path: requireTextPath(path) });
		const { present, entries, clean } = parseProperties(text);
		return { present, clean, entries };
	},

	// ---- mutate -----------------------------------------------------------
	'notes.write': async ({ path, content }) => {
		await ipc.invoke(CH.NOTE_WRITE, { path: requireTextPath(path), content: String(content ?? '') });
		return true;
	},
	'notes.append': async ({ path, text }) => {
		requireTextPath(path);
		const current = await ipc.invoke(CH.NOTE_READ, { path }).catch(() => null);
		const base = current === null ? '' : current.endsWith('\n') || current === '' ? current : current + '\n';
		await ipc.invoke(CH.NOTE_WRITE, { path, content: base + String(text ?? '') });
		return true;
	},
	'notes.create': async ({ path, content }) => {
		const created = await ipc.invoke(CH.NOTE_CREATE, { path: requireTextPath(path) });
		if (content) await ipc.invoke(CH.NOTE_WRITE, { path: created, content: String(content) });
		return created;
	},
	'properties.set': async ({ path, key, value }) => {
		if (typeof key !== 'string' || !key.trim()) throw new Error('properties.set needs a key');
		const notePath = requireTextPath(path);
		if (!isNotePath(notePath)) throw new Error('properties.set works on notes only');
		const text = await ipc.invoke(CH.NOTE_READ, { path: notePath });
		const { entries, clean, end } = parseProperties(text);
		if (!clean) throw new Error('Frontmatter uses YAML beyond the editable subset; refusing to rewrite it');
		const existing = entries.findIndex((e) => e.key === key);
		if (value === null || value === undefined) {
			if (existing !== -1) entries.splice(existing, 1);
		} else if (existing !== -1) {
			entries[existing].value = value;
		} else {
			entries.push({ key, value });
		}
		await ipc.invoke(CH.NOTE_WRITE, { path: notePath, content: serializeProperties(entries) + text.slice(end) });
		return true;
	},

	// ---- app control ------------------------------------------------------
	'open': async ({ target, newTab, mode }) => {
		if (typeof target !== 'string' || !target.trim()) throw new Error('open needs a target');
		await actions.openWikilink(target, { newTab: newTab !== false, mode });
		return true;
	},
	'command': async ({ id }) => runCommand(String(id ?? '')),

	// ---- kv store ---------------------------------------------------------
	'kv.get': async ({ key }) => ipc.invoke(CH.KV_GET, { key: String(key ?? '') }),
	'kv.set': async ({ key, value }) => ipc.invoke(CH.KV_SET, { key: String(key ?? ''), value }),
	'kv.delete': async ({ key }) => ipc.invoke(CH.KV_DELETE, { key: String(key ?? '') }),
	'kv.list': async ({ prefix }) => ipc.invoke(CH.KV_LIST, { prefix: String(prefix ?? '') }),
};

/**
 * Handle one api-request message from a rendered note. Always resolves to a
 * response payload — errors are data, never exceptions, so the note's
 * promise rejects with a clean message.
 */
export async function handleApiRequest(msg, { sourcePath }) {
	const respond = (ok, payload) => ({
		type: 'api-response',
		id: msg.id,
		ok,
		...(ok ? { result: payload ?? null } : { error: String(payload) }),
	});
	try {
		if (!(await apiEnabled())) {
			return respond(false, 'The note API is disabled for this vault (Settings → This vault).');
		}
		const method = METHODS[msg.method];
		if (!method) return respond(false, `Unknown API method: ${msg.method}`);
		return respond(true, await method(msg.params ?? {}, { sourcePath }));
	} catch (err) {
		return respond(false, err?.message ?? err);
	}
}
