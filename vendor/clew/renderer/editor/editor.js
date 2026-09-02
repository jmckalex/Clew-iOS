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
import { EditorState } from '@codemirror/state';
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
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
import { clewEditorTheme, clewHighlighting } from './theme.js';
import { wikilinkCompletions } from './complete/wikilinks.js';
import { tagCompletions } from './complete/tags.js';
import { wikilinkClick } from './wikilink-click.js';
import { attachments } from './attachments.js';
import { citationCompletions } from './complete/citations.js';
import { jmdOverlay } from './jmd/overlay.js';
import { jmdFolding } from './jmd/folding.js';
import { tableKeymap } from './tables.js';
import { autoFillHandler } from './fill.js';
import { settingsStore } from '../state/settings-store.js';

/**
 * Build an EditorState for a note. `handlerRef` is a mutable `{fn}` box the
 * update listener reads through — so a cached state (per-path undo history,
 * see editor/pool.js) can be re-adopted by a different tab later and have its
 * events rebound by assigning `handlerRef.fn`, without rebuilding the state.
 */
export function makeNoteState(doc, handlerRef) {
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
			markdown({
				base: markdownLanguage,
				// jmarkdown has no indented code blocks or setext headings; removing
				// them also stops the metadata header masquerading as a heading.
				extensions: [{ remove: ['IndentedCode', 'SetextHeading'] }],
			}),
			clewHighlighting,
			clewEditorTheme,
			jmdOverlay(),
			jmdFolding(),
			autocompletion({ override: [wikilinkCompletions, tagCompletions, citationCompletions] }),
			wikilinkClick(),
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
