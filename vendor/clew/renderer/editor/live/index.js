// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Live edit: the note editor with its markdown syntax concealed and the
// result drawn in place, except where the cursor is (docs/dev/live-edit.md).
//
// It is NOT a second editor. It is this bundle of extensions, swapped into
// the pooled EditorView's `liveCompartment` (editor.js) by
// editorPool.setMode — the same document, the same undo history, the same
// view. Turning it off reconfigures the compartment to nothing, which unloads
// every field and plugin below: no decoration set lingers.
import { Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { liveConfigFacet } from './config.js';
import { liveStateField } from './reveal-field.js';
import { inlineLayer } from './inline-layer.js';
import { blockField, calloutFoldField } from './block-field.js';
import { frameHeightField } from './frames.js';
import { frameLayer } from './frame-layer.js';
import { liveEvents } from './events.js';
import { tableEditing } from './table-cell-editor.js';
import { liveKeys } from './keys.js';
import { sidenotes } from './sidenotes.js';

/** The compartment every note state carries (empty in source mode). */
export const liveCompartment = new Compartment();

/**
 * The live-edit extension bundle.
 *
 * @param {import('./config.js').LiveConfig} config
 * @returns {import('@codemirror/state').Extension}
 */
export function liveEdit(config) {
	return [
		liveConfigFacet.of(config),
		// The one marker source-mode CSS and scenarios key on.
		EditorView.editorAttributes.of({ class: 'cm-live' }),
		// Before liveStateField: the reveal rule reads the active cell.
		tableEditing,
		liveStateField,
		calloutFoldField,
		frameHeightField,
		blockField,
		frameLayer,
		inlineLayer,
		liveEvents,
		liveKeys,
		sidenotes,
	];
}
