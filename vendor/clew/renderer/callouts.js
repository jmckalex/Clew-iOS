// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Custom callout types in this window (Settings → Callouts; the engine's
// callout-definitions.js has the rules, main/callout-types.js resolves them):
// the resolved table installed into the ENGINE's callout-table.js (jmarkdown
// a7de8c6, import-free so this bundle can take it) — the one table live
// edit's heads, the toolbar's callout menu and the palette's "Insert …
// callout" commands read — at boot, on a vault arriving, and whenever main
// says the definitions changed (Settings in any window for the global list,
// this vault's list or a hand edit of its vault-settings.json). Live
// editors are then rebuilt; reading views re-render from main's side
// (render-service reconfigure), so nothing here touches a preview.
import { ipc, CH } from './ipc.js';
import { vaultStore } from './state/vault-store.js';
import { applyCustomCallouts, CALLOUT_TYPES } from '#jmarkdown/callout-table.js';
import { editorPool } from './editor/pool.js';
import { syncCalloutCommands } from './commands/format.js';

let problems = [];
let last = '';
const listeners = new Set();

/** Why entries were skipped, or notes about them: {scope, index, name, reason, skipped}[]. */
export function calloutProblems() {
	return problems;
}

/** Call `listener()` after every sync. Returns the unsubscribe. */
export function onCalloutsSynced(listener) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Ask main for the resolved table and install it. */
export async function syncCallouts() {
	let answer;
	try {
		answer = await ipc.invoke(CH.CALLOUTS_RESOLVED);
	} catch {
		answer = { custom: {}, problems: [] };
	}
	problems = answer?.problems ?? [];
	const table = JSON.stringify(answer?.custom ?? {});
	if (table !== last) {
		last = table;
		applyCustomCallouts(answer?.custom ?? {});
		syncCalloutCommands(CALLOUT_TYPES);
		editorPool.rebuildLive();
	}
	for (const listener of listeners) listener();
}

export function installCalloutSync() {
	ipc.on(CH.EV_CALLOUTS_CHANGED, () => { syncCallouts(); });
	vaultStore.on('vault-changed', () => { syncCallouts(); });
	syncCallouts();
}
