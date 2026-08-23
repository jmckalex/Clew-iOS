// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Ephemeral UI state: focus context, tab-drag state, open modal.
// Never persisted.
import { Emitter } from '../lib/emitter.js';

class UiStore extends Emitter {
	/** @type {{tabId: string, fromGroupId: string} | null} */
	drag = null;
	editorFocused = false;

	startDrag(drag) { this.drag = drag; this.emit('drag-changed', drag); }
	endDrag() { this.drag = null; this.emit('drag-changed', null); }

	setEditorFocused(focused) {
		this.editorFocused = focused;
		this.emit('focus-changed');
	}
}

export const uiStore = new UiStore();
