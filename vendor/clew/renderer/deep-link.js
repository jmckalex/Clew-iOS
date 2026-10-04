// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What a clew:// link or the `clew` command left for this window to show
// (main/deep-link-host.js): a note (at a heading or a line), or a command
// (today's diary entry), and a notice saying where it came from. Taken from
// main ONCE (DEEP_LINK_TAKE), and only once the window has put its vault on
// screen — taken earlier, the workspace's restore would replace it.
import { ipc, CH } from './ipc.js';
import { workspaceStore } from './state/workspace-store.js';
import { vaultStore } from './state/vault-store.js';
import { jumpToHeading, jumpToLine } from './commands/actions.js';
import { notice } from './plugins.js';

let shown = false;
// What was applied, and when: a window puts its vault on screen TWICE as it
// starts (its own boot, then main's vault-opened — main.js#showVault), and
// the second's workspace restore would replace what a link opened after the
// first. Links applied moments ago are applied again (opening an open note
// reuses its tab; the jump repeats), their notices not said twice.
const RECENT_MS = 8000;
let recent = { links: [], at: 0 };

async function takeDeepLink() {
	const links = await ipc.invoke(CH.DEEP_LINK_TAKE).catch(() => []);
	if (Date.now() - recent.at < RECENT_MS) {
		for (const link of recent.links) await apply({ ...link, notice: null }).catch(() => {});
	}
	if (links?.length) recent = { links, at: Date.now() };
	for (const link of links ?? []) await apply(link).catch((err) => console.warn('[clew] link:', err?.message ?? err));
}

async function apply(link) {
	if (link.daily) {
		const { openDiaryDay } = await import('./commands/diary.js');
		await openDiaryDay(new Date(), { newTab: true });
	} else if (link.note) {
		// A note main has just created reaches this window's tree a moment
		// after the link does.
		for (let i = 0; i < 30 && !vaultStore.pathExists(link.note); i++) await new Promise((r) => setTimeout(r, 100));
		if (!vaultStore.pathExists(link.note)) {
			notice(`No note "${link.note}" in this vault.`, 6000);
			return;
		}
		// A tab of its own — a link from outside never replaces the note being
		// worked on — or the tab already showing it.
		const tab = /\.(md|jmd)$/i.test(link.note) ? workspaceStore.openNote(link.note, { newTab: true }) : workspaceStore.openFile(link.note, { newTab: true });
		if (tab && link.heading) jumpToHeading(tab, link.note, link.heading);
		else if (tab && link.line) jumpToLine(tab.id, link.line);
	}
	if (link.notice) notice(link.notice, 5000);
	if (window.__clewSmokeLinks !== undefined) window.__clewSmokeLinks.push(link);
}

/** The window has put its vault on screen (main.js#showVault). */
export function vaultShownForLinks() {
	shown = true;
	takeDeepLink();
}

export function installDeepLinks() {
	ipc.on(CH.EV_VAULT_OPENED, () => { shown = false; });
	ipc.on(CH.EV_DEEP_LINK, (payload) => {
		if (payload?.notice) notice(payload.notice, 7000);
		if (shown) takeDeepLink();
	});
}
