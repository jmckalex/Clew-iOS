// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Toggling inline markup (the Format menu and the toolbar's buttons), as a
// pure function of the editor state — so it is tested without a view.
//
// A selection whose markers sit just outside it, or which includes them,
// unwraps; otherwise it wraps. And — what a toolbar needs, where a button
// shows as PRESSED with the cursor merely inside `*word*` — a range that
// lies inside a construct of the marker's kind unwraps THAT construct: the
// construct model (live/model.js) knows where its delimiters are, which a
// text search around the cursor cannot.
import { EditorSelection } from '@codemirror/state';
import { liveModel } from './live/model.js';

/** Which construct kinds a marker pair produces, per dialect. */
function kindsFor(before, normalSyntax) {
	const dialect = {
		'*': 'strong', '**': 'intense', '/': 'italic', '__': 'underline', '==': 'highlight',
		'~': 'strike', '~~': 'strike', '_{': 'sub', '^{': 'sup', '`': 'code', '$': 'math',
	};
	const normal = {
		'*': 'italic', '_': 'italic', '**': 'strong', '__': 'strong', '~~': 'strike',
		'~': 'sub', '^': 'sup', '`': 'code', '$': 'math',
	};
	return (normalSyntax ? normal : dialect)[before] ?? null;
}

/** A construct's opening and closing delimiter ranges. */
function delimiters(c) {
	if (c.kind === 'math') {
		return c.body ? [{ from: c.from, to: c.body.from }, { from: c.body.to, to: c.to }] : null;
	}
	if (c.hidden.length < 2) return null;
	return [c.hidden[0], c.hidden[c.hidden.length - 1]];
}

/**
 * The transaction spec that toggles `before…after` around every range.
 *
 * @param {import('@codemirror/state').EditorState} state
 * @param {string} before
 * @param {string} [after]
 * @param {{ normalSyntax?: boolean }} [options]
 * @returns {import('@codemirror/state').TransactionSpec}
 */
export function toggleWrapSpec(state, before, after = before, { normalSyntax = false } = {}) {
	const kind = kindsFor(before, normalSyntax);
	const model = kind ? liveModel(state, { normalSyntax }) : [];
	return state.changeByRange((range) => {
		const { from, to } = range;
		const outerBefore = state.sliceDoc(Math.max(0, from - before.length), from);
		const outerAfter = state.sliceDoc(to, Math.min(state.doc.length, to + after.length));
		const inner = state.sliceDoc(from, to);
		if (outerBefore === before && outerAfter === after) {
			return {
				changes: [{ from: from - before.length, to: from }, { from: to, to: to + after.length }],
				range: EditorSelection.range(from - before.length, to - before.length),
			};
		}
		if (inner.length >= before.length + after.length && inner.startsWith(before) && inner.endsWith(after)) {
			return {
				changes: [{ from, to: from + before.length }, { from: to - after.length, to }],
				range: EditorSelection.range(from, to - before.length - after.length),
			};
		}
		// Inside a construct of this kind (innermost wins): unwrap it.
		let found = null;
		for (const c of model) {
			if (c.kind !== kind || c.from > from || c.to < to) continue;
			const d = delimiters(c);
			if (!d || state.sliceDoc(d[0].from, d[0].to) !== before || state.sliceDoc(d[1].from, d[1].to) !== after) continue;
			if (!found || c.to - c.from < found.c.to - found.c.from) found = { c, d };
		}
		if (found) {
			const [open, close] = found.d;
			const shift = (pos) => (pos >= close.to ? pos - (open.to - open.from) - (close.to - close.from)
				: pos > open.from ? Math.max(open.from, pos - (open.to - open.from)) : pos);
			return {
				changes: [{ from: open.from, to: open.to }, { from: close.from, to: close.to }],
				range: EditorSelection.range(shift(range.anchor), shift(range.head)),
			};
		}
		return {
			changes: [{ from, insert: before }, { from: to, insert: after }],
			range: EditorSelection.range(from + before.length, to + before.length),
		};
	});
}
