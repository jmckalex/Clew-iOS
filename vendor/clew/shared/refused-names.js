// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What the engine refused to run in a rendered document, by name: the
// `data-jmd-refused` attribute on each marker jmarkdown's note-code.js
// leaves where a note's code would have run (`Run note code` off). Shared so
// every render service — desktop's, and the iOS port's — reads the same
// markers the same way (main/render-service.js#noteRefusals).

const ENTITIES = { '&quot;': '"', '&lt;': '<', '&gt;': '>', '&amp;': '&' };

/** Distinct refused names in `html`, in document order. */
export function refusedNames(html) {
	const names = [...String(html).matchAll(/data-jmd-refused="([^"]*)"/g)]
		.map((m) => m[1].replace(/&(?:quot|lt|gt|amp);/g, (e) => ENTITIES[e]));
	return [...new Set(names)];
}
