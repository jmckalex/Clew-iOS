// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Diary logic, pure and shared: date formatting/parsing against the
// configurable dailyNoteFormat, single-log-file section management (date
// headings, newest first), and composition of day/interval/whole views.
// No fs, no DOM — the renderer's diary actions and the tests both use this.

/** Format a date by the diary format (YYYY, MM, DD tokens; HH/mm too). */
export function formatDiaryDate(date, format) {
	const pad = (n) => String(n).padStart(2, '0');
	return format
		.replace(/YYYY/g, date.getFullYear())
		.replace(/MM/g, pad(date.getMonth() + 1))
		.replace(/DD/g, pad(date.getDate()))
		.replace(/HH/g, pad(date.getHours()))
		.replace(/mm/g, pad(date.getMinutes()));
}

/** A regex matching dates written in `format`, with named-ish captures. */
function formatRegex(format) {
	const order = [];
	const source = format.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		.replace(/YYYY|MM|DD/g, (token) => {
			order.push(token);
			return token === 'YYYY' ? '(\\d{4})' : '(\\d{2})';
		});
	return { re: new RegExp(source), order };
}

/** Parse text written in the diary format back to a local Date (midnight),
 *  or null. The format must contain YYYY, MM, and DD to be diary-usable. */
export function parseDiaryDate(text, format) {
	if (!/YYYY/.test(format) || !/MM/.test(format) || !/DD/.test(format)) return null;
	const { re, order } = formatRegex(format);
	const match = re.exec(text.trim());
	if (!match || match[0] !== text.trim()) return null;
	const parts = {};
	order.forEach((token, i) => { parts[token] = Number(match[i + 1]); });
	const date = new Date(parts.YYYY, parts.MM - 1, parts.DD);
	// Reject impossible dates (Feb 31 rolls over in the Date constructor).
	if (date.getMonth() !== parts.MM - 1 || date.getDate() !== parts.DD) return null;
	return date;
}

/** ISO day key (YYYY-MM-DD, local) — the internal identity of a diary day. */
export function dayKey(date) {
	const pad = (n) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---- single-log-file sections ----------------------------------------------

/**
 * Find the date sections of a log file: level-1/2 headings whose text parses
 * as a diary date. Returns [{key, heading, line, from, to}] in file order,
 * where from/to are character offsets of the whole section (heading through
 * the line before the next date heading / EOF).
 */
export function parseLogSections(text, format) {
	const lines = text.split('\n');
	const sections = [];
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		const match = /^#{1,2}[ \t]+(.+?)[ \t]*$/.exec(lines[i]);
		if (match) {
			const date = parseDiaryDate(match[1], format);
			if (date) {
				sections.push({ key: dayKey(date), heading: match[1], line: i + 1, from: offset, to: text.length });
			}
		}
		offset += lines[i].length + 1;
	}
	for (let i = 0; i < sections.length - 1; i++) sections[i].to = sections[i + 1].from;
	return sections;
}

/**
 * Ensure the log has a section for `date`, inserting `# <formatted>` (plus
 * optional seed content) at its chronological position — newest first.
 * Returns { text, line } with the heading's 1-based line.
 */
export function upsertLogSection(text, date, format, seed = '') {
	const sections = parseLogSections(text, format);
	const key = dayKey(date);
	const existing = sections.find((s) => s.key === key);
	if (existing) return { text, line: existing.line };

	const block = `# ${formatDiaryDate(date, format)}\n\n${seed ? seed.trimEnd() + '\n\n' : ''}`;
	// Newest first: insert before the first section older than `date`;
	// no sections (or all newer) → append at the end.
	const before = sections.find((s) => s.key < key);
	if (!before) {
		const base = text.length === 0 || text.endsWith('\n\n') ? text
			: text.endsWith('\n') ? text + '\n' : text + '\n\n';
		return { text: base + block, line: base.split('\n').length };
	}
	const next = text.slice(0, before.from) + block + text.slice(before.from);
	return { text: next, line: text.slice(0, before.from).split('\n').length };
}

/** The sections of a log in [fromKey, toKey], newest first, as
 *  {key, heading, body} — body excludes the heading line. */
export function extractLogRange(text, format, fromKey, toKey) {
	return parseLogSections(text, format)
		.filter((s) => s.key >= fromKey && s.key <= toKey)
		.sort((a, b) => b.key.localeCompare(a.key))
		.map((s) => {
			const section = text.slice(s.from, s.to).trimEnd();
			return { key: s.key, heading: s.heading, body: section.split('\n').slice(1).join('\n').trim() };
		});
}

/** Substitute {{date}}, {{time}}, {{title}} in a template body. */
export function substituteTemplate(text, { title } = {}) {
	const now = new Date();
	return text
		.replace(/\{\{date(?::([^}]+))?\}\}/g, (_, fmt) => formatDiaryDate(now, fmt || 'YYYY-MM-DD'))
		.replace(/\{\{time(?::([^}]+))?\}\}/g, (_, fmt) => formatDiaryDate(now, fmt || 'HH:mm'))
		.replace(/\{\{title\}\}/g, title ?? '');
}

// ---- composition ------------------------------------------------------------

/**
 * Compose a generated diary view from per-day markdown chunks (newest
 * first). Each entry: {key, heading, body}. In files mode `body` is a whole
 * daily note (a leading H1 gets demoted so day headings stay the outline).
 */
export function composeDiaryView(title, entries) {
	const parts = [
		`# ${title}`,
		'',
		'> [!NOTE]',
		'> A generated view of your diary — edits here are discarded on the',
		'> next view. Open a day from the calendar to write.',
		'',
	];
	for (const { heading, body } of entries) {
		if (heading) parts.push(`## ${heading}`, '');
		const demoted = body.replace(/^#[ \t]+/, '### ').replace(/\n#[ \t]+/g, '\n### ');
		parts.push(demoted.trimEnd(), '');
	}
	return parts.join('\n').trimEnd() + '\n';
}

/** Every day key from `fromKey` to `toKey` inclusive, newest first. */
export function dayKeysInRange(fromKey, toKey) {
	const [fy, fm, fd] = fromKey.split('-').map(Number);
	const [ty, tm, td] = toKey.split('-').map(Number);
	const out = [];
	const cursor = new Date(ty, tm - 1, td);
	const stop = new Date(fy, fm - 1, fd);
	while (cursor >= stop && out.length < 5000) {
		out.push(dayKey(cursor));
		cursor.setDate(cursor.getDate() - 1);
	}
	return out;
}
