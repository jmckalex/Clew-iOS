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
