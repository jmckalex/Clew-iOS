// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// One column of a list's indentation as live edit draws it: the width of a
// space in the note's own font, as `--le-col` on the scroller, which
// live-edit.css multiplies a line's --le-indent (its item marker's column,
// inline-layer.js#listIndent) by. A nested item's first line is indented by
// its leading whitespace, DRAWN — spaces, and tabs to their stops in the same
// spaces (tab-size) — while a quote in the item and the item's text past its
// first line are indented by that CSS, their whitespace concealed; the two
// agree only when the column is the font's space. A fixed 0.3em was Avenir
// Next's 0.25em by a fifth: a quote in a nested item stood 2px right of the
// item's text, reading view's 0 (Clew-iOS's measure, 2026-10-20). Measured
// on a hidden run of spaces in the scroller, as an em of the font's size, so
// a size setting alone changes nothing; again whenever that run's width
// changes, as a new face's does. The digits, `.` and `)` are measured beside
// it (`--le-d0`…`--le-d9`, `--le-dot`, `--le-paren`): a numbered item's
// lines hang by its number's width (numberWidth), which a fixed 1.4em was
// only while the number fitted it — Menlo's `1. ` is 1.8em, and a quote in
// the item stood 6px left of its text, item 10's in Avenir Next 5px
// (Clew-iOS, 2026-10-20).
import { ViewPlugin } from '@codemirror/view';

/**
 * A list item's indentation when it holds a tab — the run of spaces and tabs
 * after a quote's `>`s (where --le-indent counts from, inline-layer.js#
 * listIndent) up to the marker — or null. Live edit draws that run as a box
 * of its own (`le-indent-tabs`): CSS counts a tab's stops from the edge of the
 * box it is in, and a line's is moved by the item's hang (its negative
 * text-indent), so `\t* item` stood 6px in, not four columns' 16, its quote
 * and its later lines where the columns were (2026-10-20). In its own box the
 * run starts at a stop, and every tab fills to the next as the columns count
 * it. The characters stay characters: the caret, ←/→ and a click are as
 * before. A run of spaces alone is drawn as it always was.
 *
 * @param {string} text - the line up to the item's marker
 * @returns {{ from: number, to: number } | null} offsets in `text`
 */
export function tabbedIndent(text) {
	const from = /^(?:[ \t]*>)+[ \t]?/.exec(text)?.[0].length ?? 0;
	const to = from + /^[ \t]*/.exec(text.slice(from))[0].length;
	return text.slice(from, to).includes('\t') ? { from, to } : null;
}

/**
 * A numbered item's marker box, as CSS (live-edit.css's `--le-mark`): its
 * number, its `.` or `)` and the spaces after it, each the width the probe
 * measured in the note's face — never narrower than a bullet's 1.4em, the box
 * a short number has always been drawn in. Every line of the item hangs by
 * it, so its quotes and later lines stand where its text does. Null for a
 * tab after the number (drawn to a stop, not a width): the bullet's box, as
 * before.
 *
 * @param {string} text - the number and the space after it (model.js numberMark)
 * @returns {string | null}
 */
export function numberWidth(text) {
	const parts = [];
	for (const ch of text) {
		const unit = ch === ' ' ? 'col' : NUMBER_UNITS[ch];
		if (!unit) return null;
		parts.push(`var(--le-${unit})`);
	}
	return parts.length ? `max(1.4em, ${parts.join(' + ')})` : null;
}

// The characters of a list number, by the custom property holding each one's
// width.
const NUMBER_UNITS = { '.': 'dot', ')': 'paren', ...Object.fromEntries([...'0123456789'].map((d) => [d, `d${d}`])) };

/** A space's width as an em of the font's size: `0.25em`. Null for nothing measurable. */
export function columnEm(spaceWidth, fontSize) {
	if (!(spaceWidth > 0) || !(fontSize > 0)) return null;
	return `${Math.round((spaceWidth / fontSize) * 10000) / 10000}em`;
}

// What the probe measures, by the custom property each sets: a space (the
// column), each digit, `.` and `)`. Each a run long enough that a fraction of
// a pixel per character shows in its width.
const PROBE = 32;
const UNITS = { col: ' ', ...Object.fromEntries(Object.entries(NUMBER_UNITS).map(([ch, unit]) => [unit, ch])) };

export const columnWidth = ViewPlugin.fromClass(class {
	constructor(view) {
		this.view = view;
		// Hidden runs in the scroller, in the note's font (the scroller carries
		// the editor's face and size): their widths ARE the columns and the
		// numbers as the lines draw them, and they change exactly when the face
		// or the size does — which a ResizeObserver hears. CodeMirror's own
		// geometry change does not: a new face that rewraps no line moves no
		// height, and a short note kept the old column (measured, Menlo).
		this.probe = document.createElement('span');
		this.probe.className = 'le-col-probe';
		this.probe.setAttribute('aria-hidden', 'true');
		this.runs = Object.entries(UNITS).map(([unit, ch]) => {
			const run = document.createElement('span');
			run.textContent = ch.repeat(PROBE);
			this.probe.append(run);
			return [unit, run];
		});
		view.scrollDOM.append(this.probe);
		this.observer = new ResizeObserver(() => this.schedule());
		for (const [, run] of this.runs) this.observer.observe(run);
		this.schedule();
	}

	schedule() {
		this.view.requestMeasure({
			key: this,
			read: () => ({
				widths: this.runs.map(([unit, run]) => [unit, run.getBoundingClientRect().width]),
				size: parseFloat(getComputedStyle(this.probe).fontSize),
			}),
			write: ({ widths, size }, view) => {
				for (const [unit, width] of widths) {
					const em = columnEm(width / PROBE, size);
					if (em) view.scrollDOM.style.setProperty(`--le-${unit}`, em);
					else view.scrollDOM.style.removeProperty(`--le-${unit}`);
				}
			},
		});
	}

	destroy() {
		this.observer.disconnect();
		this.probe.remove();
		for (const unit of Object.keys(UNITS)) this.view.scrollDOM.style.removeProperty(`--le-${unit}`);
	}
});
