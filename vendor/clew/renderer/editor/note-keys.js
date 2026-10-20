// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The note editor's keys, in the order they are offered a key: what
// editor.js installs, and what tests/list-keys.test.js presses Enter
// through — so the order is tested, not only the commands. Imports nothing
// DOM-bound.
//
// lang-markdown's own keymap (Enter continues a list or a quote, Backspace
// deletes markup) is HERE, after listEnter, and not where markdown() would
// put it — at Prec.high, ahead of everything at default precedence — which is
// why noteMarkdown() leaves it out (jmd/markdown-config.js). Until it did,
// lang-markdown's Enter ran first and listEnter only ever saw the keys it
// declined: on an item's first line Enter still started a new item
// (a7baa98's half; Clew-docs measured it, 2026-10-19).
import { keymap } from '@codemirror/view';
import { defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import { closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { searchKeymap } from '@codemirror/search';
import { markdownKeymap } from '@codemirror/lang-markdown';
import { tableKeymap } from './tables.js';
import { listEnter } from './list-keys.js';

export function noteKeys() {
	return [
		// Before the general keymap: Tab has to reach a table before
		// indentWithTab claims it, and Enter a table before the list and
		// quote rules. Every handler declines when the cursor is not in a
		// table, so ordinary keys are untouched.
		tableKeymap(),
		keymap.of([
			...closeBracketsKeymap,
			// Enter in a list item stays in the item (list-keys.js); ⌘Enter,
			// the next item, is the command registry's (format.js).
			{ key: 'Enter', run: listEnter },
			...markdownKeymap,
			...defaultKeymap,
			...historyKeymap,
			...searchKeymap,
			...completionKeymap,
			indentWithTab,
		]),
	];
}
