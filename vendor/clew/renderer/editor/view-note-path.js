// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Which note each view shows — the pool says (pool.js), since a state
// outlives any one path and a view is re-pointed on navigation and rename.
// No imports, so anything (a completion source under plain node) can ask.
const notePaths = new WeakMap();
export function setViewNotePath(view, path) { notePaths.set(view, path); }
/** The note a view shows (null before the pool has said). */
export const viewNotePath = (view) => notePaths.get(view) ?? null;
