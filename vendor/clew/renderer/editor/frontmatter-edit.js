// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Writing a note's properties THROUGH ITS EDITOR: one change replacing the
// frontmatter block, so it is undoable, auto-saved like any keystroke, and
// seen by everything watching the document. Live edit's properties widget
// uses it; the serialisation is shared/frontmatter.js, the same subset the
// Properties panel writes — and the same refusal: a block that is not
// `clean` (YAML beyond the subset) is never rewritten.
import { parseProperties, serializeProperties } from '../../shared/frontmatter.js';

/**
 * The change that gives `text` these properties, or null when its
 * frontmatter must not be rewritten.
 *
 * @param {string} text - the whole note
 * @param {{key: string, value: any}[]} entries
 * @returns {{from: number, to: number, insert: string}|null}
 */
export function propertiesChange(text, entries) {
	const { end, clean } = parseProperties(text);
	if (!clean) return null;
	return { from: 0, to: end, insert: serializeProperties(entries) };
}

/**
 * Apply properties to an editor view. Returns false when refused.
 *
 * @param {import('@codemirror/view').EditorView} view
 * @param {{key: string, value: any}[]} entries
 */
export function applyPropertiesToView(view, entries) {
	const change = propertiesChange(view.state.doc.toString(), entries);
	if (!change) return false;
	view.dispatch({ changes: change, userEvent: 'input.properties' });
	return true;
}
