/*
	Obsidian callouts: `> [!type]`, the whole family.

	Ported from Clew-app's src/engine/callouts.js (@0423008), so the jmarkdown
	CLI, Clew's exports and Clew's reading view render a callout with ONE
	implementation: for every built-in and custom type the HTML is
	byte-identical to Clew's. What this port adds: LaTeX (callout-latex.js),
	the `Callouts` config key for CLI users, unknown types, one built-in type
	(jmarkdown's own `suggestion`, lightbulb), exact Font Awesome Free 6.7.2
	paths for bug, list-ol and list-check, and untitled headings from the type
	AS WRITTEN (`[!CAUTION]` → "Caution", untitledCalloutTitle) — the intended
	differences from Clew @0423008's output.

	  > [!warning]                 bare
	  > [!warning] Mind the gap    custom title
	  > [!warning]- Mind the gap   foldable, starts collapsed
	  > [!warning]+ Mind the gap   foldable, starts expanded

	It claims the WHOLE syntax, the five GFM alert types included (`[!NOTE]`,
	`[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]` — each is an Obsidian
	type or alias), so every callout in a document is rendered by one thing and
	looks the same. Registered after marked-alert (index.js), because marked
	offers the most recently registered block extension first; marked-alert is
	left installed but no longer sees a `> [!…]` block.

	An UNKNOWN type renders as Obsidian draws one: a note — pencil icon, note's
	colour (the stylesheet's default) — titled with the name capitalised
	(`[!foo]` → "Foo"), keeping data-callout="foo" so a stylesheet can still
	target it. (Clew @0423008 declined unknown types, leaving them to
	marked-alert or a plain blockquote; this is the owner's call, 2026-10-02.)

	Foldables become <details>/<summary>: the behaviour comes free from the
	browser, with no JavaScript, and prints open. LaTeX prints every callout
	expanded.

	ICONS are inline SVG paths of Font Awesome Free 6.7.2 icons, every one an
	exact copy from that release (CC BY 4.0 — see THIRD-PARTY-NOTICES.md;
	Clew's comment said Free 7, and three of its paths were not exact Free
	paths until 2026-10-02). Inline rather
	than <i class="fa-…">: no dependency on the Font Awesome runtime having
	loaded, nothing to copy into a site export, and it prints. LaTeX draws the
	same paths (callout-latex.js).

	THE TABLE — types, icons, palette, custom types, lookups — lives in
	callout-table.js, which imports nothing that needs Node, so a browser
	bundle (Clew's renderer) can share it; this module re-exports its names.

	CUSTOM TYPES come two ways, both validated (callout-definitions.js):
	  - a host hands over a RESOLVED table — name → { label, color, icon:
	    [w, h, d] | null, aliases } — with applyCustomCallouts() (Clew passes
	    its merged global + vault table); and
	  - the `Callouts` config key, a list of { name, title?, icon?, color?,
	    aliases? } definitions, resolved here with icon NAMES looked up in
	    @fortawesome/fontawesome-free's own svgs. When it is set it is the
	    custom table; a host's stands when it is not.
*/

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { configManager } from './config-manager.js';
import { addWarning } from './warnings.js';
import { resolveCallouts } from './callout-definitions.js';
import {
	BUILTIN_CALLOUT_TYPES, resolveType, specFor, calloutIcon, calloutIconGeometry, calloutAccent,
	installCalloutTable, hostCalloutTable, hostCalloutVersion, untitledCalloutTitle,
} from './callout-table.js';
import { cssColorToRgb, legibleOnLight, iconLatex, calloutLatex } from './callout-latex.js';
import { escapeTexText } from './latex-escape.js';

// The table's names, for anyone importing callouts.js as before.
export {
	ICONS, VIEWBOX, BUILTIN, PALETTE, CALLOUT_TYPES, BUILTIN_CALLOUT_TYPES,
	applyCustomCallouts, calloutGeneration, resolveType, specFor, calloutIcon,
	builtinCalloutIcon, calloutColor, calloutIconGeometry, calloutAccent, defaultTitle,
	untitledCalloutTitle,
} from './callout-table.js';

/* --- The `Callouts` config key -------------------------------------------------- */

const require = createRequire(import.meta.url);
let fontAwesomeDir;   // undefined: not looked for yet; null: not installed

function fontAwesome() {
	if (fontAwesomeDir === undefined) {
		try {
			fontAwesomeDir = path.dirname(require.resolve('@fortawesome/fontawesome-free/package.json'));
		} catch {
			fontAwesomeDir = null;
		}
	}
	return fontAwesomeDir;
}

// Font Awesome Free's icons as callout-definitions.js expects them —
// `family:name` → [width, height, path] — read from the package's own svgs
// on demand: a definition names a handful, the full table is thousands. Built
// the way Clew-app builds its table (scripts/build.js), so a name resolves to
// the same path data in both.
const iconCache = new Map();
const fontAwesomeIcons = new Proxy({}, {
	get(_, key) {
		if (typeof key !== 'string') return undefined;
		if (!iconCache.has(key)) iconCache.set(key, readIcon(key));
		return iconCache.get(key);
	},
});

function readIcon(key) {
	const m = /^(solid|regular|brands):([a-z0-9-]+)$/.exec(key);
	const dir = fontAwesome();
	if (!m || !dir) return undefined;
	let svg;
	try {
		svg = fs.readFileSync(path.join(dir, 'svgs', m[1], `${m[2]}.svg`), 'utf8');
	} catch {
		return undefined;
	}
	const box = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg);
	const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((match) => match[1]);
	if (!box || !paths.length) return undefined;
	return [Number(box[1]), Number(box[2]), paths.join(' ')];
}

// The definitions the table was last built from (JSON), so they are resolved
// once and not again until they change. Read lazily, from the tokenizer: the
// extension is registered before a document's config is complete.
let configKey;
let hostSeen;   // the host table's version when it was last looked at

function syncConfiguredCallouts() {
	const list = configManager.get('Callouts');
	const key = list == null || (Array.isArray(list) && list.length === 0) ? '' : JSON.stringify(list);
	const host = hostCalloutVersion();
	if (key === configKey && host === hostSeen) return;
	configKey = key;
	hostSeen = host;
	if (!key) {
		installCalloutTable(hostCalloutTable());
		return;
	}
	const { custom, problems } = resolveCallouts({ builtins: BUILTIN_CALLOUT_TYPES, global: list, iconTable: fontAwesomeIcons });
	for (const { index, name, reason, skipped } of problems) {
		const which = index >= 0 ? `entry ${index + 1}${name ? ` (“${name}”)` : ''}` : `“${name}”:`;
		addWarning(`Callouts: ${which} ${skipped ? 'skipped — ' : ''}${reason}`);
	}
	if (fontAwesome() === null && problems.some(({ reason }) => reason.startsWith('no Font Awesome icon'))) {
		addWarning('Callouts: icons are looked up in the @fortawesome/fontawesome-free package, which is not installed');
	}
	installCalloutTable(custom);
}

const escapeHtml = (s) => String(s)
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
	.replace(/"/g, '&quot;');

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
		syncConfiguredCallouts();
		// A type we know, by name or alias; anything else is an unknown type,
		// drawn as a note (specFor).
		const type = resolveType(opener[1]) ?? opener[1].toLowerCase();

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
			written: opener[1],               // the type as written, for an untitled heading
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
		const spec = specFor(token.calloutType);

		if (global.isLatex) {
			const title = token.title
				? this.parser.parseInline(token.titleTokens)
				: escapeTexText(untitledCalloutTitle(token.written));
			const custom = spec.color ? cssColorToRgb(spec.color) : null;
			const accent = calloutAccent(token.calloutType).slice(1);
			const rgb = custom ? legibleOnLight(custom) : [0, 2, 4].map((i) => parseInt(accent.slice(i, i + 2), 16));
			return calloutLatex({
				rgb,
				icon: iconLatex(calloutIconGeometry(token.calloutType)),
				title,
				body: this.parser.parse(token.tokens).trim(),
			});
		}

		const title = token.title
			? this.parser.parseInline(token.titleTokens)
			: escapeHtml(untitledCalloutTitle(token.written));
		const body = this.parser.parse(token.tokens);

		// A custom colour rides on the element as --clew-callout-color (the
		// stylesheet turns it into the accent, made legible on the page), so a
		// site export or a printed page keeps it with no stylesheet of its own.
		const custom = spec.color ? ` style="--clew-callout-color: ${escapeHtml(spec.color)}"` : '';
		// `markdown-alert` classes as well as Obsidian's, so alert styling keeps
		// applying and a vault's own CSS snippets (which target Obsidian's
		// names) keep working.
		const classes = `callout markdown-alert markdown-alert-${token.calloutType}${spec.color ? ' callout-custom' : ''}`;
		const head = `${calloutIcon(token.calloutType)}<span class="callout-title-inner">${title}</span>`;

		if (token.fold) {
			const open = token.fold === '+' ? ' open' : '';
			return `<details class="${classes} is-collapsible" data-callout="${token.calloutType}"${custom}${open}>`
				+ `<summary class="callout-title markdown-alert-title">${head}</summary>`
				+ `<div class="callout-content">\n${body}</div></details>\n`;
		}
		return `<div class="${classes}" data-callout="${token.calloutType}"${custom}>`
			+ `<p class="callout-title markdown-alert-title">${head}</p>`
			+ `<div class="callout-content">\n${body}</div></div>\n`;
	},
};

export default [calloutBlock];
