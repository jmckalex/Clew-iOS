// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Admonition fences — the callout syntax Obsidian vaults used BEFORE
// Obsidian had callouts:
//
//   ```ad-warning
//   title: Careful now
//   collapse: closed
//   The body, in markdown.
//   ```
//
// The plugin is superseded, but the fences it wrote are permanent — an
// older vault is full of them, and each one renders as a dead code block
// without this. The tokenizer maps the fence onto a `calloutBlock` TOKEN,
// so callouts.js renders it: one look for both syntaxes, and nothing to
// drift. Options: `title:` and `collapse:` (open/closed) are honoured;
// `icon:` and `color:` are the plugin's cosmetic overrides and the
// callout's own type styling applies instead. An `ad-` type Clew's callout
// table does not know renders as a note titled with the raw type, which is
// how the plugin treated user-defined types too.
import { resolveType } from './callouts.js';

export const admonitionFence = {
	name: 'admonitionFence',
	level: 'block',
	start(src) { return src.match(/^```ad-/m)?.index; },
	tokenizer(src) {
		const match = /^```ad-([A-Za-z][\w-]*)[ \t]*\n([\s\S]*?)\n```[ \t]*(?:\n+|$)/.exec(src);
		if (!match) return;
		const rawType = match[1];
		const lines = match[2].split('\n');
		let title = '';
		let fold = null;
		let i = 0;
		for (; i < lines.length; i++) {
			const option = /^(title|collapse|icon|color)\s*:\s*(.*)$/.exec(lines[i]);
			if (!option) break;
			if (option[1] === 'title') title = option[2].trim();
			else if (option[1] === 'collapse') {
				const value = option[2].trim().toLowerCase();
				fold = (value === 'closed' || value === 'true') ? '-'
					: value === 'open' ? '+' : null;
			}
		}
		while (i < lines.length && !lines[i].trim()) i++;
		const body = lines.slice(i).join('\n');
		const type = resolveType(rawType);
		const token = {
			type: 'calloutBlock',   // callouts.js owns the rendering
			raw: match[0],
			calloutType: type ?? 'note',
			fold,
			title: title || (type ? '' : rawType.charAt(0).toUpperCase() + rawType.slice(1)),
			tokens: [],
			titleTokens: [],
		};
		this.lexer.blockTokens(body, token.tokens);
		if (token.title) this.lexer.inline(token.title, token.titleTokens);
		return token;
	},
};
