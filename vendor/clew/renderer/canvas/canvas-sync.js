// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Live sync between canvas views of the same file (e.g. two splits): the
// view that mutates broadcasts its serialized doc immediately; sibling views
// adopt it without waiting for the file watcher round trip.
import { Emitter } from '../lib/emitter.js';

/** emits 'doc-changed' { path, text, source } */
export const canvasSyncBus = new Emitter();
