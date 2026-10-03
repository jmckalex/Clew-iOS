// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The text side of edit-conflict safety, import-free so the Node tests take
// it directly: history's snapshot names, the "(conflict date)" sibling,
// Dropbox's conflicted-copy names, git's markers, and the line diff behind
// the compare view. Clew-iOS's module (its src/shim/conflict-text.js,
// conflict-safety branch), shared here so the two cannot drift — the desktop
// side is renderer/conflicts.js and main/write-guard.js.
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** main/history.js's snapshot name for `ms` (history.js uses this one). */
export function historyStamp(ms) {
	const d = new Date(ms);
	return `${dayOf(d)} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}

/** "Folder/Note (conflict 2026-10-03).md", deduped with " 2", " 3" … */
export function conflictSiblingPath(rel, exists, date = new Date()) {
	const slash = rel.lastIndexOf('/');
	const dir = slash >= 0 ? rel.slice(0, slash + 1) : '';
	const base = rel.slice(slash + 1);
	const dot = base.lastIndexOf('.');
	const stem = dot > 0 ? base.slice(0, dot) : base;
	const ext = dot > 0 ? base.slice(dot) : '';
	let candidate = `${dir}${stem} (conflict ${dayOf(date)})${ext}`;
	for (let n = 2; exists(candidate); n++) candidate = `${dir}${stem} (conflict ${dayOf(date)} ${n})${ext}`;
	return candidate;
}

/** Dropbox's loser beside a note: "Note (Name's conflicted copy 2026-10-03).md"
 *  (the date and a "(1)" counter optional). Matched on the file name. */
const DROPBOX_COPY = /^(.*) \((.+?)['’]s conflicted copy(?: (\d{4}-\d{2}-\d{2}))?(?: \(\d+\))?\)(\.[^./]+)?$/;

/** Every Dropbox conflicted copy whose note still exists: [{copy, base, who, date}]. */
export function findDropboxCopies(paths) {
	const all = new Set(paths);
	const found = [];
	for (const copy of paths) {
		const slash = copy.lastIndexOf('/');
		const dir = slash >= 0 ? copy.slice(0, slash + 1) : '';
		const m = DROPBOX_COPY.exec(copy.slice(slash + 1));
		if (!m) continue;
		const base = `${dir}${m[1]}${m[4] ?? ''}`;
		if (all.has(base)) found.push({ copy, base, who: m[2], date: m[3] ?? null });
	}
	return found;
}

/** A git merge's markers, all three, each at the start of a line. */
export function hasGitConflictMarkers(text) {
	const t = String(text ?? '');
	return /^<{7}(?: |$)/m.test(t) && /^={7}$/m.test(t) && /^>{7}(?: |$)/m.test(t);
}

/**
 * A line diff for the compare view: [{op: ' ' | '-' | '+', text}], '-' for
 * a line only in `a`, '+' only in `b`. Longest common subsequence over the
 * lines between the common head and tail; past `cap` cells it gives up and
 * returns null (the view then shows both texts whole).
 */
export function lineDiff(a, b, cap = 4_000_000) {
	const A = String(a ?? '').split('\n');
	const B = String(b ?? '').split('\n');
	let head = 0;
	while (head < A.length && head < B.length && A[head] === B[head]) head++;
	let tail = 0;
	while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail++;
	const a1 = A.slice(head, A.length - tail);
	const b1 = B.slice(head, B.length - tail);
	const n = a1.length;
	const m = b1.length;
	if ((n + 1) * (m + 1) > cap) return null;
	const L = new Uint32Array((n + 1) * (m + 1));
	const at = (i, j) => i * (m + 1) + j;
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			L[at(i, j)] = a1[i] === b1[j] ? L[at(i + 1, j + 1)] + 1 : Math.max(L[at(i + 1, j)], L[at(i, j + 1)]);
		}
	}
	const out = A.slice(0, head).map((text) => ({ op: ' ', text }));
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a1[i] === b1[j]) { out.push({ op: ' ', text: a1[i] }); i++; j++; }
		else if (L[at(i + 1, j)] >= L[at(i, j + 1)]) out.push({ op: '-', text: a1[i++] });
		else out.push({ op: '+', text: b1[j++] });
	}
	while (i < n) out.push({ op: '-', text: a1[i++] });
	while (j < m) out.push({ op: '+', text: b1[j++] });
	for (const text of A.slice(A.length - tail)) out.push({ op: ' ', text });
	return out;
}
