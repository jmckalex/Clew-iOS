// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// `@app[Apps/Timer]` — an app in a note (docs/dev/frame-bridge.md §7). ONE
// named environment serves the three shapes, as `@reveal` does
// (reveal-embed.js, whose attribute repair this reuses): `@app[…]` inline,
// `@app+[…]{height=480px}` block, and `@begin(app)` … `@end(app)`.
//
// The engine only marks the place: a `<clew-app-embed>` naming the folder
// and the box. What the folder IS — its manifest, its id, the key of its
// origin, a duplicate id, the refusals — is decided in MAIN as the document
// is served (main/app-embeds-rewrite.js), because the key is derived from
// the DEVICE's identity for the vault, which no render worker has. A
// custom element, so the preview's morph keeps a running app across a
// re-render (client.js keeps custom elements, syncing their attributes).
// Obsidian shows `@app[…]` as text, as it does `@reveal[…]`.
import { attrsOf } from './reveal-embed.js';

const escapeAttr = (s) => String(s)
	.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
	.replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The box: width (100%), and height (320px) unless an aspect is given. A
 *  bare number is pixels; anything with a slash must be quoted. */
export function appBoxStyle(attrs) {
	const px = (v) => (/^\d+(?:\.\d+)?$/.test(String(v).trim()) ? `${String(v).trim()}px` : String(v).trim());
	const parts = [`width: ${attrs.width ? px(attrs.width) : '100%'}`];
	if (attrs.height) parts.push(`height: ${px(attrs.height)}`);
	else if (attrs.aspect) parts.push(`aspect-ratio: ${String(attrs.aspect).replace(/:/g, '/')}`);
	else parts.push('height: 320px');
	if (attrs.style) parts.push(String(attrs.style).replace(/;\s*$/, ''));
	return parts.join('; ');
}

export const app = {
	mode: 'custom',
	html(ctx) {
		const target = String(ctx?.rawText ?? ctx?.text ?? '').trim();
		const attrs = attrsOf(ctx);
		const classes = ['clew-app-embed', ...(attrs.class ? [attrs.class] : [])];
		// `pin=top|bottom`: held at that edge of the pane while its place is
		// out of view there (shared/app-pin.js); the preview does the holding.
		const pin = ['top', 'bottom'].includes(String(attrs.pin ?? '').toLowerCase()) ? String(attrs.pin).toLowerCase() : null;
		return `<clew-app-embed class="${escapeAttr(classes.join(' '))}" data-app="${escapeAttr(target)}"`
			+ (pin ? ` data-app-pin="${pin}"` : '')
			+ ` style="${escapeAttr(appBoxStyle(attrs))}">`
			+ `<span class="clew-app-label">App: ${escapeAttr(target || '(no target)')}</span></clew-app-embed>`;
	},
};
