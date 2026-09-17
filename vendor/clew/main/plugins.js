// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Plugins: discovery and wiring. A plugin is a folder with a manifest.json
// and up to three code surfaces, one per extension seam Clew already has.
// Plugin folders are found in TWO places:
//
//   <vault>/.clew/plugins/<id>/   — vault plugins, travelling with the vault
//   <userData>/plugins/<id>/      — GLOBAL plugins, installed once per user
//
// Global plugins exist because a plugin you wrote is rarely about one vault:
// copying it into every new vault was the tax this removes. Installing is
// global; ENABLING stays per-vault (vault-settings.json "plugins": [ids]),
// exactly as before — the trust boundary does not move, and a vault still
// runs no code until it says so. A vault plugin SHADOWS a global one of the
// same id (most specific wins), so a vault can pin its own version.
//
// The surfaces:
//
//   "engine"  — a jmarkdown extension module loaded into the render worker
//               (new syntax: fences, inline directives, transforms). The
//               manifest names the exports to register.
//   "preview" — a script injected into every rendered-note document after
//               the preview client (DOM decoration; window.clew note API
//               when that gate is on; re-run work on 'clew:render').
//   "app"     — a script run in the renderer against the small versioned
//               plugin API (src/renderer/plugins.js): commands, vault IO,
//               workspace, notices.
//
// Plugins are ARBITRARY CODE and are therefore off until explicitly enabled
// per vault (vault-settings.json "plugins": [ids]) — the same opt-in shape
// as the note API. Enabling is a statement of trust in the code, wherever it
// was installed from.
//
// The global directory is passed IN rather than read from paths.js: this
// module must stay importable by the unit tests, which run under plain node
// where `electron` cannot be imported. Main-process callers pass
// paths.globalPlugins; omitting it simply means "vault plugins only".
import fs from 'node:fs';
import path from 'node:path';

export const PLUGIN_API_VERSION = 1;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Manifest-validated plugins in ONE directory, tagged with their scope. */
function listPluginsIn(dir, scope) {
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
	const plugins = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
		const base = path.join(dir, entry.name);
		try {
			const manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
			if (manifest.id !== entry.name) continue; // folder must match id
			if ((manifest.apiVersion ?? 1) > PLUGIN_API_VERSION) continue; // too new
			const surfaces = {};
			for (const surface of ['engine', 'preview', 'app']) {
				const spec = manifest.surfaces?.[surface];
				if (!spec) continue;
				const file = typeof spec === 'string' ? spec : spec.file;
				if (typeof file !== 'string' || file.includes('..') || file.includes('/')) continue;
				if (!fs.existsSync(path.join(base, file))) continue;
				surfaces[surface] = typeof spec === 'string' ? { file } : { ...spec, file };
			}
			plugins.push({
				id: manifest.id,
				name: String(manifest.name ?? manifest.id),
				description: String(manifest.description ?? ''),
				version: String(manifest.version ?? '0.0.0'),
				surfaces,
				scope,
				dir: base,
			});
		} catch { /* bad manifest — not a plugin */ }
	}
	return plugins;
}

/**
 * Every plugin available to this vault (enabled or not): the vault's own,
 * plus the globally installed ones. A vault plugin SHADOWS a global plugin
 * of the same id — one id is one plugin, and the more specific copy wins.
 */
export function listPlugins(vaultRoot, globalDir = null) {
	const vault = listPluginsIn(path.join(vaultRoot, '.clew', 'plugins'), 'vault');
	const seen = new Set(vault.map((p) => p.id));
	const global = globalDir
		? listPluginsIn(globalDir, 'global').map((p) => ({ ...p, shadowed: seen.has(p.id) }))
		: [];
	return [...vault, ...global.filter((p) => !p.shadowed)];
}

/** The enabled subset, per vault-settings. */
export function enabledPlugins(vaultRoot, vaultSettings, globalDir = null) {
	const enabled = new Set(Array.isArray(vaultSettings?.plugins) ? vaultSettings.plugins : []);
	return listPlugins(vaultRoot, globalDir).filter((p) => enabled.has(p.id));
}

/** Engine-config Extensions entries for enabled engine surfaces:
 *  "exportA, exportB from /abs/path/engine.js". */
export function engineExtensionEntries(vaultRoot, vaultSettings, globalDir = null) {
	const entries = [];
	for (const plugin of enabledPlugins(vaultRoot, vaultSettings, globalDir)) {
		const engine = plugin.surfaces.engine;
		if (!engine) continue;
		const abs = path.join(plugin.dir, engine.file);
		const names = typeof engine.extensions === 'string' && /^[\w$, ]+$/.test(engine.extensions)
			? engine.extensions : null;
		if (names) entries.push(`${names} from ${abs}`);
	}
	return entries;
}

/**
 * Preview surfaces of enabled plugins, as {id, scope, file, dir, vaultRel}.
 * A vault plugin's script is ordinary vault content (vaultRel is its
 * vault-relative path); a global plugin's lives outside the vault and is
 * served from the __clew_plugin_file__ namespace instead (vaultRel null).
 */
export function previewPluginScripts(vaultRoot, vaultSettings, globalDir = null) {
	return enabledPlugins(vaultRoot, vaultSettings, globalDir)
		.filter((p) => p.surfaces.preview)
		.map((p) => ({
			id: p.id,
			scope: p.scope,
			file: p.surfaces.preview.file,
			dir: p.dir,
			vaultRel: p.scope === 'vault'
				? `.clew/plugins/${p.id}/${p.surfaces.preview.file}` : null,
		}));
}
