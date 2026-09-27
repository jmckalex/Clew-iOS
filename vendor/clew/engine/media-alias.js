// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Obsidian media-embed alias: the segment after the last '|' may be a size —
 * "300" (width) or "300x200" (width × height) — with any earlier segments
 * forming the alt text: ![[img.png|300]], ![[img.png|A caption|300]].
 * Returns { alt, width, height } (alt null when the alias was only a size).
 */
export function parseMediaAlias(alias) {
	if (!alias) return { alt: null, width: null, height: null };
	const parts = alias.split('|').map((s) => s.trim());
	const m = /^(\d+)(?:x(\d+))?$/.exec(parts[parts.length - 1]);
	if (!m) return { alt: alias, width: null, height: null };
	return {
		alt: parts.slice(0, -1).join('|') || null,
		width: Number(m[1]),
		height: m[2] ? Number(m[2]) : null,
	};
}
