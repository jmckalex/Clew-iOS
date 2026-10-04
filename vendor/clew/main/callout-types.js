// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Custom callout types, resolved (the engine's callout-definitions.js has the
// rules — jmarkdown a7de8c6; Clew's own copy, shared/custom-callouts.js, was
// retired with it):
// the app-global list from clew-settings.json and a vault's from its
// .clew/vault-settings.json, merged over the built-ins with the Font Awesome
// table in hand, so the render worker (CLEW_CALLOUTS) and the renderer
// (CALLOUTS_RESOLVED) each get only finished entries — label, colour, icon
// PATH — and neither ever loads the table.
//
// SHAREABLE (Clew-iOS runs it in a page with no Node): no Node built-in, no
// `process`, nothing read from disk. The caller hands in the icon table, or
// a function returning it that is called the first time a definition exists
// and never when none does — a vault with no custom types costs nothing at
// render time. The desktop's disk side (the table read from paths.faIcons,
// the watch on a vault's own file) is callout-files.js; a host that fetches
// the table asks hasCustomCallouts first and fetches only then.
import { resolveCallouts } from '#jmarkdown/callout-definitions.js';
import { BUILTIN_CALLOUT_TYPES } from '#jmarkdown/callout-table.js';

const isEmpty = (list) => list == null || (Array.isArray(list) && list.length === 0);

/** Whether either list defines anything: if not, nothing needs the table. */
export const hasCustomCallouts = (globalList, vaultList) => !(isEmpty(globalList) && isEmpty(vaultList));

let last = { key: null, result: null };

/**
 * Both scopes merged: `{ custom, problems }` (resolveCallouts). Memoised on
 * the two lists, because every worker spawn asks — so a process passes ONE
 * table.
 *
 * @param {unknown} globalList - clew-settings.json's `callouts`
 * @param {unknown} vaultList - the vault's `callouts`
 * @param {{ icons?: object } | (() => { icons?: object }) | null} icons - the
 *   icon table `{ version, icons }`, or a function returning it
 */
export function resolvedCallouts(globalList, vaultList, icons) {
	if (!hasCustomCallouts(globalList, vaultList)) return { custom: {}, problems: [] };
	const key = JSON.stringify([globalList ?? null, vaultList ?? null]);
	if (key === last.key) return last.result;
	const table = typeof icons === 'function' ? icons() : icons;
	const result = resolveCallouts({
		builtins: BUILTIN_CALLOUT_TYPES,
		global: globalList ?? [],
		vault: vaultList ?? [],
		iconTable: table?.icons ?? {},
	});
	last = { key, result };
	return result;
}

/** The worker's CLEW_CALLOUTS: the resolved entries, or '' for none. */
export function calloutsEnv(globalList, vaultList, icons) {
	const { custom } = resolvedCallouts(globalList, vaultList, icons);
	return Object.keys(custom).length ? JSON.stringify(custom) : '';
}
