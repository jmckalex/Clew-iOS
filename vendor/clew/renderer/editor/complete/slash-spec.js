// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The `//` menu (docs/dev/live-edit.md §6.9), the pure half: when the text
// before the cursor asks for it, and what it offers. Obsidian's trigger is a
// single `/`, which is the dialect's italic (`/text/`); `//` can never open
// one — the engine's italic needs a character that is not a slash between
// the two — so the double slash is the dialect's own spelling of the same
// gesture. It fires only at the start of a line or after whitespace, which
// leaves `https://` alone.
//
// The menu IS the Format menu (shared/format-spec.js), so it cannot drift
// from the menu bar, the palette or the hotkey editor: every item runs a
// registered command.
import { FORMAT_MENU, CELL_SAFE_COMMANDS } from '../../../shared/format-spec.js';

/** `//` at a line start or after whitespace, then the query typed so far:
 *  a word, possibly more words after single spaces ("heading 2"). */
const TRIGGER = /(?:^|\s)\/\/((?:[A-Za-z0-9(][A-Za-z0-9()×'-]*(?: [A-Za-z0-9()×'-]+)* ?)?)$/;

/**
 * The trigger in the text before the cursor on its line.
 *
 * @param {string} before - the line's text up to the cursor
 * @returns {{ query: string, slashes: number } | null} `slashes`: the offset
 *   of the `//` within `before`, which accepting an item deletes along with
 *   the query
 */
export function slashQuery(before) {
	const m = TRIGGER.exec(before);
	if (!m) return null;
	return { query: m[1], slashes: before.length - m[1].length - 2 };
}

/** Items the Format menu holds that make no sense typed into a line. */
const SKIP = new Set(['format:table-row']);
/** Not in the Format menu, but in the toolbar's Insert group. */
const EXTRA = [
	{ id: 'format:insert-link', label: 'Link — [text](url)', section: 'Insert' },
	{ id: 'format:insert-attachment', label: 'Attachment…', section: 'Insert' },
];
/** Under normalSyntax: what the toolbar hides, and what it relabels. */
const DIALECT_ONLY = new Set(['edit:format-intense', 'format:underline', 'edit:format-highlight']);
const NORMAL_LABELS = { 'edit:format-strong': 'Bold — **text**', 'edit:format-italic': 'Italic — *text*' };

/**
 * The menu's items in Format-menu order.
 *
 * @param {{ normalSyntax?: boolean, inCell?: boolean }} [options] - `inCell`:
 *   a table cell edited in place, where only inline formatting can live
 * @returns {{ id: string, label: string, detail: string, section: string, rank: number }[]}
 *   `rank`: the section's place in the Format menu
 */
export function slashItems({ normalSyntax = false, inCell = false } = {}) {
	const out = [];
	const ranks = new Map(FORMAT_MENU.map((g, i) => [g.label, i]));
	const add = (id, label, section) => {
		if (SKIP.has(id)) return;
		if (normalSyntax && DIALECT_ONLY.has(id)) return;
		if (inCell && !CELL_SAFE_COMMANDS.has(id)) return;
		const shown = (normalSyntax && NORMAL_LABELS[id]) || label;
		const cut = shown.indexOf(' — ');
		out.push({
			id,
			label: cut === -1 ? shown : shown.slice(0, cut),
			detail: cut === -1 ? '' : shown.slice(cut + 3),
			section,
			rank: ranks.get(section),
		});
	};
	for (const group of FORMAT_MENU) {
		for (const item of group.items) if (item.id) add(item.id, item.label, group.label);
		for (const item of EXTRA) if (item.section === group.label) add(item.id, item.label, group.label);
	}
	return out;
}
