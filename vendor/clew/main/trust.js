// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The device's trust store (vault-trust.js), one per process — every window
// asks the same one. Under the smoke harness nothing is written, as with
// settings.js: a scenario's decisions must never reach the user's userData.
import { paths } from './paths.js';
import { createTrustStore } from './vault-trust.js';

export const trust = createTrustStore({ file: paths.vaultTrust, persist: !process.env.CLEW_SMOKE });

// The one-time notice (frame-bridge.md §4.8): the first launch with the full
// trust design tells its user what changed and where Trusted vaults live.
// main.js decides at launch (trust.takeNotice — once per store, never under
// the smoke harness unless CLEW_SMOKE_TRUST_NOTICE asks); the first window
// to ask for its trust state receives it, and nobody after.
let notice = null;
export function setTrustNotice(payload) { notice = payload; }
export function takeTrustNotice() {
	const out = notice;
	notice = null;
	return out;
}
