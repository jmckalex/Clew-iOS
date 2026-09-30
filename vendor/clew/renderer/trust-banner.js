// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// "This vault's notes asked to run code. [Trust this vault]" — the interim
// vault-trust guard's one piece of chrome (main/vault-trust.js). A vault this
// device has not trusted renders with the engine's `Run note code` off, and
// the engine refuses each construct BY NAME in the note itself; this banner
// appears only once something actually WAS refused (render-service.js tells
// the window), so a vault with no note code never sees it (owner's Q10).
//
// Drawn by the app page, never inside a preview, where a note could imitate
// it. It sits in the notices column (plugins.js#notice) as a persistent item,
// so a passing notice never lands on top of it. Trust is set from here and
// from Settings → This vault; revoking lives there. The full trust design
// (frame-bridge.md §4.5) replaces this with its prompt and status-bar
// indicator — same store, same identity.
import { ipc, CH } from './ipc.js';

let trusted = true;
let dismissed = false;
let names = [];
let banner = null;

function host() {
	let el = document.querySelector('.clew-notices');
	if (!el) {
		el = document.createElement('div');
		el.className = 'clew-notices';
		document.body.append(el);
	}
	return el;
}

function hide() {
	banner?.remove();
	banner = null;
}

function show() {
	if (trusted || dismissed || names.length === 0) return hide();
	if (!banner) {
		banner = document.createElement('div');
		banner.className = 'clew-notice clew-trust-banner';
		banner.setAttribute('role', 'status');
		const text = document.createElement('span');
		text.className = 'clew-trust-text';
		const trustButton = document.createElement('button');
		trustButton.className = 'clew-trust-button';
		trustButton.textContent = 'Trust this vault';
		trustButton.addEventListener('click', () => {
			trustButton.disabled = true;
			ipc.invoke(CH.VAULT_TRUST_SET, { trusted: true })
				.catch(() => { trustButton.disabled = false; });
		});
		const close = document.createElement('button');
		close.className = 'clew-trust-dismiss';
		close.textContent = '×';
		close.title = 'Dismiss (Settings → This vault can still trust it)';
		close.setAttribute('aria-label', 'Dismiss');
		close.addEventListener('click', () => {
			dismissed = true;
			hide();
		});
		banner.append(text, trustButton, close);
		host().prepend(banner);
	}
	const listed = names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : '');
	banner.querySelector('.clew-trust-text').textContent = `This vault's notes asked to run code (${listed}).`;
	banner.title = `Not run: ${names.join(', ')}`;
}

function addNames(more) {
	names = [...new Set([...names, ...more])];
	show();
}

/** A vault is on screen (opened, or the window reloaded): start over. */
export function trustBannerVaultShown() {
	dismissed = false;
	names = [];
	trusted = true;
	hide();
	ipc.invoke(CH.VAULT_TRUST_GET).then((state) => {
		trusted = state?.trusted === true;
		addNames(state?.refused ?? []);
	}).catch(() => {});
}

export function installTrustBanner() {
	ipc.on(CH.EV_NOTE_CODE_REFUSED, ({ names: refused }) => {
		trusted = false;
		addNames(refused ?? []);
	});
	ipc.on(CH.EV_VAULT_TRUST_CHANGED, ({ trusted: now }) => {
		trusted = now === true;
		if (trusted) names = [];
		show();
	});
}
