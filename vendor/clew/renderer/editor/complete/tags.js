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
