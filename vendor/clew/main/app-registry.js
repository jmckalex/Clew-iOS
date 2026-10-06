// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The apps a window's notes embed (docs/dev/frame-bridge.md §7): resolved
// when a document is SERVED (protocol.js rewrites each `<clew-app-embed>`
// the engine emitted — app-embeds-rewrite below), registered here by key,
// and looked up by the clew-frame handler (which serves an app's files only
// to a key some window registered) and by the IPC the app page's bridge host
// uses. One grant store per process (app-grants.js), never written under
// the smoke harness.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';
import { identityKey } from './vault-trust.js';
import { createGrantStore, grantState } from './app-grants.js';
import { appKey, resolveApp, codeHash, parseManifest, MANIFEST } from './app-frames.js';

export const grants = createGrantStore({ file: paths.appGrants, persist: !process.env.CLEW_SMOKE });

/** key → { sessionId, vault, folder, abs, manifest } */
const byKey = new Map();

/**
 * Resolve `@app[target]` for a session: its folder and manifest, registered
 * under its key — or the refusal, by name.
 */
export function resolveFor(session, target) {
	const root = session.vaults.root;
	if (!root) return { refusal: '@app: no vault is open.' };
	const found = resolveApp(root, target, session.indexer.appFolders ?? []);
	if (found.refusal) return found;
	const vault = identityKey(root);
	const key = appKey(vault, found.manifest.id);
	const known = byKey.get(key);
	byKey.set(key, { sessionId: session.id, vault, folder: found.folder, abs: found.abs, manifest: found.manifest,
		manifestMtime: mtimeOf(found.abs), served: known?.served ?? null });
	return { key, ...found };
}

const mtimeOf = (abs) => { try { return fs.statSync(path.join(abs, MANIFEST)).mtimeMs; } catch { return null; } };

/** Re-read an app's manifest when its file changed: what it asks for — and
 *  above all which hosts — is the file's NOW, not the note's last render. */
function freshManifest(app) {
	const mtime = mtimeOf(app.abs);
	if (mtime === null || mtime === app.manifestMtime) return;
	app.manifestMtime = mtime;
	try {
		const { manifest } = parseManifest(fs.readFileSync(path.join(app.abs, MANIFEST), 'utf8'));
		if (manifest && manifest.id === app.manifest.id) app.manifest = manifest;
	} catch { /* mid-write: read again next time */ }
}

/** What an app's frame was last served with (protocol.js): its hosts. */
export function noteServed(app, network) {
	app.served = JSON.stringify(network ?? null);
}

/**
 * A vault file changed (session.js): the keys of this window's apps whose
 * manifest it is and whose running frames now differ from the grant — hosts
 * narrowed or widened, or something new to ask. Their frames must reload.
 */
export function manifestTouched(sessionId, rel, restricted) {
	const out = [];
	for (const [key, app] of byKey) {
		if (app.sessionId !== sessionId || `${app.folder}/${MANIFEST}` !== rel) continue;
		const st = stateOf(app, restricted);
		if (st.ask.length || (app.served !== null && JSON.stringify(st.network ?? null) !== app.served)) out.push(key);
	}
	return out;
}

/** The registered app behind a clew-frame key, or null. */
export function appByKey(key) {
	return byKey.get(String(key ?? '').toLowerCase()) ?? null;
}

/** Everything registered for one window (its Settings, a revoke). */
export function appsForSession(sessionId) {
	return [...byKey.entries()].filter(([, a]) => a.sessionId === sessionId).map(([key, a]) => ({ key, ...a }));
}

/** Forget a closed window's apps. */
export function dropSession(sessionId) {
	for (const [key, a] of byKey) if (a.sessionId === sessionId) byKey.delete(key);
}

/** The grant state of a registered app, for the window that has it. */
export function stateOf(app, restricted) {
	freshManifest(app);
	const record = grants.get(app.vault, app.manifest.id);
	let hash = null;
	const code = () => (hash ??= codeHash(app.abs));
	return { record, ...grantState(record, app.manifest, { restricted, code }), code };
}
