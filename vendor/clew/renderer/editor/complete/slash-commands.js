// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The `//` menu as a completion source: type `//` at a line start or after a
// space and the Format menu drops down, filtered as you type; accepting an
// item deletes what was typed and runs its command. Source mode and live
// edit alike, and in a table cell edited in place (inline items only).
// What triggers it and what it offers are slash-spec.js, which is pure.
import { slashQuery, slashItems } from './slash-spec.js';
import { literalAt } from '../literal-at.js';
import { runCommand } from '../../commands/registry.js';
import { settingsStore } from '../../state/settings-store.js';
import { vaultSettingsStore } from '../../state/vault-settings-store.js';

function source(inCell) {
	return (context) => {
		if (settingsStore.get('slashCommands') === false) return null;
		const line = context.state.doc.lineAt(context.pos);
		const found = slashQuery(line.text.slice(0, context.pos - line.from));
		if (!found || literalAt(context.state, context.pos)) return null;
		const start = line.from + found.slashes;
		const items = slashItems({ normalSyntax: vaultSettingsStore.get('normalSyntax') === true, inCell });
		// Browsing (nothing typed yet): the Format menu's own sections and
		// order. Filtering: one list ranked by the match, as a palette is.
		const browsing = found.query === '';
		return {
			from: context.pos - found.query.length,
			options: items.map((item, i) => ({
				label: item.label,
				detail: item.detail,
				section: browsing ? { name: item.section, rank: item.rank } : undefined,
				boost: -i / 1000,
				apply: (view, _completion, _from, to) => {
					view.dispatch({ changes: { from: start, to, insert: '' }, selection: { anchor: start }, userEvent: 'delete.slash' });
					// After the completion has closed: some commands open
					// their own (Wikilink starts link completion).
					setTimeout(() => runCommand(item.id), 0);
				},
			})),
			// No validFor: every keystroke asks again, which is what
			// switches between the browsing and the ranked shape.
		};
	};
}

/** For a note's editor. */
export const slashCompletions = source(false);
/** For a table cell edited in place (live/table-cell-editor.js). */
export const slashCellCompletions = source(true);
