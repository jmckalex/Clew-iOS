// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// [[ wikilink completion: note names and aliases from the vault index;
// after `#`, the target note's headings. Unresolved names can still be typed
// (click-to-create handles them later).
import { vaultStore } from '../../state/vault-store.js';
import { fuzzyScore } from '../../lib/fuzzy.js';

const LINK_PREFIX = /\[\[([^\[\]#|]*)$/;
const HEADING_PREFIX = /\[\[([^\[\]#|]*)#([^\[\]|]*)$/;

export function wikilinkCompletions(context) {
	const line = context.state.doc.lineAt(context.pos);
	const before = line.text.slice(0, context.pos - line.from);

	const headingMatch = HEADING_PREFIX.exec(before);
	if (headingMatch) {
		const target = headingMatch[1].trim();
		const path = target
			? vaultStore.resolveNoteName(target)
			: null; // [[#… — same-file headings need the active note; skip for now
		if (!path) return null;
		const from = context.pos - headingMatch[2].length;
		// A caret switches the list from headings to block identifiers. The
		// caret stays in the completion label and in what gets applied, so the
		// result is the `#^id` Obsidian expects rather than a bare id that
		// would silently resolve to nothing.
		const options = headingMatch[2].startsWith('^')
			? vaultStore.blocksFor(path).map((b) => ({
				label: `^${b.id}`,
				detail: `line ${b.line}`,
				type: 'property',
				apply: `^${b.id}`,
			}))
			: vaultStore.headingsFor(path).map((h) => ({
				label: h.text,
				type: 'text',
				apply: h.text,
			}));
		return options.length ? { from, options, validFor: /^[^\[\]#|]*$/ } : null;
	}

	const match = LINK_PREFIX.exec(before);
	if (!match) return null;
	const query = match[1];
	const from = context.pos - query.length;
	if (!context.explicit && query.length === 0) {
		// Opening `[[` alone pops the full list — helpful, Obsidian-like.
	}

	const seen = new Set();
	const options = [];
	for (const candidate of vaultStore.linkCandidates()) {
		const score = query ? fuzzyScore(query, candidate.label) : 0;
		if (score === null) continue;
		// NUL separates the halves so the key is unambiguous. Written as an
		// escape, not a literal control byte: a raw NUL makes git treat this
		// whole file as binary — no diffs, no blame, no line-level merges.
		const key = candidate.label + '\u0000' + candidate.path;
		if (seen.has(key)) continue;
		seen.add(key);
		options.push({
			label: candidate.label,
			detail: candidate.isAlias ? `→ ${candidate.path}` : candidate.path,
			type: candidate.isAlias ? 'text' : 'keyword',
			boost: Math.min(99, Math.max(-99, Math.round((score ?? 0) / 12))),
			apply: candidate.label,
		});
	}
	return options.length ? { from, options, validFor: /^[^\[\]#|]*$/ } : null;
}
