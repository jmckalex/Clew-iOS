// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// #tag completion from the vault index (nested tags offered whole).
import { vaultStore } from '../../state/vault-store.js';
import { fuzzyScore } from '../../lib/fuzzy.js';

const TAG_PREFIX = /(^|[\s(,;])#([A-Za-z0-9_/-]*)$/;

export function tagCompletions(context) {
	const line = context.state.doc.lineAt(context.pos);
	const before = line.text.slice(0, context.pos - line.from);
	const match = TAG_PREFIX.exec(before);
	if (!match) return null;
	const query = match[2];
	const from = context.pos - query.length;

	const options = [];
	for (const [tag, info] of vaultStore.tagIndex()) {
		const score = query ? fuzzyScore(query, tag) : 0;
		if (score === null) continue;
		options.push({
			label: `#${tag}`,
			detail: `${info.count} note${info.count === 1 ? '' : 's'}`,
			type: 'labelName',
			boost: Math.min(99, Math.max(-99, Math.round((score ?? 0) / 12))),
			apply: tag,
		});
	}
	return options.length ? { from, options, validFor: /^[A-Za-z0-9_/-]*$/ } : null;
}
