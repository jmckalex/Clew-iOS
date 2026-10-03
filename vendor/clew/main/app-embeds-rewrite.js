// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Each `<clew-app-embed data-app="…">` the engine emitted (engine/
// app-embed.js), resolved as the document is SERVED (protocol.js — notes,
// live edit's block documents, canvas cards): the app's key, name, entry URL
// on its own origin and whether its vault is restricted, as attributes the
// preview client (preview-client/app-embed.js) builds the frame from — or,
// in its place, the refusal BY NAME (frame-bridge.md §7). A site export
// never comes through here and keeps the bare placeholder.
//
// `resolve(target)` is app-registry.js#resolveFor bound to the session —
// passed in, so this stays pure (tests/app-embeds-rewrite.test.js).
const escapeAttr = (s) => String(s)
	.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
	.replace(/</g, '&lt;').replace(/>/g, '&gt;');

const decode = (s) => String(s)
	.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const EMBED = /<clew-app-embed\b([^>]*)>([\s\S]*?)<\/clew-app-embed>/gi;

export function rewriteAppEmbeds(html, { resolve, restricted, notePath = null }) {
	let count = 0;
	const out = String(html).replace(EMBED, (whole, attrs, inner) => {
		const target = /\sdata-app="([^"]*)"/i.exec(attrs)?.[1];
		if (target === undefined) return whole;
		const found = resolve(decode(target));
		count++;
		if (found.refusal) return `<span class="clew-embed-refused">${escapeAttr(found.refusal)}</span>`;
		const extra = ` data-app-key="${escapeAttr(found.key)}"`
			+ ` data-app-name="${escapeAttr(found.manifest.name)}"`
			+ ` data-app-src="${escapeAttr(`clew-frame://${found.key}/${found.manifest.entry.split('/').map(encodeURIComponent).join('/')}`)}"`
			+ (restricted ? ' data-app-restricted="1"' : '')
			+ (notePath ? ` data-app-note="${escapeAttr(notePath)}"` : '');
		return `<clew-app-embed${attrs}${extra}>${inner}</clew-app-embed>`;
	});
	return { html: out, count };
}
