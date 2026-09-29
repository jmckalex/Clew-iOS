// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Every live PDF viewer in this document (pdf-core.js adds each handle once
// its viewer is built and removes it on dispose): `{ target, container, … }`,
// where `container.shadowRoot` holds the viewer's scrollers and
// `container.registry` resolves to its plugin registry. A module of its own so
// pdf-core.js and the modules that act on its viewers (pdf-pen.js) share it
// without importing each other. Also on `window.__clewPdfHandles` — the name
// the iOS port's build patch used, kept so its own modules and smoke checks
// keep working.
export const viewerHandles = new Set();
window.__clewPdfHandles = viewerHandles;
