// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Editor assembly: one function that builds a CodeMirror EditorView for a
// note. M1 uses stock lang-markdown; the jmarkdown dialect overlay and the
// wikilink/tag completion sources land in M3.
import { EditorState, Compartment } from '@codemirror/state';
import {
	EditorView, keymap, drawSelection, dropCursor, highlightActiveLine,
} from '@codemirror/view';
import {
	defaultKeymap, history, historyKeymap, indentWithTab,
} from '@codemirror/commands';
import { indentOnInput, bracketMatching } from '@codemirror/language';
import {
	autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap,
} from '@codemirror/autocomplete';
import { search, searchKeymap } from '@codemirror/search';
import { markdownKeymap } from '@codemirror/lang-markdown';
import { clewEditorTheme, clewHighlighting } from './theme.js';
import { wikilinkCompletions } from './complete/wikilinks.js';
import { slashCompletions } from './complete/slash-commands.js';
import { crossrefCompletions } from './complete/crossrefs.js';
import { tagCompletions } from './complete/tags.js';
import { wikilinkClick } from './wikilink-click.js';
import { linkHover } from './link-hover.js';
import { previewPanePlugin } from './preview-pane-plugin.js';
import { codeHighlight } from './code-highlight.js';
import { attachments } from './attachments.js';
import { citationCompletions } from './complete/citations.js';
import { jmdOverlay } from './jmd/overlay.js';
import { noteMarkdown } from './jmd/markdown-config.js';
import { liveCompartment } from './live/index.js';
import { jmdFolding } from './jmd/folding.js';
import { tableKeymap } from './tables.js';
import { autoFillHandler } from './fill.js';
import { settingsStore } from '../state/settings-store.js';

/**
 * The markdown language lives in a Compartment so a vault's `normalSyntax`
 * flip reconfigures an open editor in place — undo history and all —
 * instead of rebuilding its state: `view.dispatch({ effects:
 * markdownCompartment.reconfigure(noteMarkdown({ normalSyntax })) })`.
 */
export const markdownCompartment = new Compartment();

/**
 * Build an EditorState for a note. `handlerRef` is a mutable `{fn}` box the
 * update listener reads through — so a cached state (per-path undo history,
 * see editor/pool.js) can be re-adopted by a different tab later and have its
 * events rebound by assigning `handlerRef.fn`, without rebuilding the state.
 *
 * @param {string} doc
 * @param {{fn?: Function}} handlerRef
 * @param {{ normalSyntax?: boolean }} [options] - the vault's dialect switch
 */
export function makeNoteState(doc, handlerRef, { normalSyntax = false } = {}) {
	const onUpdate = (update) => handlerRef.fn?.(update);
	return EditorState.create({
		doc,
		extensions: [
			history(),
			drawSelection(),
			dropCursor(),
			highlightActiveLine(),
			indentOnInput(),
			bracketMatching(),
			closeBrackets(),
			// The dialect's grammar corrections and fence languages
			// (jmd/markdown-config.js).
			markdownCompartment.of(noteMarkdown({ normalSyntax })),
			// Live edit (editor/live/): empty in source mode; the pool swaps
			// the bundle in (editorPool.setMode).
			liveCompartment.of([]),
			clewHighlighting,
			clewEditorTheme,
			jmdOverlay(),
			jmdFolding(),
			autocompletion({ override: [wikilinkCompletions, tagCompletions, citationCompletions, crossrefCompletions, slashCompletions] }),
			wikilinkClick(),
			// Hover a link to preview it (link-hover.js; both modes).
			linkHover(),
			// The rendering of the formula or diagram being edited, beside it
			// (preview-pane-plugin.js; both modes).
			previewPanePlugin,
			// Fences highlighted as reading mode highlights them (highlight.js).
			codeHighlight,
			attachments(),
			// Reads the settings per keystroke: the toggle applies live and
			// cached EditorStates (pool undo cache) need no rebuild.
			autoFillHandler(() => ({
				enabled: settingsStore.get('autoFill') === true,
				column: settingsStore.get('fillColumn') ?? 72,
			})),
			search({ top: true }),
			// Before the general keymap: Tab has to reach a table before
			// indentWithTab claims it. Every handler declines when the cursor
			// is not in a table, so ordinary Tab is untouched.
			tableKeymap(),
			keymap.of([
				...closeBracketsKeymap,
				...markdownKeymap,
				...defaultKeymap,
				...historyKeymap,
				...searchKeymap,
				...completionKeymap,
				indentWithTab,
			]),
			EditorView.lineWrapping,
			EditorView.updateListener.of((update) => onUpdate?.(update)),
		],
	});
}
