// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The colon directives' retirement, phase 2 — "Convert this vault": what ONE
// note's conversion is, as text in and text out. main/colon-conversion.js runs
// it over a vault (the disk, the backups, undo); renderer/colon-conversion.js
// is the sheet. Pure — no Node built-in, no DOM — so Clew-iOS can run it too.
//
// The converter is the engine's (`#jmarkdown/colon-to-at.js`, import-free); this
// module only decides what the sheet offers and what a choice writes:
//
// - A note is planned from a dry run. Its `same` items convert by default.
//   Its `changes-output` items are rows of their own, unticked: the why, and
//   the @ form they would get. `needs-you` items the converter leaves alone
//   are rows with their reason and no box. `prose` items are never shown
//   (Clew-boss, 2026-10-11: on the demo vault all 18 were Meta Bind fields and
//   a Kanban comment, which change nothing) — only counted, for a debug log.
// - A note that LOADS directives (its header's `Load directives`, a folder's
//   or the global `.jmarkdown/config.json` `Directives`/`Optionals`) may define
//   any name it uses, so every colon name in it is passed to the converter as
//   `customDirectives` (Clew-boss's call): every row is needs-you, nothing
//   converts by default, and "Convert anyway" converts one as a note that
//   loads nothing would (its preview is that second dry run's).
// - What is written is one more run of the converter with `keep` — the opening
//   lines NOT chosen — and is checked against the plan before it is returned.
//   `keep` works by LINE, so a row is a line: every directive on it goes, or
//   none does.
// - The converter reads CRLF as LF and writes LF; a CRLF note is given its
//   CRLF back, and a note whose lines end both ways is left alone (converting
//   it would change every line ending).
import { convert } from '#jmarkdown/colon-to-at.js';

const HEADER_STYLE = 'fenced';

/** 'lf' | 'crlf' | 'mixed' — how a text's lines end (a text without a
 *  line break is 'lf'). */
export function lineEndings(text) {
	const crlf = (text.match(/\r\n/g) ?? []).length;
	if (!crlf) return /\r/.test(text) ? 'mixed' : 'lf';
	const lf = (text.match(/\n/g) ?? []).length;
	return crlf === lf && !/\r(?!\n)/.test(text) ? 'crlf' : 'mixed';
}

/** Whether a note's own fenced header loads directives (`Load directives:`,
 *  any case — the engine's header keys are matched without case). */
export function headerLoadsDirectives(text) {
	const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(text);
	return !!m && /^load directives\s*:/im.test(m[1]);
}

/** Whether a parsed `.jmarkdown/config.json` loads directives: the key that
 *  does it, or null. `Optionals` count — the engine registers each as a
 *  colon directive (metadata-header.js#parseOptionals). */
export function configLoadsDirectives(config) {
	if (!config || typeof config !== 'object') return null;
	for (const key of ['Directives', 'Optionals']) {
		const v = config[key];
		if (Array.isArray(v) ? v.length : typeof v === 'string' && v.trim()) return key;
	}
	return null;
}

/** Why a row of a directive-loading note waits for a person. `loads`:
 *  { by: 'header' } | { by: 'folder', file, key } | { by: 'global', file, key }. */
function loadsWhy(loads, names) {
	const which = names.length === 1 ? `\`${names[0]}\`` : names.map((n) => `\`${n}\``).join(', ');
	const where = loads.by === 'header' ? 'this note loads directives of its own (Load directives)'
		: loads.by === 'folder' ? `${loads.file} loads directives (${loads.key})`
		: `your ${loads.file ?? '~/.jmarkdown/config.json'} loads directives (${loads.key})`;
	return `${where}; one may define ${which}`;
}

const converts = (c) => c.to !== undefined && (c.kind === 'same' || c.kind === 'changes-output');
const itemOf = (c) => {
	const item = { name: c.name, kind: c.kind, from: c.from };
	if (c.to !== undefined) item.to = c.to;
	if (c.why) item.why = c.why;
	if (c.generic) item.generic = true;
	return item;
};

/**
 * The plan for one note's text.
 * @param {string} text
 * @param {{ loads?: object|null }} [opts] — set when the note loads directives
 * @returns {{
 *   auto: number[],          opening lines converted by default
 *   autoItems: number,       directives on them
 *   autoList: { line, name, from, to }[],  those directives
 *   rows: { line: number, kind: 'changes-output'|'needs-you', choice: boolean,
 *           why: string, items: object[] }[],
 *   prose: object[],         never shown (a debug log may list them)
 *   loads: object|null,
 * }}
 */
export function planNote(text, { loads = null } = {}) {
	// Every directive as a note that loads nothing would convert it: the
	// default for most notes, the "anyway" for the rest.
	const plain = convert(text, { headerStyle: HEADER_STYLE }).changes;
	const prose = plain.filter((c) => c.kind === 'prose');
	const real = plain.filter((c) => c.kind !== 'prose');
	const byLine = new Map();
	for (const c of real) {
		if (!byLine.has(c.line)) byLine.set(c.line, []);
		byLine.get(c.line).push(c);
	}
	const rows = [];
	const auto = [];
	const autoList = [];
	if (loads) {
		// Every colon name in the note, as customDirectives: the converter then
		// leaves each one (needs-you). A line it would still convert — `:index[`,
		// which no directive claims, a legacy `::Bibliography` — is a row all the
		// same: over-flagging is the right side.
		const names = [...new Set(real.map((c) => c.name).filter(Boolean))];
		const flagged = convert(text, { headerStyle: HEADER_STYLE, customDirectives: names }).changes
			.filter((c) => c.kind !== 'prose');
		const own = new Set(byLine.keys());
		for (const c of flagged) if (!byLine.has(c.line)) byLine.set(c.line, [c]);
		for (const [line, items] of [...byLine].sort((a, b) => a[0] - b[0])) {
			const named = [...new Set(items.map((c) => c.name).filter(Boolean))];
			// The converter's own reasons, from the plain run only: under
			// customDirectives every reason is "the document loads it itself".
			const left = own.has(line) ? items.filter((c) => !converts(c) && c.why) : [];
			rows.push({
				line, kind: 'needs-you', choice: items.some(converts),
				why: [loadsWhy(loads, named.length ? named : ['it']), ...left.map((c) => c.why)].join('; '),
				items: items.map(itemOf),
			});
		}
		return { auto, autoItems: 0, autoList, rows, prose, loads };
	}
	for (const [line, items] of [...byLine].sort((a, b) => a[0] - b[0])) {
		const output = items.filter((c) => c.kind === 'changes-output');
		if (output.length) {
			rows.push({ line, kind: 'changes-output', choice: true, why: output.map((c) => c.why).filter(Boolean).join('; '), items: items.map(itemOf) });
		} else if (items.some(converts)) {
			auto.push(line);
			for (const c of items.filter(converts)) autoList.push({ line, name: c.name, from: c.from, to: c.to });
		}
		// What the converter leaves wherever it stands, with its reason. On a
		// line whose other directives convert by default it is a row too.
		const left = items.filter((c) => c.kind === 'needs-you');
		if (left.length && !output.length) {
			rows.push({ line, kind: 'needs-you', choice: false, why: left.map((c) => c.why).filter(Boolean).join('; '), items: left.map(itemOf) });
		}
	}
	return { auto, autoItems: autoList.length, autoList, rows, prose, loads };
}

/** Whether a plan has anything to show or do. */
export const planIsEmpty = (plan) => !plan.auto.length && !plan.rows.length;

/**
 * The text after converting the default lines and the `chosen` rows' lines.
 * Throws (writing nothing is the caller's answer) when the note's lines end
 * both ways, or when the converter's run disagrees with the plan.
 * @returns {{ text: string, converted: number, lines: number[] }}
 */
export function applyPlan(text, plan, chosen = []) {
	const endings = lineEndings(text);
	if (endings === 'mixed') throw Object.assign(new Error('its lines end both ways (CRLF and LF): converting it would change every line ending'), { code: 'EMIXED' });
	const choosable = new Set(plan.rows.filter((r) => r.choice).map((r) => r.line));
	const lines = new Set([...plan.auto, ...chosen.filter((l) => choosable.has(l))]);
	// Every opening line the converter WOULD convert (a note that loads nothing),
	// less the chosen ones, is kept as written.
	const plain = convert(text, { headerStyle: HEADER_STYLE }).changes.filter(converts);
	const keep = [...new Set(plain.map((c) => c.line))].filter((l) => !lines.has(l));
	const result = convert(text, { headerStyle: HEADER_STYLE, keep });
	const done = result.changes.filter(converts);
	const expected = plain.filter((c) => lines.has(c.line)).length;
	const stray = done.find((c) => !lines.has(c.line));
	if (stray || done.length !== expected) {
		throw Object.assign(new Error(`the converter's run disagreed with its preview (${stray ? `line ${stray.line} converted unasked` : `${done.length} converted, ${expected} expected`})`), { code: 'EDISAGREE' });
	}
	const out = endings === 'crlf' ? result.text.replace(/\n/g, '\r\n') : result.text;
	return { text: out, converted: done.length, lines: [...lines].sort((a, b) => a - b) };
}
