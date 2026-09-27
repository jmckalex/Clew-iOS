// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The editor side of the live preview pane (docs/dev/live-edit.md §5.12):
// on a selection change (typing moves it too) it asks which target the
// cursor is in (preview-target.js) and tells <clew-preview-pane>. Nothing
// else runs per keystroke. In live edit a target counts only while it is
// REVEALED — while its widget or frame is on screen the pane would show
// the same thing twice.
import { ViewPlugin } from '@codemirror/view';
import { previewTargetAt } from './preview-target.js';
import { previewPane } from './preview-pane.js';
import { viewNotePath } from './link-hover.js';
import { liveStateField } from './live/reveal-field.js';
import { settingsStore } from '../state/settings-store.js';

const enabled = () => settingsStore.get('previewPane') !== 'off';

/** In live edit: is the construct at `from` showing its source? */
function revealed(state, target) {
	const live = state.field(liveStateField, false);
	if (!live) return true; // source mode
	return live.model.some((c) => c.from === target.from && live.revealed.has(c.id));
}

export const previewPanePlugin = ViewPlugin.fromClass(class {
	constructor(view) {
		this.view = view;
		this.onScroll = () => { if (previewPane().view === view) previewPane().reposition(); };
		this.onKey = (e) => { if (e.key === 'Escape' && previewPane().view === view) previewPane().dismiss(); };
		view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
		view.dom.addEventListener('keydown', this.onKey);
	}

	update(u) {
		const pane = previewPane();
		if (u.focusChanged && !u.view.hasFocus) {
			if (pane.view === u.view) pane.release();
			return;
		}
		if (u.selectionSet || u.docChanged || u.focusChanged) {
			if (!u.view.hasFocus || !enabled()) {
				if (pane.view === u.view) pane.release();
				return;
			}
			const state = u.state;
			let target = previewTargetAt(state, state.selection.main.head);
			if (target && !revealed(state, target)) target = null;
			pane.track(u.view, target, viewNotePath(u.view));
		} else if ((u.geometryChanged || u.viewportChanged) && pane.view === u.view) {
			pane.reposition();
		}
	}

	destroy() {
		this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
		this.view.dom.removeEventListener('keydown', this.onKey);
		if (previewPane().view === this.view) previewPane().release();
	}
});
