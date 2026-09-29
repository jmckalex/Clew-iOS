// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later


// The edges a floater may use: the VISUAL viewport's, in the layout
// coordinates getBoundingClientRect answers in. On desktop the two viewports
// agree (Electron keeps visual zoom at 1 and the app page never scrolls), so
// this is window.innerWidth/innerHeight; in a WKWebView the software keyboard
// shrinks only the visual viewport, and "below the anchor" measured against
// innerHeight landed under the keyboard (the iOS port's report).
export function viewportEdges() {
	const vv = window.visualViewport;
	return vv
		? { right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height }
		: { right: window.innerWidth, bottom: window.innerHeight };
}
