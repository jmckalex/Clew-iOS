// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Apps in notes (docs/dev/frame-bridge.md §7–§9, with R1–R3): the pure half.
// An app is a vault FOLDER holding `clew-app.json`; `@app[Apps/Timer]` embeds
// it. It runs on an origin of its own, `clew-frame://<key>`, where <key> is
// derived by Clew from the device-side vault identity and the manifest's
// `id` (R3) — never the folder path, so a moved or renamed app keeps its
// origin, storage and grants; two folders claiming one id are BOTH refused.
//
// Electron-free: main/app-registry.js and protocol.js apply it;
// tests/app-frames.test.js holds it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const FRAME_SCHEME = 'clew-frame';
export const MANIFEST = 'clew-app.json';
export const DATA_DIR = 'data';

/** 1–64 of a-z 0-9 . _ -, starting with a letter or digit (R3). */
export const APP_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Every capability a manifest may name (§9), and what the grant prompt says
 * about it. `network` (R2) changes the app's CSP rather than unlocking a
 * method. The write side (note.write … editor.insert) is phase 4's.
 */
export const CAPABILITIES = Object.freeze({
	'note.read': 'read this note',
	'notes.read': 'read the notes in this vault',
	'query': 'search this vault and read its index',
	'app.kv': 'keep a little data of its own (which travels with the vault)',
	'app.files': 'keep files of its own in its data folder (which travel with the vault)',
	'links.open': 'open notes and links',
	'note.write': 'edit this note',
	'notes.write': 'edit the notes in this vault',
	'notes.create': 'create notes',
	'editor.insert': 'insert text where you are typing',
	'find': 'take part in Find',
	'clipboard': 'copy and paste through Clew',
	'network': 'send data to the internet',
});

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** An http(s) origin, as `scheme://host[:port]`, or null. */
function originOf(value) {
	try {
		const url = new URL(String(value));
		if (!/^https?:$/.test(url.protocol)) return null;
		return url.origin;
	} catch {
		return null;
	}
}

/**
 * A manifest's text, checked. Refused BY NAME, never half-read.
 * @returns {{ manifest: { id, name, version, entry, capabilities: string[],
 *   network: null | '*' | string[] } } | { refusal: string }}
 */
export function parseManifest(text) {
	let raw;
	try { raw = JSON.parse(text); } catch (err) {
		return { refusal: `its ${MANIFEST} is not valid JSON (${String(err.message).slice(0, 80)})` };
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { refusal: `its ${MANIFEST} is not an object` };
	const id = typeof raw.id === 'string' ? raw.id : '';
	if (!APP_ID_RE.test(id)) {
		return { refusal: `its id ${JSON.stringify(raw.id ?? null)} is not 1–64 of a–z, 0–9, ".", "_", "-", starting with a letter or digit` };
	}
	const entry = raw.entry === undefined ? 'index.html' : raw.entry;
	if (typeof entry !== 'string' || !/\.html?$/i.test(entry) || entry.startsWith('/') || entry.split(/[\\/]/).includes('..')) {
		return { refusal: `its entry ${JSON.stringify(entry)} is not an HTML file inside the app's folder` };
	}
	const caps = raw.capabilities === undefined ? [] : raw.capabilities;
	if (!Array.isArray(caps) || caps.some((c) => typeof c !== 'string')) return { refusal: 'its capabilities are not a list of names' };
	const unknown = caps.filter((c) => !(c in CAPABILITIES));
	if (unknown.length) return { refusal: `it asks for ${unknown.map((c) => `"${c}"`).join(', ')}, which ${unknown.length === 1 ? 'is not a capability' : 'are not capabilities'} Clew knows` };
	let network = null;
	if (caps.includes('network')) {
		if (raw.network === undefined) network = '*';
		else if (Array.isArray(raw.network)) {
			const origins = raw.network.map(originOf);
			if (origins.some((o) => !o) || origins.length === 0) return { refusal: 'its "network" list must name http(s) origins' };
			network = [...new Set(origins)];
		} else return { refusal: 'its "network" must be a list of http(s) origins' };
	} else if (raw.network !== undefined) {
		return { refusal: 'it names "network" origins without asking for the "network" capability' };
	}
	return {
		manifest: {
			id,
			name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : id,
			version: typeof raw.version === 'string' ? raw.version.slice(0, 40) : '0.0.0',
			entry: entry.replace(/^\.\//, ''),
			capabilities: [...new Set(caps)],
			network,
		},
	};
}

/** The origin's host for an app: hash(vault identity, manifest id), a DNS
 *  label of lowercase hex. Never chosen by the vault (R3). */
export function appKey(vaultIdentity, id) {
	return crypto.createHash('sha256').update(`${vaultIdentity}\0${id}`, 'utf8').digest('hex').slice(0, 40);
}

/**
 * The vault's apps, from the folders holding a manifest: id → [folders].
 * More than one folder for an id is the duplicate R3 refuses (both).
 * @param {string} root
 * @param {Iterable<string>} folders vault-relative folders holding clew-app.json
 */
export function appsById(root, folders) {
	const byId = new Map();
	for (const folder of folders) {
		let id = null;
		try { id = JSON.parse(fs.readFileSync(path.join(root, folder, MANIFEST), 'utf8'))?.id; } catch { /* refused when embedded */ }
		if (typeof id !== 'string' || !APP_ID_RE.test(id)) continue;
		if (!byId.has(id)) byId.set(id, []);
		byId.get(id).push(folder);
	}
	for (const list of byId.values()) list.sort();
	return byId;
}

/**
 * What an `@app[target]` names, resolved against the vault: the folder, its
 * manifest — or the refusal, BY NAME (§7).
 * @returns {{ folder, abs, manifest } | { refusal }}
 */
export function resolveApp(root, target, appFolders) {
	const clean = String(target ?? '').trim().replace(/^\.?\//, '').replace(/\/+$/, '');
	if (!clean) return { refusal: '@app needs a target: a folder in this vault holding clew-app.json.' };
	if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) return { refusal: `@app[${clean}]: remote apps are not supported yet — an app is a folder in this vault.` };
	if (clean.split('/').includes('..')) return { refusal: `@app[${clean}] climbs out of the vault.` };
	const abs = path.join(root, clean);
	let stat = null;
	try { stat = fs.statSync(abs); } catch { /* not there */ }
	if (!stat) return { refusal: `@app found nothing at "${clean}" in this vault.` };
	if (!stat.isDirectory()) return { refusal: `@app[${clean}] is a file; an app is a folder holding ${MANIFEST}.` };
	let text;
	try { text = fs.readFileSync(path.join(abs, MANIFEST), 'utf8'); } catch {
		return { refusal: `@app[${clean}]: the folder has no ${MANIFEST}.` };
	}
	const parsed = parseManifest(text);
	if (parsed.refusal) return { refusal: `@app[${clean}] is not an app: ${parsed.refusal}.` };
	const others = (appsById(root, appFolders).get(parsed.manifest.id) ?? []).filter((f) => f !== clean);
	if (others.length) {
		return { refusal: `Two apps in this vault say they are "${parsed.manifest.id}": ${[clean, ...others].sort().join(', ')} — give one a new id in its ${MANIFEST}.` };
	}
	if (!fs.existsSync(path.join(abs, parsed.manifest.entry))) {
		return { refusal: `@app[${clean}]: its entry "${parsed.manifest.entry}" is not in the folder.` };
	}
	return { folder: clean, abs, manifest: parsed.manifest };
}

/**
 * The file an app's URL path names, inside its folder by REALPATH (a link
 * in the folder cannot reach outside it), or null.
 */
export function appFile(folderAbs, urlPath) {
	let rel;
	try { rel = decodeURIComponent(String(urlPath)).replace(/^\/+/, ''); } catch { return null; }
	if (!rel || rel.includes('\0')) return null;
	let root;
	try { root = fs.realpathSync(folderAbs); } catch { return null; }
	let real;
	try { real = fs.realpathSync(path.resolve(root, rel)); } catch { return null; }
	if (real !== root && !real.startsWith(root + path.sep)) return null;
	try { if (!fs.statSync(real).isFile()) return null; } catch { return null; }
	return real;
}

/**
 * An app document's CSP (R2, with the owner's choice A): everything 'self'
 * by default — no fetch, beacon, socket, image, frame or font from another
 * host, no form posted anywhere — inline script and eval allowed, because
 * the app's own code is the point. `network` (granted) opens the fetch
 * family to the granted origins, or to any host.
 */
export function appCsp({ network = null } = {}) {
	const hosts = network === '*' ? ['https:', 'http:', 'wss:', 'ws:'] : Array.isArray(network) ? network : [];
	const open = (base) => [base, ...hosts].join(' ');
	return [
		`default-src ${open("'self' data: blob:")}`,
		`script-src ${open("'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:")}`,
		`style-src ${open("'self' 'unsafe-inline'")}`,
		`connect-src ${open("'self' data: blob:")}`,
		`form-action ${hosts.length ? hosts.join(' ') : "'none'"}`,
		"base-uri 'self'",
		"frame-ancestors clew-preview://vault clew-app://app",
	].join('; ');
}

/** The bridge client every app document gets, first thing in <head>. */
export function injectBridge(html, src = '/__clew_bridge__.js') {
	const tag = `<script src="${escape(src)}"></script>`;
	if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${tag}`);
	if (/<html[^>]*>/i.test(html)) return html.replace(/<html([^>]*)>/i, `<html$1><head>${tag}</head>`);
	return tag + html;
}

/**
 * A hash of the app's CODE — every file in its folder but `data/` — for
 * choice C: in a restricted vault an app holding `network` is pinned to the
 * code that was approved, and new code asks again.
 */
export function codeHash(folderAbs) {
	const hash = crypto.createHash('sha256');
	const walk = (dir, rel) => {
		let entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (!rel && entry.name === DATA_DIR) continue;
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(abs, childRel);
			else if (entry.isFile()) {
				hash.update(`${childRel}\0`);
				try { hash.update(fs.readFileSync(abs)); } catch { /* unreadable: its name still counts */ }
				hash.update('\0');
			}
		}
	};
	walk(folderAbs, '');
	return hash.digest('hex');
}

/** The prompt's words for a list of capabilities (§9). */
export function describeCapabilities(caps, network = null) {
	return caps.map((c) => {
		if (c === 'network' && Array.isArray(network)) return `send data to ${network.map((o) => new URL(o).host).join(', ')}`;
		if (c === 'network') return 'send data to any host on the internet';
		return CAPABILITIES[c] ?? c;
	});
}
