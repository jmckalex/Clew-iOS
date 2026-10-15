// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// EmbedPDF's card for a PDF it cannot open — its error, or the password
// prompt (pdf-size.js#MESSAGE_CARD) — kept whole in a narrow viewer. At an
// iPad's 208px (Clew-iOS, 2026-10-15) the snippet's own layout clipped both:
// its area keeps 2rem of padding a side, leaving the card 146px; the error
// card would not be narrower than "FPDF_LoadMemDocument failed" (221px, cut
// off on both sides), and the prompt's Cancel and Open would not share a
// row narrower than their labels (158px of the 96 inside the card: Open ran
// 38px past its edge). So, from Clew's side and only below its own sizes:
// the padding shrinks with the width, the card may be narrower than its
// longest word, which then wraps, and the buttons wrap onto two rows rather
// than run off. A wide viewer is drawn exactly as before: each padding is
// the smaller of the snippet's and a share of the width, and the buttons keep
// their equal halves while both labels fit. A stylesheet in the viewer's
// shadow root, as pdf-quiet-nav.js's; pdf-core.js installs it.
import { MESSAGE_CARD } from './pdf-size.js';

const CSS = `
.items-center.justify-center.p-8:has(> .max-w-sm) {
	padding: min(2rem, 6%) !important;
}
${MESSAGE_CARD} {
	min-width: 0 !important;
	max-width: min(24rem, 100%) !important;
	overflow-wrap: anywhere;
}
${MESSAGE_CARD}.p-6 {
	padding: min(1.5rem, 6%) !important;
}
${MESSAGE_CARD} .flex.gap-3 {
	flex-wrap: wrap;
}
${MESSAGE_CARD} .flex.gap-3 > button {
	min-width: max-content;
}
`;

/**
 * @param {HTMLElement} host - the viewer's container (EmbedPDF's custom
 *   element, whose shadowRoot holds the UI)
 * @returns {() => void} uninstall
 */
export function installCardFit(host) {
	const root = host?.shadowRoot;
	if (!root) return () => {};
	const style = document.createElement('style');
	style.dataset.clew = 'card-fit';
	style.textContent = CSS;
	root.append(style);
	return () => style.remove();
}

/**
 * Whether `card` is seen whole: the card inside its area and the area inside
 * `clip` (the viewer), and every box and every line of text in it inside the
 * card. `past` is how far the furthest of them runs over, in px. A text
 * line's rects come from a Range, counted only when wider than 1px — WebKit
 * gives a word at a line's end an extra zero-width one (Clew-iOS).
 *
 * @param {Element} card
 * @param {Element} clip
 * @returns {{ fits: boolean, past: number, width: number }}
 */
export function cardFit(card, clip) {
	const c = card.getBoundingClientRect();
	const outer = [[c, card.parentElement.getBoundingClientRect()], [card.parentElement.getBoundingClientRect(), clip.getBoundingClientRect()]];
	const inner = [...card.querySelectorAll('*')].map((el) => el.getBoundingClientRect());
	const walker = card.ownerDocument.createTreeWalker(card, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (!node.textContent.trim()) continue;
		const range = card.ownerDocument.createRange();
		range.selectNodeContents(node);
		inner.push(...range.getClientRects());
	}
	const over = (r, box) => Math.max(box.left - r.left, r.right - box.right, box.top - r.top, r.bottom - box.bottom, 0);
	const past = Math.max(...outer.map(([r, box]) => over(r, box)),
		...inner.filter((r) => r.width > 1 && r.height > 0).map((r) => over(r, c)));
	return { fits: past <= 0.5, past: Math.round(past), width: Math.round(c.width) };
}
