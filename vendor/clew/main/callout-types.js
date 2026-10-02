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
// The table (paths.faIcons, ~1.9 MB) is read the first time a definition
// exists, and never when none does: a vault with no custom types costs
// nothing at render time. Electron-free; the caller passes the file.
import fs from 'node:fs';
import { resolveCallouts } from '#jmarkdown/callout-definitions.js';
import { BUILTIN_CALLOUT_TYPES } from '#jmarkdown/callout-table.js';

let table = null;

/** The icon table, `{ version, icons: { 'solid:pencil': [w, h, d], … } }`. */
export function iconTable(file) {
	if (table) return table;
	try {
		table = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (err) {
		// A build without it (scripts/build.js writes it): every icon a
		// definition names is then reported missing, by name, in Settings.
		console.warn(`[clew] no icon table at ${file}: ${err.message}`);
		table = { version: null, icons: {} };
	}
	if (process.env.CLEW_SMOKE) console.log(`smoke-callouts: icon table loaded (${Object.keys(table.icons).length} icons)`);
	return table;
}

const isEmpty = (list) => list == null || (Array.isArray(list) && list.length === 0);
let last = { key: null, result: null };

/**
 * Both scopes merged: `{ custom, problems }` (resolveCallouts). Memoised on
 * the two lists, because every worker spawn asks.
 */
export function resolvedCallouts(globalList, vaultList, file) {
	if (isEmpty(globalList) && isEmpty(vaultList)) return { custom: {}, problems: [] };
	const key = JSON.stringify([globalList ?? null, vaultList ?? null]);
	if (key === last.key) return last.result;
	const result = resolveCallouts({
		builtins: BUILTIN_CALLOUT_TYPES,
		global: globalList ?? [],
		vault: vaultList ?? [],
		iconTable: iconTable(file).icons,
	});
	last = { key, result };
	return result;
}

/** The worker's CLEW_CALLOUTS: the resolved entries, or '' for none. */
export function calloutsEnv(globalList, vaultList, file) {
	const { custom } = resolvedCallouts(globalList, vaultList, file);
	return Object.keys(custom).length ? JSON.stringify(custom) : '';
}

/**
 * Follow a HAND edit of `<vault>/.clew/vault-settings.json`'s `callouts`
 * (the watcher never sees `.clew/`): `onChange(list)` when the list read
 * from disk differs from `current()`. Clew's own writes go through
 * VAULT_SETTINGS_SET, which updates what `current()` answers first, so they
 * come back here as no change. The folder is watched, not the file — an
 * editor that saves by rename would leave a file watch on the old inode.
 *
 * @returns {() => void} stop watching
 */
export function watchVaultCallouts(root, current, onChange) {
	const dir = `${root}/.clew`;
	let timer = null;
	let watcher = null;
	const check = () => {
		let list;
		try {
			list = JSON.parse(fs.readFileSync(`${dir}/vault-settings.json`, 'utf8'))?.callouts;
		} catch {
			return; // mid-write, or not JSON yet: the next event reads it again
		}
		if (JSON.stringify(list ?? null) === JSON.stringify(current() ?? null)) return;
		if (process.env.CLEW_SMOKE) console.log('smoke-callouts: vault file changed');
		onChange(list);
	};
	try {
		watcher = fs.watch(dir, (event, name) => {
			if (name !== 'vault-settings.json') return;
			clearTimeout(timer);
			timer = setTimeout(check, 150);
		});
		watcher.on('error', () => {});
	} catch {
		// No .clew yet, or no watching here: Settings and a reopen still work.
	}
	return () => {
		clearTimeout(timer);
		watcher?.close();
	};
}
