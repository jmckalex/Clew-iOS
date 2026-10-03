// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// App-surface plugin loader. Enabled vault plugins with an "app" surface run
// in the renderer against a SMALL, versioned API object — never the app's
// internals. Everything a plugin registers is tracked and unwound when the
// vault changes (or the plugin is disabled), so plugins cannot outlive their
// vault. Plugins are arbitrary code: the per-vault enable toggle is the
// trust boundary, exactly like the note API gate.
import { ipc, CH } from './ipc.js';
import { vaultStore } from './state/vault-store.js';
import { workspaceStore } from './state/workspace-store.js';
import { registerCommand, unregisterCommand } from './commands/registry.js';
import { addToolbarButton } from './editor/toolbar/clew-editor-toolbar.js';

// 2: `clew.toolbar.addButton` (live edit's editor toolbar).
export const PLUGIN_API_VERSION = 2;

let loaded = []; // [{id, cleanup: fn[]}]

export function initPlugins() {
	vaultStore.on('vault-changed', () => reloadPlugins());
	// What may run changed on this device (an enablement in Settings →
	// This vault): load or unwind app surfaces now. Trust itself reloads
	// the window, which starts from scratch anyway.
	ipc.on(CH.EV_VAULT_ACCESS_CHANGED, () => reloadPlugins());
	reloadPlugins();
}

// What enabled plugins' ENGINE surfaces declare (§5.13 §6): the fence names
// they render (`"fences": ["chart"]` — live edit then draws them as frames,
// not code) and the environments they number (`"numbered": ["exercise"]` or
// `{name, counter, refname}` — the live numbering then counts them). Clew
// cannot see into a plugin's engine code from the renderer, so the manifest
// says; an undeclared environment with a label is refused by name ("?").
let engineDeclarations = { fences: [], numbered: new Map() };
const declarationListeners = new Set();

/** The enabled plugins' declarations. */
export function pluginEngineDeclarations() { return engineDeclarations; }

/** Called when they change (plugins enabled, disabled, reloaded). */
export function onPluginEngineDeclarations(fn) {
	declarationListeners.add(fn);
	return () => declarationListeners.delete(fn);
}

function collectEngineDeclarations(plugins) {
	const fences = [];
	const numbered = new Map();
	for (const plugin of plugins) {
		const engine = plugin.surfaces?.engine;
		if (!engine) continue;
		for (const name of Array.isArray(engine.fences) ? engine.fences : []) {
			if (typeof name === 'string' && /^[\w-]+$/.test(name)) fences.push(name);
		}
		for (const entry of Array.isArray(engine.numbered) ? engine.numbered : []) {
			const spec = typeof entry === 'string' ? { name: entry } : entry;
			if (!spec || typeof spec.name !== 'string' || !/^[\w-]+$/.test(spec.name)) continue;
			const refname = typeof spec.refname === 'string' ? spec.refname : spec.name;
			numbered.set(spec.name, {
				counter: typeof spec.counter === 'string' ? spec.counter : spec.name,
				type: refname,
				title: refname.charAt(0).toUpperCase() + refname.slice(1),
			});
		}
	}
	const same = fences.join() === engineDeclarations.fences.join()
		&& JSON.stringify([...numbered]) === JSON.stringify([...engineDeclarations.numbered]);
	engineDeclarations = { fences, numbered };
	if (!same) for (const fn of declarationListeners) fn(engineDeclarations);
}

async function reloadPlugins() {
	for (const plugin of loaded) {
		for (const cleanup of plugin.cleanup) {
			try { cleanup(); } catch { /* plugin cleanup must never break the app */ }
		}
	}
	loaded = [];
	if (!vaultStore.vault) return;

	const { plugins, enabled } = await ipc.invoke(CH.PLUGINS_LIST).catch(() => ({ plugins: [], enabled: [] }));
	const enabledSet = new Set(enabled);
	collectEngineDeclarations(plugins.filter((p) => enabledSet.has(p.id)));
	const sid = vaultStore.vault?.sessionId;
	for (const plugin of plugins) {
		if (!enabledSet.has(plugin.id) || !plugin.surfaces.app) continue;
		const record = { id: plugin.id, cleanup: [] };
		// The app CSP has no unsafe-eval, so plugin code loads as a real
		// script from a protocol namespace that only serves ENABLED plugins;
		// the served file is wrapped to pick its API object up from here.
		window.__clewPluginApi ??= {};
		window.__clewPluginApi[plugin.id] = makeApi(plugin.id, record);
		record.cleanup.push(() => { delete window.__clewPluginApi[plugin.id]; });
		const script = document.createElement('script');
		script.src = `clew-preview://vault/__clew_plugin_app__/${sid}/${plugin.id}.js?v=${Date.now()}`;
		script.onerror = () => notice(`Plugin “${plugin.id}” failed to load`);
		document.head.append(script);
		record.cleanup.push(() => script.remove());
		loaded.push(record);
	}
}

function makeApi(pluginId, record) {
	return Object.freeze({
		apiVersion: PLUGIN_API_VERSION,
		pluginId,
		vaultName: vaultStore.vault?.name ?? null,

		commands: Object.freeze({
			/** Register a palette/hotkey command. Ids are namespaced to the
			 *  plugin; returns the full id. */
			register(command) {
				const id = `plugin:${pluginId}:${command.id}`;
				registerCommand({ ...command, id });
				record.cleanup.push(() => unregisterCommand(id));
				return id;
			},
		}),

		vault: Object.freeze({
			read: (path) => ipc.invoke(CH.NOTE_READ, { path }),
			write: (path, content) => ipc.invoke(CH.NOTE_WRITE, { path, content }),
			list: () => {
				const files = [];
				const walk = (entries) => {
					for (const entry of entries ?? []) {
						if (entry.type === 'folder') walk(entry.children);
						else files.push(entry.path);
					}
				};
				walk(vaultStore.tree);
				return files;
			},
		}),

		workspace: Object.freeze({
			open: (path, opts = {}) => { workspaceStore.openNote(path, opts); },
			activePath: () => workspaceStore.activeTab()?.path ?? null,
		}),

		events: Object.freeze({
			/** 'vault-changed' | 'tree-changed' | 'index-changed' (vault store)
			 *  or 'active-changed' | 'layout-changed' (workspace store). */
			on(name, fn) {
				const store = ['active-changed', 'layout-changed'].includes(name)
					? workspaceStore : vaultStore;
				const off = store.on(name, fn);
				record.cleanup.push(off);
				return off;
			},
		}),

		ui: Object.freeze({ notice }),

		toolbar: Object.freeze({
			/**
			 * A button on the editor toolbar (API 2): `{ id, command, label,
			 * icon, group }` — `command` is a command id (usually one this
			 * plugin registered), `icon` an icon name or an `<svg>` string,
			 * `group` a toolbar group id (default 'insert'). Removed with the
			 * plugin's other registrations when the vault changes.
			 */
			addButton(spec) {
				const off = addToolbarButton({ ...spec, id: `plugin:${pluginId}:${spec.id ?? spec.command}` });
				record.cleanup.push(off);
				return off;
			},
		}),
	});
}

/** A small transient toast, bottom center. */
export function notice(text, ms = 3000) {
	let host = document.querySelector('.clew-notices');
	if (!host) {
		host = document.createElement('div');
		host.className = 'clew-notices';
		document.body.append(host);
	}
	const el = document.createElement('div');
	el.className = 'clew-notice';
	el.textContent = String(text);
	host.append(el);
	setTimeout(() => {
		el.classList.add('is-leaving');
		setTimeout(() => el.remove(), 300);
	}, ms);
}
