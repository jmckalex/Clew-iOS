// Small subsequence fuzzy matcher shared by the quick switcher, the command
// palette, and completion ranking. Higher score = better; null = no match.
// Bonuses: consecutive runs, word starts (after space / - _ / . or camelCase),
// early match position, exact-substring.

const WORD_BOUNDARY = /[\s\-_/.]/;

export function fuzzyScore(query, candidate) {
	if (!query) return 0;
	const q = query.toLowerCase();
	const c = candidate.toLowerCase();

	const substringAt = c.indexOf(q);
	if (substringAt !== -1) {
		// Exact substring: strong score, better the earlier and the shorter.
		return 1000 - substringAt * 2 - (c.length - q.length);
	}

	let score = 0;
	let ci = 0;
	let lastMatch = -2;
	for (let qi = 0; qi < q.length; qi++) {
		const ch = q[qi];
		let found = -1;
		while (ci < c.length) {
			if (c[ci] === ch) { found = ci; break; }
			ci++;
		}
		if (found === -1) return null;
		score += 10;
		if (found === lastMatch + 1) score += 8; // consecutive
		if (found === 0 || WORD_BOUNDARY.test(candidate[found - 1])
			|| (candidate[found] >= 'A' && candidate[found] <= 'Z')) {
			score += 12; // word start
		}
		score -= Math.min(found, 20) * 0.5; // earlier is better
		lastMatch = found;
		ci = found + 1;
	}
	return score - (c.length - q.length) * 0.1;
}

/** Rank a list by fuzzyScore against `key(item)`, dropping non-matches. */
export function fuzzyFilter(query, items, key, limit = 50) {
	const scored = [];
	for (const item of items) {
		const score = fuzzyScore(query, key(item));
		if (score !== null) scored.push({ item, score });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map((s) => s.item);
}
