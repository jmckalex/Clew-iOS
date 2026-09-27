// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * @file A small code field: one CodeMirror view over a snippet that is not a
 * note — the TeX fragments in the settings tab are the first, and so far
 * only, caller.
 *
 * editorPool owns every NOTE editor, and that rule stands: the pool is about
 * a path, its dirty state, its auto-save, its undo across navigation and its
 * conflict banner, none of which a settings field has. This is the other
 * kind — no path, no disk, no pool — so it owns its own lifecycle and the
 * caller MUST destroy() it when the element goes away (the settings view
 * re-renders on every vault change, and a leaked view keeps its DOM, its
 * listeners and its document alive).
 *
 * It borrows the pieces that make a field look like the rest of Clew: the
 * same highlight style as the editor (theme.js), and the same grammars the
 * ```tikz / ```latex / ```tex fences are highlighted with — fence-languages
 * .js is the one list, so a fragment is coloured exactly as it will be where
 * it is used.
 */
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, drawSelection, placeholder as cmPlaceholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { clewHighlighting } from './theme.js';
import { fenceLanguage } from './langs/fence-languages.js';

// Height is the caller's: the view grows with its content (no `height` here,
// no scroller of its own), which is what makes a settings row expand as the
// fragment gets longer. Everything else is the note editor's look at a size
// that suits a field.
const miniTheme = EditorView.theme({
	'&': {
		fontSize: '13px',
		backgroundColor: 'var(--clew-bg-primary)',
		color: 'var(--clew-text-normal)',
		border: '1px solid var(--clew-border)',
		borderRadius: '4px',
	},
	'&.cm-focused': { outline: 'none', borderColor: 'var(--clew-accent)' },
	'.cm-content': {
		fontFamily: 'var(--clew-editor-font)',
		caretColor: 'var(--clew-accent)',
		padding: '6px 0',
	},
	'.cm-scroller': { fontFamily: 'var(--clew-editor-font)', lineHeight: '1.5' },
	'.cm-line': { padding: '0 8px' },
	'.cm-cursor': { borderLeftColor: 'var(--clew-accent)' },
	'.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
		backgroundColor: 'var(--clew-selection) !important',
	},
	'.cm-placeholder': { color: 'var(--clew-text-faint)' },
});

/**
 * @param {object} options
 * @param {string} [options.doc] initial text
 * @param {string} [options.language] a fence language word ('tex', 'latex', 'tikz', 'metapost')
 * @param {string} [options.placeholder] shown while the field is empty
 * @param {(text: string) => void} [options.onChange] called on every edit
 * @returns {{ view: EditorView, dom: HTMLElement, text: () => string, destroy: () => void }}
 */
export function createCodeEditor({ doc = '', language = 'tex', placeholder = '', onChange = null } = {}) {
	const lang = fenceLanguage(language);
	const view = new EditorView({
		state: EditorState.create({
			doc,
			extensions: [
				...(lang ? [lang] : []),
				clewHighlighting,
				miniTheme,
				history(),
				drawSelection(),
				bracketMatching(),
				closeBrackets(),
				EditorView.lineWrapping,
				...(placeholder ? [cmPlaceholder(placeholder)] : []),
				keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
				...(onChange
					? [EditorView.updateListener.of((update) => {
						if (update.docChanged) onChange(update.state.doc.toString());
					})]
					: []),
			],
		}),
	});
	// The window's chord dispatcher runs at capture on window, so this does
	// not (and need not) hide anything from it — commands that need an editor
	// are disabled in a settings tab anyway. It keeps the keystrokes off the
	// panes behind, which is what every other settings field does.
	view.dom.addEventListener('keydown', (event) => event.stopPropagation());
	return {
		view,
		dom: view.dom,
		text: () => view.state.doc.toString(),
		destroy: () => view.destroy(),
	};
}
