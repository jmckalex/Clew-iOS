// Vault plugins: discovery and wiring. A plugin is a folder under
// <vault>/.clew/plugins/<id>/ with a manifest.json and up to three code
// surfaces, one per extension seam Clew already has:
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
// as the note API. Enabling is a statement of trust in the vault.
import fs from 'node:fs';
import path from 'node:path';

export const PLUGIN_API_VERSION = 1;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** All plugins present in the vault (enabled or not), manifest-validated. */
export function listPlugins(vaultRoot) {
	const dir = path.join(vaultRoot, '.clew', 'plugins');
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
	const plugins = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
		try {
			const manifest = JSON.parse(
				fs.readFileSync(path.join(dir, entry.name, 'manifest.json'), 'utf8'));
			if (manifest.id !== entry.name) continue; // folder must match id
			if ((manifest.apiVersion ?? 1) > PLUGIN_API_VERSION) continue; // too new
			const surfaces = {};
			for (const surface of ['engine', 'preview', 'app']) {
				const spec = manifest.surfaces?.[surface];
				if (!spec) continue;
				const file = typeof spec === 'string' ? spec : spec.file;
				if (typeof file !== 'string' || file.includes('..') || file.includes('/')) continue;
				if (!fs.existsSync(path.join(dir, entry.name, file))) continue;
				surfaces[surface] = typeof spec === 'string' ? { file } : { ...spec, file };
			}
			plugins.push({
				id: manifest.id,
				name: String(manifest.name ?? manifest.id),
				description: String(manifest.description ?? ''),
				version: String(manifest.version ?? '0.0.0'),
				surfaces,
			});
		} catch { /* bad manifest — not a plugin */ }
	}
	return plugins;
}

/** The enabled subset, per vault-settings. */
export function enabledPlugins(vaultRoot, vaultSettings) {
	const enabled = new Set(Array.isArray(vaultSettings?.plugins) ? vaultSettings.plugins : []);
	return listPlugins(vaultRoot).filter((p) => enabled.has(p.id));
}

/** Engine-config Extensions entries for enabled engine surfaces:
 *  "exportA, exportB from /abs/path/engine.js". */
export function engineExtensionEntries(vaultRoot, vaultSettings) {
	const entries = [];
	for (const plugin of enabledPlugins(vaultRoot, vaultSettings)) {
		const engine = plugin.surfaces.engine;
		if (!engine) continue;
		const abs = path.join(vaultRoot, '.clew', 'plugins', plugin.id, engine.file);
		const names = typeof engine.extensions === 'string' && /^[\w$, ]+$/.test(engine.extensions)
			? engine.extensions : null;
		if (names) entries.push(`${names} from ${abs}`);
	}
	return entries;
}

/** Vault-relative preview-surface script paths for enabled plugins. */
export function previewPluginPaths(vaultRoot, vaultSettings) {
	return enabledPlugins(vaultRoot, vaultSettings)
		.filter((p) => p.surfaces.preview)
		.map((p) => `.clew/plugins/${p.id}/${p.surfaces.preview.file}`);
}
