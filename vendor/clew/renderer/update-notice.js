// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What the update check says in the window (docs/dev/auto-update.md §4): a
// notice that stays, not a modal — "Clew 0.13.0 is available. What's new ·
// Download · Skip this version". Download opens THIS machine's file in the
// browser; nothing installs, nothing restarts. Help → Check for Updates…
// (`app:check-updates`) always answers, up to date or not.
import { ipc, CH } from './ipc.js';
import { notice } from './plugins.js';

let shown = null;

function host() {
	let el = document.querySelector('.clew-notices');
	if (!el) {
		el = document.createElement('div');
		el.className = 'clew-notices';
		document.body.append(el);
	}
	return el;
}

/** The "available" notice, once per version. */
export function showUpdate(result) {
	if (!result || result.status !== 'available') return;
	if (shown?.dataset.version === result.version) return;
	shown?.remove();
	const note = document.createElement('div');
	note.className = 'clew-notice clew-trust-banner clew-update-notice';
	note.setAttribute('role', 'status');
	note.dataset.version = result.version;
	const text = document.createElement('span');
	text.textContent = `Clew ${result.version} is available.`;
	const button = (label, cls, fn) => {
		const b = document.createElement('button');
		b.className = cls;
		b.textContent = label;
		b.addEventListener('click', fn);
		return b;
	};
	const open = (url) => { if (url) ipc.invoke(CH.SHELL_OPEN_EXTERNAL, { url }).catch(() => {}); };
	note.append(text);
	if (result.notes) note.append(button('What\'s new', 'clew-trust-keep', () => open(result.notes)));
	if (result.download) note.append(button('Download', 'clew-trust-button', () => open(result.download)));
	note.append(button('Skip this version', 'clew-trust-keep', () => {
		ipc.invoke(CH.UPDATE_SKIP, { version: result.version }).catch(() => {});
		note.remove();
		shown = null;
	}));
	note.append(button('×', 'clew-trust-dismiss', () => { note.remove(); shown = null; }));
	host().prepend(note);
	shown = note;
}

/** Help → Check for Updates…: ask now, and always say what came of it. */
export async function checkForUpdatesNow() {
	const result = await ipc.invoke(CH.UPDATE_CHECK).catch((err) => ({ status: 'failed', reason: String(err?.message ?? err) }));
	if (result.status === 'available') showUpdate(result);
	else if (result.status === 'current') notice(`Clew is up to date${result.version ? ` (the newest is ${result.version})` : ''}.`, 5000);
	else if (result.status === 'off') notice(`Clew does not check for updates here: ${result.reason}.`, 6000);
	else notice(`Could not check for updates${result.reason ? ` (${result.reason})` : ''}.`, 6000);
	return result;
}

export function installUpdateNotice() {
	ipc.on(CH.EV_UPDATE_AVAILABLE, showUpdate);
}
