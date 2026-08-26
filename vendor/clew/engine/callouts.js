// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Obsidian callouts: `> [!type]`, the whole family.
//
// The engine already renders GFM alerts through marked-alert, but GFM defines
// five types, matches them case-sensitively, and supports neither a custom
// title nor folding. Obsidian defines about a dozen with aliases, is
// case-insensitive, and uses both. Measured against two real vaults, the
// shortfall is the single largest compatibility gap in Clew: 102 unstyled
// callouts across 16 types in Obsidian's own help vault alone.
//
// So this extension claims the whole syntax — including the five GFM types, so
// that every callout in a document is rendered by one thing and looks the same.
// Registered last in the engine config, because marked offers the most recently
// registered block extension first.
//
//   > [!warning]                 bare
//   > [!warning] Mind the gap    custom title
//   > [!warning]- Mind the gap   foldable, starts collapsed
//   > [!warning]+ Mind the gap   foldable, starts expanded
//
// Foldables become <details>/<summary>: the behaviour comes free from the
// browser, with no JavaScript to survive a morph, no script in an exported
// static site, and sensible printing (browsers print <details> open).
//
// ICONS are inline SVG paths from Font Awesome Free 7 (CC BY 4.0 — the icons;
// see THIRD-PARTY-NOTICES.md). Inline rather than <i class="fa-…"> on purpose:
// no dependency on the Font Awesome runtime having loaded and re-run after a
// morph, nothing to copy into a site export, and it prints.

/** The 24×24-viewBox path for each icon we use, from Font Awesome Free solid. */
const ICONS = {
	pencil: 'M410.3 231l11.3-11.3-33.9-33.9-62.1-62.1L291.7 89.8l-11.3 11.3-22.6 22.6L58.6 322.9c-10.4 10.4-18 23.3-22.2 37.4L1 480.7c-2.5 8.4-.2 17.5 6.1 23.7s15.3 8.5 23.7 6.1l120.3-35.4c14.1-4.2 27-11.8 37.4-22.2L387.7 253.7 410.3 231zM160 399.4l-9.1 22.7c-4 3.1-8.5 5.4-13.3 6.9L59.4 452l23-78.1c1.4-4.9 3.8-9.4 6.9-13.3l22.7-9.1 0 32c0 8.8 7.2 16 16 16l32 0zM362.7 18.7L348.3 33.2 325.7 55.8 314.3 67.1l33.9 33.9 62.1 62.1 33.9 33.9 11.3-11.3 22.6-22.6 14.5-14.5c25-25 25-65.5 0-90.5L453.3 18.7c-25-25-65.5-25-90.5 0zm-47.4 168l-144 144c-6.2 6.2-16.4 6.2-22.6 0s-6.2-16.4 0-22.6l144-144c6.2-6.2 16.4-6.2 22.6 0s6.2 16.4 0 22.6z',
	clipboard: 'M280 64l40 0c35.3 0 64 28.7 64 64l0 320c0 35.3-28.7 64-64 64L64 512c-35.3 0-64-28.7-64-64L0 128C0 92.7 28.7 64 64 64l40 0 9.6 0C121 27.5 153.3 0 192 0s71 27.5 78.4 64l9.6 0zM64 112c-8.8 0-16 7.2-16 16l0 320c0 8.8 7.2 16 16 16l256 0c8.8 0 16-7.2 16-16l0-320c0-8.8-7.2-16-16-16l-16 0 0 24c0 13.3-10.7 24-24 24l-88 0-88 0c-13.3 0-24-10.7-24-24l0-24-16 0zm128-8a24 24 0 1 0 0-48 24 24 0 1 0 0 48z',
	info: 'M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM216 336l24 0 0-64-24 0c-13.3 0-24-10.7-24-24s10.7-24 24-24l48 0c13.3 0 24 10.7 24 24l0 88 8 0c13.3 0 24 10.7 24 24s-10.7 24-24 24l-80 0c-13.3 0-24-10.7-24-24s10.7-24 24-24zm40-208a32 32 0 1 1 0 64 32 32 0 1 1 0-64z',
	circleCheck: 'M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM369 209L241 337c-9.4 9.4-24.6 9.4-33.9 0l-64-64c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0l47 47L335 175c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9z',
	fire: 'M159.3 5.4c7.8-7.3 19.9-7.2 27.7 .1c27.6 25.9 53.5 53.8 77.7 84c11-14.4 23.5-30.1 37-42.9c7.9-7.4 20.1-7.4 28 .1c34.6 33 63.9 76.6 84.5 118c20.3 40.8 33.8 82.5 33.8 111.9C448 404.2 348.2 512 224 512C98.4 512 0 404.1 0 276.5c0-38.4 17.8-85.3 45.4-131.7C73.3 97.7 112.7 48.6 159.3 5.4zM225.7 416c25.3 0 47.7-7 68.8-21c42.1-29.4 53.4-88.2 28.1-134.4c-4.5-9-16-9.6-22.5-2l-25.2 29.3c-6.6 7.6-18.5 7.4-24.7-.5c-16.5-21-46-58.5-62.8-79.8c-6.3-8-18.3-8.1-24.7-.1c-33.8 42.5-50.8 69.3-50.8 99.4C112 375.4 162.6 416 225.7 416z',
	check: 'M438.6 105.4c12.5 12.5 12.5 32.8 0 45.3l-256 256c-12.5 12.5-32.8 12.5-45.3 0l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L160 338.7 393.4 105.4c12.5-12.5 32.8-12.5 45.3 0z',
	question: 'M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM169.8 165.3c7.9-22.3 29.1-37.3 52.8-37.3l58.3 0c34.9 0 63.1 28.3 63.1 63.1c0 22.6-12.1 43.5-31.7 54.8L280 264.4c-.2 13-10.9 23.6-24 23.6c-13.3 0-24-10.7-24-24l0-13.5c0-8.6 4.6-16.5 12.1-20.8l44.3-25.4c4.7-2.7 7.6-7.7 7.6-13.1c0-8.4-6.8-15.1-15.1-15.1l-58.3 0c-3.4 0-6.4 2.1-7.5 5.3l-.4 1.2c-4.4 12.5-18.2 19-30.6 14.6s-19-18.2-14.6-30.6l.4-1.2zM224 352a32 32 0 1 1 64 0 32 32 0 1 1 -64 0z',
	triangleExclamation: 'M256 32c14.2 0 27.3 7.5 34.5 19.8l216 368c7.3 12.4 7.3 27.7 .2 40.1S486.3 480 472 480L40 480c-14.3 0-27.6-7.7-34.7-20.1s-7-27.8 .2-40.1l216-368C228.7 39.5 241.8 32 256 32zm0 128c-13.3 0-24 10.7-24 24l0 112c0 13.3 10.7 24 24 24s24-10.7 24-24l0-112c0-13.3-10.7-24-24-24zm32 224a32 32 0 1 0 -64 0 32 32 0 1 0 64 0z',
	xmark: 'M342.6 150.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L192 210.7 86.6 105.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L146.7 256 41.4 361.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L192 301.3 297.4 406.6c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L237.3 256 342.6 150.6z',
	bolt: 'M349.4 44.6c5.9-13.7 1.5-29.7-10.6-38.5s-28.6-8-39.9 1.8l-256 224c-10 8.8-13.6 22.9-8.9 35.3S50.7 288 64 288l111.5 0L98.6 467.4c-5.9 13.7-1.5 29.7 10.6 38.5s28.6 8 39.9-1.8l256-224c10-8.8 13.6-22.9 8.9-35.3s-16.6-20.7-30-20.7l-111.5 0L349.4 44.6z',
	bug: 'M256 0c53 0 96 43 96 96l0 3.6c0 15.7-12.7 28.4-28.4 28.4l-135.1 0c-15.7 0-28.4-12.7-28.4-28.4l0-3.6c0-53 43-96 96-96zM41.4 105.4c12.5-12.5 32.8-12.5 45.3 0l64 64c.7 .7 1.3 1.4 1.9 2.1c14.2-7.3 30.4-11.4 47.5-11.4l112 0c17.1 0 33.2 4.1 47.5 11.4c.6-.7 1.2-1.4 1.9-2.1l64-64c12.5-12.5 32.8-12.5 45.3 0s12.5 32.8 0 45.3l-64 64c-.7 .7-1.4 1.3-2.1 1.9c6 12.1 9.8 25.5 10.9 39.6L480 256c17.7 0 32 14.3 32 32s-14.3 32-32 32l-64 0c0 24.6-5.5 47.8-15.4 68.6c2.2 1.3 4.2 2.9 6 4.8l64 64c12.5 12.5 12.5 32.8 0 45.3s-32.8 12.5-45.3 0l-63.1-63.1c-24.5 21.8-56.6 35.2-91.8 35.9L256 320l0-160-32 0 0 315.5c-35.2-.8-67.3-14.1-91.8-35.9L69.1 502.6c-12.5 12.5-32.8 12.5-45.3 0s-12.5-32.8 0-45.3l64-64c1.9-1.9 3.9-3.4 6-4.8C83.9 367.8 78.4 344.6 78.4 320l-64 0c-17.7 0-32-14.3-32-32s14.3-32 32-32l67.6 0c1.1-14.1 4.9-27.5 10.9-39.6c-.7-.6-1.4-1.2-2.1-1.9l-64-64c-12.5-12.5-12.5-32.8 0-45.3z',
	listOl: 'M24 56c0-13.3 10.7-24 24-24l32 0c13.3 0 24 10.7 24 24l0 120 16 0c13.3 0 24 10.7 24 24s-10.7 24-24 24l-80 0c-13.3 0-24-10.7-24-24s10.7-24 24-24l16 0 0-96-8 0C34.7 80 24 69.3 24 56zM86.7 341.2c-6.5-7.4-18.3-6.9-24 1.2L51.5 358.1c-7.7 10.8-22.7 13.3-33.5 5.6s-13.3-22.7-5.6-33.5l11.1-15.6c23.7-33.2 72.3-35.6 99.2-4.9c21.3 24.4 20.8 60.9-1.1 84.7L86.8 432l33.2 0c13.3 0 24 10.7 24 24s-10.7 24-24 24l-88 0c-9.5 0-18.2-5.6-22-14.4s-2.1-18.9 4.3-25.9l72-78c5.3-5.8 5.4-14.6 .3-20.5zM224 64l256 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-256 0c-17.7 0-32-14.3-32-32s14.3-32 32-32zm0 160l256 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-256 0c-17.7 0-32-14.3-32-32s14.3-32 32-32zm0 160l256 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-256 0c-17.7 0-32-14.3-32-32s14.3-32 32-32z',
	quoteLeft: 'M0 216C0 149.7 53.7 96 120 96l8 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-8 0c-30.9 0-56 25.1-56 56l0 8 64 0c35.3 0 64 28.7 64 64l0 64c0 35.3-28.7 64-64 64l-64 0c-35.3 0-64-28.7-64-64l0-32 0-32 0-72zm256 0c0-66.3 53.7-120 120-120l8 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-8 0c-30.9 0-56 25.1-56 56l0 8 64 0c35.3 0 64 28.7 64 64l0 64c0 35.3-28.7 64-64 64l-64 0c-35.3 0-64-28.7-64-64l0-32 0-32 0-72z',
	listCheck: 'M153 39c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9L97 163c-9.4 9.4-24.6 9.4-33.9 0L23 123c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0l23 23L153 39zM231 96c0-13.3 10.7-24 24-24l232 0c13.3 0 24 10.7 24 24s-10.7 24-24 24l-232 0c-13.3 0-24-10.7-24-24zm0 160c0-13.3 10.7-24 24-24l232 0c13.3 0 24 10.7 24 24s-10.7 24-24 24l-232 0c-13.3 0-24-10.7-24-24zm0 160c0-13.3 10.7-24 24-24l232 0c13.3 0 24 10.7 24 24s-10.7 24-24 24l-232 0c-13.3 0-24-10.7-24-24zM153 199c9.4 9.4 9.4 24.6 0 33.9L97 289c-9.4 9.4-24.6 9.4-33.9 0L23 249c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0l23 23 56-56c9.4-9.4 24.6-9.4 33.9 0zM97 449c-9.4 9.4-24.6 9.4-33.9 0L23 409c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0l23 23 56-56c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9L97 449z',
};

// viewBox differs between icons; Font Awesome's are all 512 high but vary in
// width, so each entry carries its own.
const VIEWBOX = {
	pencil: '0 0 512 512', clipboard: '0 0 384 512', info: '0 0 512 512',
	circleCheck: '0 0 512 512', fire: '0 0 448 512', check: '0 0 448 512',
	question: '0 0 512 512', triangleExclamation: '0 0 512 512', xmark: '0 0 384 512',
	bolt: '0 0 448 512', bug: '0 0 512 512', listOl: '0 0 512 512',
	quoteLeft: '0 0 448 512', listCheck: '0 0 512 512',
};

/**
 * Obsidian's callout types, their aliases, and the icon each gets. The
 * canonical name becomes the CSS hook; aliases fold onto it, so `[!tldr]` and
 * `[!abstract]` are the same callout and a stylesheet needs one rule.
 */
const TYPES = {
	note: { icon: 'pencil', label: 'Note' },
	abstract: { icon: 'clipboard', label: 'Abstract', aliases: ['summary', 'tldr'] },
	info: { icon: 'info', label: 'Info' },
	todo: { icon: 'circleCheck', label: 'Todo' },
	tip: { icon: 'fire', label: 'Tip', aliases: ['hint', 'important'] },
	success: { icon: 'check', label: 'Success', aliases: ['check', 'done'] },
	question: { icon: 'question', label: 'Question', aliases: ['help', 'faq'] },
	warning: { icon: 'triangleExclamation', label: 'Warning', aliases: ['caution', 'attention'] },
	failure: { icon: 'xmark', label: 'Failure', aliases: ['fail', 'missing'] },
	danger: { icon: 'bolt', label: 'Danger', aliases: ['error'] },
	bug: { icon: 'bug', label: 'Bug' },
	example: { icon: 'listOl', label: 'Example' },
	quote: { icon: 'quoteLeft', label: 'Quote', aliases: ['cite'] },
	// Not Obsidian's, but it appeared in its own help vault often enough to be
	// worth recognising rather than dropping to a bare blockquote.
	compatibility: { icon: 'listCheck', label: 'Compatibility' },
};

/** alias → canonical name, built once. */
const ALIASES = (() => {
	const map = new Map();
	for (const [name, spec] of Object.entries(TYPES)) {
		map.set(name, name);
		for (const alias of spec.aliases ?? []) map.set(alias, name);
	}
	return map;
})();

/** The canonical type for whatever the author wrote, or null. Case-insensitive. */
export function resolveType(raw) {
	return ALIASES.get(String(raw ?? '').toLowerCase().trim()) ?? null;
}

const escapeHtml = (s) => String(s)
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
	.replace(/"/g, '&quot;');

function iconSvg(name) {
	const path = ICONS[name];
	if (!path) return '';
	return `<svg class="callout-icon" viewBox="${VIEWBOX[name]}" aria-hidden="true" focusable="false">`
		+ `<path fill="currentColor" d="${path}"/></svg>`;
}

/**
 * Peel the `> ` off a blockquote block, leaving the markdown inside.
 * A bare `>` is an empty line, which is how paragraphs inside a callout work.
 */
function stripQuote(lines) {
	return lines.map((line) => line.replace(/^[ \t]{0,3}>[ \t]?/, '')).join('\n');
}

export const calloutBlock = {
	name: 'calloutBlock',
	level: 'block',
	start(src) { return src.match(/^[ \t]{0,3}>[ \t]*\[!/m)?.index; },

	tokenizer(src) {
		// The opening line carries the type, an optional fold marker, and an
		// optional title. Anything else after `>` is body.
		const opener = /^[ \t]{0,3}>[ \t]*\[!([A-Za-z][\w-]*)\][ \t]*([+-]?)[ \t]*([^\n]*)(?:\n|$)/.exec(src);
		if (!opener) return;
		const type = resolveType(opener[1]);
		if (!type) return;   // not a callout we know — let marked-alert or the
		                     // ordinary blockquote rule have it

		// Consume the rest of the blockquote.
		const rest = src.slice(opener[0].length);
		const bodyLines = [];
		let consumed = opener[0].length;
		for (const line of rest.split('\n')) {
			if (!/^[ \t]{0,3}>/.test(line)) break;
			bodyLines.push(line);
			consumed += line.length + 1;
		}
		const raw = src.slice(0, Math.min(consumed, src.length));

		const token = {
			type: 'calloutBlock',
			raw,
			calloutType: type,
			fold: opener[2] || null,          // '-' collapsed, '+' expanded, null fixed
			title: opener[3].trim(),
			tokens: [],
			titleTokens: [],
		};
		// Body and title are both markdown.
		this.lexer.blockTokens(stripQuote(bodyLines), token.tokens);
		if (token.title) this.lexer.inline(token.title, token.titleTokens);
		return token;
	},

	renderer(token) {
		const spec = TYPES[token.calloutType];
		const title = token.title
			? this.parser.parseInline(token.titleTokens)
			: escapeHtml(spec.label);
		const body = this.parser.parse(token.tokens);

		if (global.isLatex) {
			// The engine turns GFM alerts into coloured tcolorboxes; a callout is
			// the same idea, so reuse that rather than inventing a second look.
			return `\\begin{tcolorbox}[title=${title}]\n${body}\n\\end{tcolorbox}\n`;
		}

		// `markdown-alert` classes as well as Obsidian's, so the styling the
		// engine already ships keeps applying and a vault's own CSS snippets
		// (which target Obsidian's names) keep working.
		const classes = `callout markdown-alert markdown-alert-${token.calloutType}`;
		const head = `${iconSvg(spec.icon)}<span class="callout-title-inner">${title}</span>`;

		if (token.fold) {
			const open = token.fold === '+' ? ' open' : '';
			return `<details class="${classes} is-collapsible" data-callout="${token.calloutType}"${open}>`
				+ `<summary class="callout-title markdown-alert-title">${head}</summary>`
				+ `<div class="callout-content">\n${body}</div></details>\n`;
		}
		return `<div class="${classes}" data-callout="${token.calloutType}">`
			+ `<p class="callout-title markdown-alert-title">${head}</p>`
			+ `<div class="callout-content">\n${body}</div></div>\n`;
	},
};

export default [calloutBlock];
