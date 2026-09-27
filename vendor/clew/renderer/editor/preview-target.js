// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What the live preview pane (docs/dev/live-edit.md §5.12) would render for
// the cursor at `pos`: the formula or diagram block the cursor is inside,
// or nothing. Pure over the dialect scanner (jmd/scan-cache.js — maths,
// `:::` directives, `@begin` environments) and the lezer tree (fences), so
// source mode, which has no live model, and live edit see the same targets.
//
// Only COMPLETE constructs: an unclosed `$$` or fence is not yet anything
// to render (the scanner makes no segment of an unclosed delimiter — the
// widget rule). Queries, Dataview and Bases are never targets: a preview
// per typing pause would rescan the vault.
import { syntaxTree } from '@codemirror/language';
import { scanFor } from './jmd/scan-cache.js';
import { MATH_ENVIRONMENT_NAMES } from './jmd/math-segments.js';

/** Fence languages previewed, and their typing pause (ms). */
export const PREVIEW_FENCES = new Map([
	['mermaid', 400], ['tikz', 700], ['latex', 700], ['tex', 700], ['metapost', 700],
]);
/** `:::name` directives and `@begin(name)` environments previewed. */
const PREVIEW_DIRECTIVES = new Map([['TiKZ', 700], ['tikz', 700], ['mermaid', 400]]);
const PREVIEW_ENVIRONMENTS = new Map([['TiKZ', 700], ['tikz', 700], ['tikzpicture', 700], ['metapost', 700], ['mermaid', 400]]);
/** A formula re-typesets on a shorter pause: MathJax is synchronous. */
export const MATH_PAUSE = 150;

const MATH_ENVS = new Set(MATH_ENVIRONMENT_NAMES);
const isMathEnv = (name) => MATH_ENVS.has(name.replace(/\*$/, ''));

/**
 * @param {import('@codemirror/state').EditorState} state
 * @param {number} pos
 * @returns {null | {
 *   kind: 'math-inline'|'math-display'|'fence'|'directive'|'environment',
 *   from: number, to: number, pause: number,
 *   tex?: string,      // math: what MathJax typesets (delimiters stripped;
 *                      // an environment whole)
 *   text?: string,     // the rest: the block's full source, for the engine
 *   lang?: string,     // a fence's language, a directive's or environment's name
 * }}
 */
export function previewTargetAt(state, pos) {
	const doc = state.doc;
	const slice = (a, b) => doc.sliceString(a, b);
	const inside = (from, to) => pos >= from && pos <= to;
	const { constructs } = scanFor(doc);

	// The scanner's constructs are in document order, outer first.
	for (const c of constructs) {
		if (c.start > pos) break;
		if (!inside(c.start, c.end)) continue;
		if (c.kind === 'math') {
			return {
				kind: c.display ? 'math-display' : 'math-inline', from: c.start, to: c.end,
				pause: MATH_PAUSE, tex: slice(c.body.start, c.body.end),
			};
		}
		if (c.kind === 'directiveBlock' && c.close) {
			const name = c.name ? slice(c.name.start, c.name.end) : '';
			if (PREVIEW_DIRECTIVES.has(name)) {
				return { kind: 'directive', lang: name, from: c.start, to: c.end, pause: PREVIEW_DIRECTIVES.get(name), text: slice(c.start, c.end) };
			}
		}
		if (c.kind === 'environment' && c.close) {
			const name = slice(c.name.start, c.name.end);
			if (PREVIEW_ENVIRONMENTS.has(name)) {
				return { kind: 'environment', lang: name, from: c.start, to: c.end, pause: PREVIEW_ENVIRONMENTS.get(name), text: slice(c.start, c.end) };
			}
			// `@begin(align)` … `@end(align)`: display maths, typeset as
			// the widget does (block-field.js).
			if (isMathEnv(name)) {
				return {
					kind: 'math-display', from: c.start, to: c.end, pause: MATH_PAUSE,
					tex: `\\begin{${name}}\n${slice(c.body.start, c.body.end)}\n\\end{${name}}`,
				};
			}
		}
	}

	// Fences: lezer's. Only a closed one (two code marks).
	// Both sides: a cursor at the fence's very first character resolves
	// to the node before it looking left.
	const tree = syntaxTree(state);
	let fence = null;
	for (const side of [-1, 1]) {
		for (let node = tree.resolveInner(pos, side); node && !fence; node = node.parent) {
			if (node.name === 'FencedCode' && inside(node.from, node.to)) fence = node;
		}
	}
	if (!fence) return null;
	if (fence.getChildren('CodeMark').length < 2) return null;
	const info = fence.getChild('CodeInfo');
	const lang = info ? (/^[^\s{]+/.exec(slice(info.from, info.to)) ?? [''])[0] : '';
	if (!PREVIEW_FENCES.has(lang)) return null;
	return { kind: 'fence', lang, from: fence.from, to: fence.to, pause: PREVIEW_FENCES.get(lang), text: slice(fence.from, fence.to) };
}

/** Whether two targets are the same construct (the pane updates in place). */
export const sameTarget = (a, b) => Boolean(a && b) && a.kind === b.kind && a.from === b.from;
