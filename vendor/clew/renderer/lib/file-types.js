// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Moved to src/shared/ when the WATCHER began classifying files too (main
// cannot import a renderer module, and two copies of "what is an image"
// would drift). Re-exported from here so the renderer's own imports read
// as they always did.
export * from '../../shared/file-types.js';
