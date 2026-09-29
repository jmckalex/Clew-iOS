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
 * @file Highlighting for ```tabbing fences (src/engine/tabbing.js): the tab
 * commands stand out from the text they arrange, so a row reads as its
 * columns. A stream-parser spec, pure like tex-mode.js.
 *
 *   |= |> |< |+ |- |' |` |[ |]  …|kill     → keyword   (the marks)
 *   \= \> \< \+ \- \' \` \\ \kill \pushtabs \poptabs  → keyword (LaTeX's)
 *   \a= \a' \a`                          → atom      (the accents)
 *   $…$                                  → string    (maths, marks and all)
 *   \|                                   → escape
 */
const MARKS = /^\|(?:kill\s*$|[=><+\-'`[\]])/;
const COMMANDS = /^\\(?:pushtabs|poptabs|kill)(?![A-Za-z])|^\\[=><+\-'`\\]/;

export function tabbingToken(stream) {
	if (stream.match(MARKS)) return 'keyword';
	if (stream.match(/^\\a[='`]/)) return 'atom';
	if (stream.match(COMMANDS)) return 'keyword';
	if (stream.match('\\|')) return 'escape';
	if (stream.peek() === '$') {
		if (stream.match(/^\$\$.*?\$\$/) || stream.match(/^\$[^$]*\$/)) return 'string';
	}
	stream.next();
	// Plain text up to the next character that could start something.
	stream.eatWhile(/[^|\\$]/);
	return null;
}

export const tabbingMode = {
	name: 'tabbing',
	startState: () => ({}),
	copyState: () => ({}),
	token: tabbingToken,
};
