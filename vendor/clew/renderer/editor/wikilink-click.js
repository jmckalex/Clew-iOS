// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Cmd/Ctrl+click a [[wikilink]] in the editor to open it (creating the note
// when unresolved, Obsidian-style). Finds the link by scanning the clicked
// line's text (link-at.js) — independent of the highlighting overlay.
import { EditorView } from '@codemirror/view';
import * as actions from '../commands/actions.js';
import { linkAt } from './link-at.js';

export function wikilinkClick() {
	return EditorView.domEventHandlers({
		mousedown(event, view) {
			if (!(event.metaKey || event.ctrlKey)) return false;
			const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
			if (pos === null) return false;
			const line = view.state.doc.lineAt(pos);
			const link = linkAt(line.text, pos - line.from);
			if (link?.kind !== 'wikilink') return false;
			event.preventDefault();
			// `|external` means the OS default app, in source mode too —
			// the two modes must not disagree about what a link does.
			if (link.external && link.target) {
				actions.openFileExternally(link.target);
				return true;
			}
			actions.openWikilink(link.target + (link.heading ? `#${link.heading}` : ''), { newTab: event.altKey });
			return true;
		},
	});
}
