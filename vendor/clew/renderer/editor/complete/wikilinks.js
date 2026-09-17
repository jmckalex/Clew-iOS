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
// The list is ranked here rather than by CodeMirror, so it is also capped
// here — a 5,000-note vault must not push 5,000 rows into the popup.
const MAX_OPTIONS = 80;

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

	// Each candidate is scored against BOTH its display name and its vault
	// path, best of the two: that is what lets `[[Guide/Li` — or any
	// subsequence spanning a folder, spaces included — find a note, while a
	// bare name still matches the way it always did.
	//
	// The ranking is ours, so the result says `filter: false` and carries NO
	// validFor. Both matter: CodeMirror otherwise re-filters the list with
	// its own matcher against each option's LABEL (a bare basename, which a
	// path query can never match), and validFor would have it reuse that
	// stale set instead of asking again. Re-querying per keystroke is cheap
	// — a few thousand short string comparisons.
	const options = rankLinkCandidates(query, vaultStore.linkCandidates());
	return options.length ? { from, options, filter: false } : null;
}

/**
 * Rank link candidates for a `[[` query. Pure, so it is unit-tested:
 * everything about which note a half-typed path finds lives here, and the
 * completion source above only supplies the vault's candidates.
 */
export function rankLinkCandidates(query, candidates, limit = MAX_OPTIONS) {
	const wantsPath = query.includes('/');
	const seen = new Set();
	const scored = [];
	for (const candidate of candidates) {
		// NUL separates the halves so the key is unambiguous. Written as an
		// escape, not a literal control byte: a raw NUL makes git treat this
		// whole file as binary — no diffs, no blame, no line-level merges.
		const key = candidate.label + '\u0000' + candidate.path;
		if (seen.has(key)) continue;
		seen.add(key);
		// What a link would actually contain: the path minus the extension.
		const linkPath = candidate.path.replace(/\.(md|jmd)$/i, '');
		let score = 0;
		if (query) {
			const byLabel = fuzzyScore(query, candidate.label);
			const byPath = fuzzyScore(query, linkPath);
			if (byLabel === null && byPath === null) continue;
			// A path match is worth slightly less than the same match on the
			// name, so "Note" still ranks the note CALLED Note above one that
			// merely sits in a folder spelled like it.
			score = Math.max(byLabel ?? -Infinity, (byPath ?? -Infinity) - 20);
		}
		scored.push({ candidate, linkPath, score });
	}
	// Ties happen: an alias and its note share a path, so a path query scores
	// them the same. The note itself comes first — an alias is a second name
	// for something already in the list, not a better answer than it.
	scored.sort((a, b) => b.score - a.score
		|| (a.candidate.isAlias ? 1 : 0) - (b.candidate.isAlias ? 1 : 0)
		|| a.candidate.label.localeCompare(b.candidate.label));

	return scored.slice(0, limit).map(({ candidate, linkPath, score }) => ({
		// Typing a path asks for a path: insert the full vault path, so the
		// link means the file you picked rather than whatever the bare name
		// resolves to. An alias is a name either way.
		apply: wantsPath && !candidate.isAlias ? linkPath : candidate.label,
		label: candidate.label,
		detail: candidate.isAlias ? `→ ${candidate.path}` : candidate.path,
		type: candidate.isAlias ? 'text' : 'keyword',
		boost: Math.min(99, Math.max(-99, Math.round(score / 12))),
	}));
}
