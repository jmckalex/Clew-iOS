// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Live edit's BLOCK replacements (plan §3.2, §5.5): everything that swaps
// whole lines for a rendering — display math, a horizontal rule, the table
// of contents, the properties, a folded callout's body, the kanban banner.
// CodeMirror computes the viewport before view plugins run, so anything that
// changes the vertical block structure MUST come from a StateField; this is
// that field. It rebuilds whenever the live state object changes (a new
// model, or a different revealed set — cursor moves that touch nothing keep
// the same object, live/reveal-field.js).
//
// Callout folding is view state, not document state: the `+`/`-` in the
// source is the INITIAL state, as in reading mode, and toggling a chevron
// edits nothing (calloutFoldField).
import { StateField, StateEffect } from '@codemirror/state';
import { EditorView, Decoration } from '@codemirror/view';
import { liveStateField, liveRebuild } from './reveal-field.js';
import { MathWidget } from './widgets/math.js';
import { HrWidget, TocWidget, BannerWidget, PropertiesWidget } from './widgets/blocks.js';
import { TableWidget } from './widgets/table.js';
import { ImageWidget } from './widgets/image.js';
import { imageSpec } from './images.js';
import {
	FramePlaceholder, frameHeightField, setFrameHeight, frameKind, wantsFrame, defaultHeight,
} from './frames.js';
import { inlineTokens } from './inline-dom.js';
import { splitRow, alignmentOf } from '../tables.js';
import { cellRanges, isExtendedTable, CELL_EDIT_LIMITS } from './table-cell-model.js';
import { activeCellOf } from './active-cell.js';
import { numberingFor } from './numbering-source.js';
import { mathEnvironmentTex } from '../jmd/math-segments.js';
import { ChipWidget } from './widgets/chip.js';

/** Toggle a foldable callout: `{ id, folded }`. */
export const setCalloutFold = StateEffect.define();

/** Callout id → folded, for the ones the user has toggled. */
export const calloutFoldField = StateField.define({
	create: () => new Map(),
	update(value, tr) {
		let next = value;
		for (const e of tr.effects) {
			if (!e.is(setCalloutFold)) continue;
			if (next === value) next = new Map(value);
			next.set(e.value.id, e.value.folded);
		}
		return next;
	},
});

/** Is this callout folded now? Its `-` marker until someone toggles it. */
export function calloutFolded(state, callout) {
	const toggled = state.field(calloutFoldField, false)?.get(callout.id);
	return toggled ?? callout.fold === '-';
}

function build(state) {
	const live = state.field(liveStateField);
	const { model, config } = live;
	const doc = state.doc;
	const out = [];
	const sel = state.selection.ranges;
	const text = (a, b) => doc.sliceString(a, b);
	// The note's numbers — its BOOK's when it is a chapter (book-map.js).
	const numbering = numberingFor(doc, config.notePath, config.numbered?.size ? { numbered: config.numbered } : undefined);

	// A concealed MULTI-LINE footnote (§5.2 as corrected): an INLINE
	// replacement across its line breaks — not a block — so the note collapses
	// into its paragraph as a one-line note does and the sentence continues
	// after it. Only a StateField may replace across a line break, which is
	// why this badge is here and a one-line note's is in the inline layer.
	// Nothing inside a concealed note gets a block of its own.
	const notes = model.filter((c) => c.kind === 'footnote' && c.multiline && !live.revealed.has(c.id));
	for (const c of notes) {
		const body = c.body ? text(c.body.from, c.body.to).trim() : '';
		const paragraphs = body.split(/\n[ \t]*\n/);
		const first = paragraphs[0].replace(/\s+/g, ' ').trim();
		out.push(Decoration.replace({
			widget: new ChipWidget({ cls: 'le-fn le-fn-long', tag: 'sup', text: String(c.number), title: paragraphs.length > 1 ? `${first}…` : first }),
		}).range(c.from, c.to));
	}
	const inNote = (c) => notes.some((n) => c.from >= n.from && c.to <= n.to && n !== c);
	const block = (c, widget) => {
		if (inNote(c)) return;
		out.push(Decoration.replace({ widget, block: true }).range(c.lineFrom, c.lineTo));
	};

	const headings = model.filter((c) => c.kind === 'heading').map((h) => ({
		depth: h.depth,
		text: text(h.hidden[0]?.to ?? h.from, h.hidden[1]?.from ?? h.to).trim(),
		pos: h.hidden[0]?.to ?? h.from,
	}));

	// Tier C placeholders. An edit to a block changes its id (the id is a
	// hash of the text), so a height is also remembered by kind + ordinal:
	// the edited block keeps its size instead of snapping to the default.
	const heights = state.field(frameHeightField, false) ?? new Map();
	const ordinal = new Map();
	for (const c of model) {
		if (!wantsFrame(c, config)) continue;
		const kind = frameKind(c);
		const n = ordinal.get(kind) ?? 0;
		ordinal.set(kind, n + 1);
		if (live.revealed.has(c.id)) continue;
		const measured = heights.get(c.id) ?? heights.get(`${kind}#${n}`);
		block(c, new FramePlaceholder(c.id, kind, measured ?? defaultHeight(kind), measured !== undefined));
	}

	for (const c of model) {
		if (c.tier === 'B' && c.level === 'block' && !live.revealed.has(c.id)) {
			if (c.kind === 'table') block(c, tableWidget(state, c, model));
			else if (c.kind === 'image') block(c, new ImageWidget(imageSpec(c, config.notePath, true)));
			continue;
		}
		if (c.tier !== 'A') continue;
		if (c.kind === 'callout' && c.fold && c.body && calloutFolded(state, c)) {
			// A folded body hides, unless the cursor is in it (arrow keys can
			// still walk in; the lines then show rather than trap the caret).
			const inside = sel.some((r) => r.to >= c.body.from && r.from <= c.body.to);
			if (!inside && !inNote(c)) out.push(Decoration.replace({ block: true }).range(c.body.from, c.body.to));
			continue;
		}
		if (c.level !== 'block' || live.revealed.has(c.id)) continue;
		switch (c.kind) {
			case 'hr':
				block(c, new HrWidget());
				break;
			case 'math': {
				if (!config.renderMath) break;
				const tex = c.environment
					? mathEnvironmentTex(c.env, text(c.body.start ?? c.body.from, c.body.end ?? c.body.to))
					: text(c.body.from, c.body.to);
				// `@begin(equation)` is numbered; `$$…$$` is not (numbering.js).
				const tag = c.env === 'equation' && c.environment
					? numbering.lines.get(doc.lineAt(c.from).number)?.number ?? '' : '';
				block(c, new MathWidget(tex, true, text(c.from, c.to), true, tag));
				break;
			}
			case 'toc':
				block(c, new TocWidget(headings));
				break;
			case 'frontmatter':
				if (!c.closed) break;
				block(c, new PropertiesWidget(text(c.from, c.to)));
				break;
			default:
		}
	}

	// A kanban board note: say where the board is (plan §5.5).
	const front = model.find((c) => c.kind === 'frontmatter');
	if (front && /(^|\n)kanban-plugin\s*:/.test(text(front.from, front.to))) {
		out.push(Decoration.widget({
			widget: new BannerWidget('This note is a Kanban board — boards render in reading mode.',
				{ label: 'Reading mode', command: 'workspace:mode-reading' }),
			block: true, side: -1,
		}).range(0));
	}
	return Decoration.set(out, true);
}

export const blockField = StateField.define({
	create: (state) => ({ live: state.field(liveStateField), deco: build(state) }),
	update(value, tr) {
		const live = tr.state.field(liveStateField);
		const folds = tr.effects.some((e) => e.is(setCalloutFold) || e.is(setFrameHeight));
		// What a construct MEANS moved outside the editor (a book's numbers,
		// book-map.js; a custom callout): drawn again even when the model
		// came back the same.
		const rebuilt = tr.effects.some((e) => e.is(liveRebuild));
		if (live === value.live && !folds && !rebuilt && !(tr.selection && hasFoldedCallouts(tr.state))) return value;
		return { live, deco: build(tr.state) };
	},
	provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
});

/**
 * A table construct's widget. Cells come from the table's TEXT
 * (live/table-cell-model.js#cellRanges — lezer has no node for an empty
 * cell, and an empty cell must be editable); each cell's inline markdown is
 * tokenised from the model. An extended table (colspan/rowspan/widths) or a
 * very large one is drawn but edited as source (§5.5c).
 */
function tableWidget(state, c, model) {
	const doc = state.doc;
	const first = doc.lineAt(c.from).number;
	const last = doc.lineAt(c.to).number;
	const ranges = cellRanges(doc, first, last);
	const rows = ranges.rows.map((row, r) => ({
		header: r < ranges.headerRows,
		cells: row.map((cell) => ({
			tokens: inlineTokens(doc, cell.from, cell.to, model, numbering),
			offset: cell.from - c.lineFrom,
		})),
	}));
	const align = ranges.delimiterLine ? splitRow(doc.line(ranges.delimiterLine).text).map(alignmentOf) : [];
	const lines = [];
	for (let n = first; n <= last; n += 1) lines.push(doc.line(n).text);
	const cols = Math.max(0, ...ranges.rows.map((r) => r.length));
	const extended = isExtendedTable(lines);
	const tooBig = ranges.rows.length > CELL_EDIT_LIMITS.rows || cols > CELL_EDIT_LIMITS.cols;
	// Editing finds a table by its run of pipe-led lines (tables.js#
	// tableAround); a table it would not find the same (GFM rows without a
	// leading pipe, a separator-first body with a prose line) is drawn only.
	const pipeLed = (n) => /^\s*\|/.test(doc.line(n).text);
	let found = !(first > 1 && pipeLed(first - 1)) && !(last < doc.lines && pipeLed(last + 1));
	for (let n = first; found && n <= last; n += 1) found = pipeLed(n);
	const cell = activeCellOf(state);
	const active = cell && cell.from >= c.from && cell.to <= c.to ? { row: cell.row, col: cell.col } : null;
	return new TableWidget(doc.sliceString(c.from, c.to), rows, align, {
		editable: !extended && !tooBig && found,
		reason: extended ? 'Extended table (merged cells or widths) — edited as source'
			: tooBig ? `Large table (over ${CELL_EDIT_LIMITS.rows} rows or ${CELL_EDIT_LIMITS.cols} columns) — edited as source` : '',
		active,
	});
}

function hasFoldedCallouts(state) {
	return state.field(liveStateField).model.some((c) => c.kind === 'callout' && c.fold);
}
