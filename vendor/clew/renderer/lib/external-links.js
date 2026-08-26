// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// External links clicked in rendered content. Ordinary URLs go to the OS;
// obsidian:// URLs get their Clew equivalent (src/shared/obsidian-uri.js
// makes the plan): open the note here, run the search here, take a
// show-plugin link to the plugin's web page — and name what has no
// equivalent instead of bouncing the click off a scheme handler that may
// not exist on this machine.
import { ipc, CH } from '../ipc.js';
import { vaultStore } from '../state/vault-store.js';
import * as actions from '../commands/actions.js';
import { notice } from '../plugins.js';
import { planObsidianUri } from '../../shared/obsidian-uri.js';

export function openExternal(url) {
	const plan = planObsidianUri(url);
	if (!plan) {
		ipc.invoke(CH.SHELL_OPEN_EXTERNAL, { url }).catch(() => {});
		return;
	}
	if (plan.kind === 'web') {
		ipc.invoke(CH.SHELL_OPEN_EXTERNAL, { url: plan.url }).catch(() => {});
		return;
	}
	if (plan.kind === 'open') {
		// Resolve BEFORE opening: openWikilink creates missing notes, and a
		// URI click must never conjure a file into someone's vault.
		const target = plan.file.replace(/\.md$/i, '');
		const bare = target.split('#')[0];
		if (vaultStore.resolveNoteName(bare) || vaultStore.resolveFileName(plan.file.split('#')[0])) {
			actions.openWikilink(target, { mode: 'reading' });
		} else {
			notice(`Not in this vault: ${plan.file}`);
		}
		return;
	}
	if (plan.kind === 'search') {
		document.querySelector('clew-app')?.openSearch?.();
		const input = document.querySelector('clew-search-panel .search-input');
		if (input && plan.query) {
			input.value = plan.query;
			input.dispatchEvent(new Event('input', { bubbles: true }));
		}
		return;
	}
	notice(`Clew has no equivalent of obsidian://${plan.action}`);
}
