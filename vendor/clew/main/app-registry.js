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
import { paths } from './paths.js';
import { identityKey } from './vault-trust.js';
import { createGrantStore, grantState } from './app-grants.js';
import { appKey, resolveApp, codeHash } from './app-frames.js';

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
	byKey.set(key, { sessionId: session.id, vault, folder: found.folder, abs: found.abs, manifest: found.manifest });
	return { key, ...found };
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
	const record = grants.get(app.vault, app.manifest.id);
	let hash = null;
	const code = () => (hash ??= codeHash(app.abs));
	return { record, ...grantState(record, app.manifest, { restricted, code }), code };
}
