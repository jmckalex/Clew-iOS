// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The one memoised scan of a document. The overlay, folding and live edit
// all want `scanJmarkdown(doc)` for the same document version; a CodeMirror
// `Text` is immutable, so the Text itself is the cache key and a WeakMap
// lets a superseded version go with its scan. Scanning twice per keystroke
// was the cost this removes — and one scan is also what guarantees the
// consumers agree about where a construct is.
//
// Whole-document only: the overlay's degraded windowed scan past BIG_DOC
// is keyed by viewport as well, so it stays the overlay's own.
import { scanJmarkdown } from './jmarkdown-scan.js';

/** @type {WeakMap<import('@codemirror/state').Text, import('./jmarkdown-scan.js').JmarkdownScan>} */
const scans = new WeakMap();

/**
 * The scanner's result for this document version.
 *
 * @param {import('@codemirror/state').Text} doc
 * @returns {import('./jmarkdown-scan.js').JmarkdownScan}
 */
export function scanFor(doc) {
	let scan = scans.get(doc);
	if (!scan) {
		scan = scanJmarkdown(doc.toString());
		scans.set(doc, scan);
	}
	return scan;
}
