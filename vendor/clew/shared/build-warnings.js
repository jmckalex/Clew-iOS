// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The engine's build warnings, grouped for saying (renderer/build-warnings.js).
// Every build returns its warnings (warnings.js), and since jmarkdown 0631c42
// that includes the LaTeX-export lint — `latex-export [code]: message`, the
// codes stable (dollars, display-math, mathjax-only, package, backslash,
// braces) — on every render, HTML included. A note may hold the same mistake
// many times, so the codes are what is said first, with a count each;
// everything else (an unresolved reference, an unreadable .bib) is "other".

const LINT = /^latex-export \[([a-z-]+)\]:\s*([\s\S]*)$/;

/**
 * @param {string[]} warnings - as the engine reports them
 * @returns {{ total: number, codes: { code: string, count: number }[], other: number,
 *   items: { code: string|null, text: string }[] }} codes in order of first appearance
 */
export function groupWarnings(warnings = []) {
	const items = [];
	const counts = new Map();
	let other = 0;
	for (const warning of warnings) {
		const m = LINT.exec(String(warning));
		if (m) {
			counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
			items.push({ code: m[1], text: m[2].trim() });
		} else {
			other += 1;
			items.push({ code: null, text: String(warning).trim() });
		}
	}
	return {
		total: items.length,
		codes: [...counts].map(([code, count]) => ({ code, count })),
		other,
		items,
	};
}

/** One line: "LaTeX export: dollars ×2, braces · 1 other", or ''. */
export function warningSummary(warnings = []) {
	const { codes, other } = groupWarnings(warnings);
	const parts = [];
	if (codes.length) parts.push(`LaTeX export: ${codes.map(({ code, count }) => (count > 1 ? `${code} ×${count}` : code)).join(', ')}`);
	if (other) parts.push(`${other} other`);
	return parts.join(' · ');
}
