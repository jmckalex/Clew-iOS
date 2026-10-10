// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The font FAMILIES a figure names for fontspec — `\setmainfont{Optima}`,
// `\newfontfamily\head{Gill Sans}[…]` — which the machine's own fonts must
// supply (main/system-fonts.js; the preview client and the site export's bake
// hand them over). A name with a font file's extension is a FILE (Clew's note
// faces, or the author's own), never looked up as a family. Pure and
// import-free: the preview client and main import it beside the worker, as
// they do metapost-words.js.

const COMMAND = /\\(setmainfont|setsansfont|setmonofont|setmathfont|fontspec|(?:newfontfamily|newfontface|setfontfamily)\s*\\[A-Za-z@]+)\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}/g;

/** The distinct family names `text` asks fontspec for, as written. */
export function namedFontFamilies(text) {
	const out = new Set();
	for (const m of String(text ?? '').matchAll(COMMAND)) {
		const name = m[2].trim();
		if (!name || /\.(ttf|otf|ttc|otc)$/i.test(name) || /[\\[\]]/.test(name)) continue;
		out.add(name);
	}
	return [...out];
}
