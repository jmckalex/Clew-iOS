// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Where the note's text is literal — code, maths, raw HTML, the metadata
// header — so that `//` there is not the menu (complete/slash-commands.js)
// and `[[x]]` there is not a link to preview (link-hover.js).
import { syntaxTree } from '@codemirror/language';
import { scanFor } from './jmd/scan-cache.js';

const LITERAL_NODES = new Set(['FencedCode', 'CodeText', 'InlineCode', 'JmdMath', 'HTMLBlock', 'CommentBlock']);

/**
 * @param {import('@codemirror/state').EditorState} state
 * @param {number} pos
 * @returns {boolean}
 */
export function literalAt(state, pos) {
	for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
		if (LITERAL_NODES.has(node.name)) return true;
	}
	// The metadata header / frontmatter is the scanner's, not lezer's.
	return scanFor(state.doc).constructs.some((c) => c.kind === 'metaHeader' && pos > c.start && pos <= c.end);
}
