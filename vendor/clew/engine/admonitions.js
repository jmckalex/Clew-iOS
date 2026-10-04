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
// so the engine's callouts render it: one look for both syntaxes, and
// nothing to drift. Options: `title:` and `collapse:` (open/closed) are honoured;
// `icon:` and `color:` are the plugin's cosmetic overrides and the
// callout's own type styling applies instead. An `ad-` type Clew's callout
// table does not know renders as a note titled with the raw type, which is
// how the plugin treated user-defined types too. An untitled fence of a
// known type is headed by its type AS WRITTEN (`ad-hint` → Hint), as an
// untitled `> [!type]` is: the token carries `written`, which the engine's
// renderer hands to untitledCalloutTitle — without it the heading was empty.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The ENGINE's callout table (jmarkdown's callout-table.js), the very module
// instance its callout extension renders with — so an alias resolves, and a
// custom type (CLEW_CALLOUTS) is known, exactly as for `> [!type]`. Found
// beside the worker script (process.argv[1] is the engine's watch-worker.js,
// in dev and packaged alike — figures.js finds highlight.js the same way;
// a packaged build's engine-assets/ has no package.json, so `#jmarkdown/…`
// names nothing there). Only when that file IS there: a worker with no
// script on disk — Clew-iOS's WebKit module worker, argv ['node'] — asked
// for a file: URL beside nothing, and there that import NEVER SETTLES (no
// reject, so no fallback): the worker's module graph never finished and
// nothing rendered at all (measured by Clew-iOS on the simulator). Every
// other process (that worker, the unit tests) takes the package import —
// `#jmarkdown/…`, as every other Clew file names the engine, a literal a
// bundler resolves, and in Clew-iOS's bundle the engine's own instance.
const besideWorker = (() => {
	const script = globalThis.process?.argv?.[1];
	if (!script) return null;
	const file = path.join(path.dirname(script), 'callout-table.js');
	try {
		return fs.statSync(file).isFile() ? pathToFileURL(file).href : null;
	} catch {
		return null;
	}
})();
const { resolveType } = besideWorker
	? await import(besideWorker).catch(() => import('#jmarkdown/callout-table.js'))
	: await import('#jmarkdown/callout-table.js');

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
			written: rawType,   // the type as written, for an untitled heading
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
