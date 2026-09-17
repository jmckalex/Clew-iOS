// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The disclosure state of a note embed, written in the link itself:
//
//   ![[Week 3]]                 an embed, as always — no disclosure at all
//   ![[Week 3|collapsed]]       collapsible, starts closed
//   ![[Week 3|open]]            collapsible, starts open
//   ![[Week 3|Reading|open]]    …with "Reading" still the title
//
// The state lives in the note because that is the only place that travels:
// with the file, into git, into a shared vault, into Obsidian (which shows
// the keyword as the embed's title and is otherwise none the wiser).
//
// Toggling in reading mode rewrites the link, which is why this module is
// imported by BOTH the engine extension that reads the keyword and the
// renderer action that writes it — the block-refs.js/block-ids.js
// arrangement, for the same reason: a reader and a writer that disagree
// about the syntax would corrupt notes. Keep it free of node imports, or
// the renderer bundle can no longer have it.
// Two independent modes, both written as trailing alias keywords:
//   state  — whether a disclosable embed starts folded
//   chrome — how much of the embed's frame is drawn
//
//   ![[Week 3]]                  the framed box, as it has always been
//   ![[Week 3|quiet]]            the accent stripe alone, title kept
//   ![[Week 3|bare]]             no frame at all — reads as part of the note
//   ![[Week 3|Reading|quiet|collapsed]]   …with a title, and folded
export const STATES = ['collapsed', 'open'];
export const CHROMES = ['quiet', 'bare'];

const MODE_OF = new Map([
	...STATES.map((k) => [k, 'state']),
	...CHROMES.map((k) => [k, 'chrome']),
]);

/**
 * Split trailing mode keywords off an embed alias — any run of them, in any
 * order, so `|quiet|collapsed` and `|collapsed|quiet` mean the same thing.
 * Returns the state, the chrome (null where the alias carries none) and what
 * is left to use as the title (null when the keywords were the whole of it —
 * a mode is not a caption, the rule the office `|live` alias set).
 *
 * Scanning from the RIGHT and stopping at the first non-keyword is what keeps
 * a title honest: someone whose note is genuinely called "Bare" still gets it
 * as a title in `![[X|Bare|quiet]]`, because only the tail is consumed.
 */
export function parseEmbedModes(alias) {
	const found = { state: null, chrome: null, alias: null };
	if (!alias) return found;
	const parts = alias.split('|').map((s) => s.trim());
	while (parts.length) {
		const mode = MODE_OF.get(parts[parts.length - 1].toLowerCase());
		// Stop at anything that is not a keyword, and at a REPEAT of a mode
		// already read — in `|quiet|bare` the last one wins and the earlier
		// becomes title text, rather than being silently dropped.
		if (!mode || found[mode] !== null) break;
		found[mode] = parts.pop().toLowerCase();
	}
	found.alias = parts.join('|') || null;
	return found;
}

// Embeds are own-line blocks (the tokenizer accepts nothing else), so a whole
// line is the unit this rewrites. Groups: indent+opener, target, #fragment,
// |alias, closer+trailing space.
const EMBED_LINE_RE = /^(\s*!\[\[)([^\[\]|#\n]*)((?:#[^\[\]|\n]+)?)((?:\|[^\[\]\n]+)?)(\]\][ \t]*)$/;

/**
 * Rewrite one source line so its embed carries `state` ('collapsed' | 'open'
 * | null to remove it), preserving any real alias AND any chrome keyword.
 * Returns the new line, or null when the line is not an embed — which is how
 * a caller learns the line numbers drifted and it should not write anything.
 *
 * Keywords come back out in a canonical `title|chrome|state` order, so a
 * hand-written `|collapsed|quiet` is tidied to `|quiet|collapsed` the first
 * time it is toggled. Reordering the author's own words is a liberty, but a
 * small and stable one: it means two notes that mean the same thing read the
 * same, and the round trip is then a fixed point.
 */
export function setEmbedState(lineText, state) {
	const match = EMBED_LINE_RE.exec(lineText);
	if (!match) return null;
	const [, opener, target, fragment, aliasPart, closer] = match;
	const { alias, chrome } = parseEmbedModes(aliasPart ? aliasPart.slice(1) : null);
	const segments = [alias, chrome, state].filter(Boolean);
	return opener + target + fragment
		+ (segments.length ? '|' + segments.join('|') : '') + closer;
}
