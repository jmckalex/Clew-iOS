// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The host side of the preview postMessage protocol, for the messages a
// reading-mode document and a live-edit BLOCK document share (plan §7.4):
// links, task and field edits, the note API, focus, and forwarded chords.
// clew-preview-view handles its own scroll/inverse-search/anchor messages
// and hands everything else here; live edit's frame layer hands all of its
// messages here. One switch, so the two surfaces cannot drift.
//
// `ctx.mode` is 'note' (a whole rendered note: a checkbox's data-source-line
// is a line of that note) or 'block' (one block of it: source lines are the
// block's, so a plain checkbox is refused silently; a ```tasks item carries
// its own path and line and still works; an embed's disclosure writes the
// block's own line, which the layer knows).
import { workspaceStore } from '../../state/workspace-store.js';
import * as actions from '../../commands/actions.js';
import { runChord } from '../../commands/registry.js';
import { openExternal } from '../../lib/external-links.js';
import { handleApiRequest } from '../../note-api.js';

/**
 * @param {object} msg - the message (source 'clew-preview')
 * @param {{ mode: 'note'|'block', tabId: string, path: string,
 *   post: (msg: object) => void, embedLine?: number }} ctx
 * @returns {boolean} whether the message was handled
 */
export function handlePreviewMessage(msg, ctx) {
	switch (msg.type) {
		case 'link-click':
			actions.openWikilink(msg.target, ctx.mode === 'note'
				? { newTab: msg.newTab, mode: 'reading' }
				: { newTab: msg.newTab });
			return true;
		case 'external-link':
			openExternal(msg.url);
			return true;
		case 'open-external-file':
			actions.openFileExternally(msg.path);
			return true;
		case 'embed-collapse':
			// The disclosure state belongs in the note, on the embed's line.
			actions.setEmbedCollapsed(ctx.path, ctx.mode === 'note' ? msg.line : ctx.embedLine, msg.collapsed);
			return true;
		case 'checkbox-toggle':
			if (ctx.mode === 'note') actions.toggleTaskLine(ctx.path, msg.line, msg.checked);
			return true;
		case 'task-toggle':
			// A ```tasks fence item — the toggle belongs to its source note.
			actions.toggleTaskLine(msg.path, msg.line, msg.checked);
			return true;
		case 'field-edit':
			// Editable query cell / kanban drag → write the source note.
			actions.editNoteField(msg.path, msg.field, msg.value, msg.fieldSource);
			return true;
		case 'api-request':
			handleApiRequest(msg, { sourcePath: ctx.path }).then((response) => ctx.post(response));
			return true;
		case 'focused':
			// A click inside the frame never reaches the app's pane focus
			// tracking — treat it like clicking into an editor.
			workspaceStore.activateTab(ctx.tabId);
			return true;
		case 'chord': {
			// Chords forwarded from the frame act on THIS pane.
			workspaceStore.activateTab(ctx.tabId);
			const key = msg.key;
			if (key === 'e') actions.toggleReadingMode();
			else if (key === 'w' && msg.shift) actions.closeCurrentPane();
			else if (key === 'w') actions.closeActiveTab();
			else if (key === 't') actions.newTab();
			else if (key === '\\') actions.splitActive(msg.shift ? 'bottom' : 'right');
			return true;
		}
		case 'app-chord':
			workspaceStore.activateTab(ctx.tabId);
			runChord(msg.chord);
			return true;
		default:
			return false;
	}
}
