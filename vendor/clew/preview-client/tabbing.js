// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Lays out ```tabbing blocks (the engine's tabbing.js) in the preview. A stop
// depends on the RENDERED width of the text before it, so this measures each
// piece and replays LaTeX's own algorithm (`layoutTabbing`, the engine's —
// one implementation) to place it. Before this runs the pieces sit inline
// with a gap: readable, not aligned.
//
// Widths come in layout pixels (a note shown scaled on a canvas lays out as
// it would unscaled), and a ResizeObserver lays a block out again whenever a
// piece changes size — a web font arriving, MathJax typesetting a cell, the
// pane resizing a `\`` row. A block whose source is unchanged survives a
// re-render (tabbingMorph); a changed one is laid out afresh.
// The engine's own (jmarkdown at-migration 4ab3d6a, the backport of what
// was Clew's own copy) — one copy of the layout, never two.
import { layoutTabbing } from '#jmarkdown/tabbing.js';

const pending = new Set();
let scheduled = false;
const observer = typeof ResizeObserver === 'function'
	? new ResizeObserver((entries) => {
		for (const entry of entries) {
			const block = entry.target.closest?.('.clew-tabbing');
			if (block) schedule(block);
		}
	})
	: null;

function schedule(block) {
	pending.add(block);
	if (scheduled) return;
	scheduled = true;
	requestAnimationFrame(() => {
		scheduled = false;
		for (const b of pending) layout(b);
		pending.clear();
	});
}

/** One block: rows from its markers, widths measured, pieces placed. */
export function layout(block) {
	if (!block.isConnected || !block.offsetWidth) return;
	const rowEls = [...block.children].filter((c) => c.classList.contains('tb-row'));
	const rows = rowEls.map((rowEl) => ({
		kill: rowEl.classList.contains('tb-kill'),
		silent: rowEl.classList.contains('tb-silent'),
		items: [...rowEl.children].map((c) => (c.classList.contains('tb-t')
			? { op: 'text', el: c }
			: { op: c.dataset.op ?? '' })),
	}));
	block.classList.add('tb-laid');
	const style = getComputedStyle(block);
	const fontSize = parseFloat(style.fontSize) || 16;
	const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.6;
	// A scaled ancestor (a canvas card) scales every rect; widths are wanted in
	// the block's own pixels.
	const scale = block.getBoundingClientRect().width / block.offsetWidth || 1;
	const out = layoutTabbing(rows, (r, i) => rows[r].items[i].el.getBoundingClientRect().width / scale, {
		sep: fontSize * 0.5,              // \tabbingsep = \labelsep = 0.5em
		lineWidth: block.clientWidth,     // \linewidth, for a \` row
	});
	let minLeft = 0;
	out.forEach(({ lefts }, r) => {
		let height = 0;
		for (const [i, x] of lefts) {
			minLeft = Math.min(minLeft, x);
			const span = rows[r].items[i].el;
			span.style.left = `${x}px`;
			height = Math.max(height, span.getBoundingClientRect().height / scale);
		}
		rowEls[r].style.height = rows[r].kill || rows[r].silent ? '0px' : `${Math.max(height, lineHeight)}px`;
	});
	// \' can hang a piece left of stop 0, into the margin, as TeX does. Where
	// there is no margin to hang into (a live edit frame's body has none),
	// the block steps right by what hangs, so nothing is cut off.
	block.style.marginLeft = '';
	const room = (block.getBoundingClientRect().left - document.documentElement.getBoundingClientRect().left) / scale;
	if (minLeft < 0 && room + minLeft < 0) block.style.marginLeft = `${Math.ceil(-(room + minLeft))}px`;
	block.dataset.laidKey = block.dataset.tabbingKey ?? '';
}

/** Every block not yet laid out for its current source. */
export function initTabbing() {
	for (const block of document.querySelectorAll('.clew-tabbing')) {
		if (block.dataset.laidKey === (block.dataset.tabbingKey ?? '')) continue;
		layout(block);
		if (observer) {
			observer.observe(block);
			for (const piece of block.querySelectorAll('.tb-t')) observer.observe(piece);
		}
	}
}

/** Morph guard (client.js): keep a laid-out block whose source is unchanged. */
export function tabbingMorph(fromEl, toEl) {
	if (!fromEl.classList?.contains('clew-tabbing')) return null;
	return fromEl.dataset.tabbingKey === toEl.dataset?.tabbingKey ? false : null;
}

if (typeof window !== 'undefined') {
	document.fonts?.ready?.then(() => { for (const b of document.querySelectorAll('.clew-tabbing')) schedule(b); });
	window.addEventListener('resize', () => { for (const b of document.querySelectorAll('.clew-tabbing')) schedule(b); });
}
