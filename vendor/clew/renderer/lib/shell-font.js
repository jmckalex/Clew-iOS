// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The shell panel's font list (components/workspace/clew-shell-panel.js).
// Pure, so tests/shell-font.test.js runs it under plain node.

// Faces that carry the Powerline / Nerd Font symbols prompts draw with — the
// branch mark U+E0A0 and the rest of the private-use area, which no system
// font has, so without one of these a themed prompt is a row of boxes (the
// owner's report, 2026-09-30). They come AFTER the grid's own font: the cell
// is still measured from a monospace face, and the browser falls back glyph
// by glyph, so only what the first font lacks is drawn from these — from
// whichever is installed (a family that is not is simply skipped). The
// "Mono" builds first: their symbols are one cell wide, as a grid wants.
const SYMBOL_FACES = [
	'Symbols Nerd Font Mono', 'Hack Nerd Font Mono', 'MesloLGS NF', 'MesloLGS Nerd Font Mono',
	'JetBrainsMono Nerd Font Mono', 'FiraCode Nerd Font Mono', 'SauceCodePro Nerd Font Mono',
	'Fira Mono for Powerline', 'Meslo LG S for Powerline', 'Menlo for Powerline',
	'DejaVu Sans Mono for Powerline', 'Source Code Pro for Powerline',
	'Symbols Nerd Font', 'Hack Nerd Font',
];

const quoted = (family) => (/^['"]|^[\w-]+$/.test(family) ? family : `'${family.replace(/'/g, '')}'`);

/**
 * The grid's font list: the `shellFont` setting when there is one (a family,
 * or a CSS list as typed), then Clew's monospace face, then the symbol faces,
 * then `monospace`. MONOSPACE first, and not the editor's face: xterm draws a
 * grid — it measures one cell from the font and places every character in its
 * own cell, so a proportional family (Clew's editor font is Avenir Next)
 * leaves a visible gap around each letter (the owner's report, 2026-09-25).
 */
export function gridFontFamily(shellFont, monoVar) {
	const own = String(shellFont ?? '').trim();
	const mono = String(monoVar || "'SF Mono', Menlo").replace(/,\s*monospace\s*$/i, '');
	const head = own ? (own.includes(',') ? own : quoted(own)) : null;
	return [head, mono, ...SYMBOL_FACES.map(quoted), 'monospace'].filter(Boolean).join(', ');
}
