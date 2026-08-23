// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The only module that touches window.clew (the preload bridge).
// Everything else goes through these wrappers or the stores.
import { CH } from '../shared/channels.js';

const bridge = window.clew;

export const ipc = {
	invoke: (channel, payload) => bridge.invoke(channel, payload),
	on: (channel, fn) => bridge.on(channel, fn),
};

export { CH };
