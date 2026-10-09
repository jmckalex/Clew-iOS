// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Label completion inside `@ref[`, `@cref[`, `@Cref[` and their colon twins
// (docs/dev/live-edit.md §5.13): the note's labels, from the numbering pass
// over the CURRENT editor state — so a label typed seconds ago completes —
// each detailed with the number the engine will print and its title. The
// wikilink source's shape. `@label[` completes nothing: a new key is typed.
import { typedRefText } from '../live/numbering.js';
import { numberingFor, bookPlace } from '../live/numbering-source.js';
import { viewNotePath } from '../view-note-path.js';

/** A chapter's title for a completion's detail (book-map.js), else its file name. */
const chapterName = (path) => bookPlace(path)?.chapter ?? path.split('/').pop().replace(/\.(md|jmd)$/i, '');
import { fuzzyScore } from '../../lib/fuzzy.js';

const PREFIX = /(?:^|[^\w@:\\])[@:](?:ref|cref|Cref)\[([^\]\n]*)$/;

/**
 * The key typed so far inside a reference's brackets, or null.
 *
 * @param {string} before - the line up to the cursor
 * @returns {string|null}
 */
export function refPrefix(before) {
	const m = PREFIX.exec(before);
	return m ? m[1] : null;
}

/**
 * The options for `query` over a numbering, best first.
 *
 * @param {ReturnType<typeof numberDocument>} numbering
 * @param {string} query
 * @returns {{ label: string, detail: string, boost: number }[]}
 */
export function labelOptions(numbering, query, notePath = null) {
	const out = [];
	for (const [key, target] of numbering.labels) {
		const score = query ? fuzzyScore(query, key) : 0;
		if (score === null) continue;
		const number = target.status === 'ok' && target.number ? typedRefText(target.type, target.number) : 'no number';
		// In a book, a label in another chapter says which.
		const where = target.path && notePath && target.path !== notePath ? ` · ${chapterName(target.path)}` : '';
		out.push({
			label: key,
			detail: `${number}${target.title ? ` — ${target.title}` : ''}${where}`,
			boost: Math.min(99, Math.max(-99, Math.round((score ?? 0) / 12))),
		});
	}
	return out;
}

export function crossrefCompletions(context) {
	const line = context.state.doc.lineAt(context.pos);
	const query = refPrefix(line.text.slice(0, context.pos - line.from));
	if (query === null) return null;
	const notePath = context.view ? viewNotePath(context.view) : null;
	const options = labelOptions(numberingFor(context.state.doc, notePath), query, notePath).map((o) => ({
		...o,
		type: 'constant',
		// The key, and the closing bracket unless one is already there.
		apply: (view, completion, from, to) => {
			const close = view.state.sliceDoc(to, to + 1) === ']' ? '' : ']';
			view.dispatch({
				changes: { from, to, insert: completion.label + close },
				selection: { anchor: from + completion.label.length + 1 },
			});
		},
	}));
	return options.length ? { from: context.pos - query.length, options, validFor: /^[^\]\n]*$/ } : null;
}
