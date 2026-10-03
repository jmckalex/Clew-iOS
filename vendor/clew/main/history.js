// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Note history: .clew/history/ keeps recent versions of every note (and
// canvas), so auto-save can never silently eat a paragraph. The layout
// mirrors the vault — .clew/history/<note path>/<stamp><ext> — where the
// note's own name becomes a directory and each snapshot inside it is a
// plain copy a user could recover by hand with no tooling at all.
//
// Snapshots are taken of the PRE-WRITE disk content, at most one per
// interval of active editing, and each is named (and mtime-stamped) after
// the moment that content was last written — not the moment it was
// displaced — so the restore list answers "what did this note say at
// 10:04" truthfully. Stamps avoid ':' (Windows) and sort lexically.
//
// Per-vault tuning rides in vault-settings.json under `history`:
// false disables; { minIntervalMinutes, maxVersions, maxAgeDays }
// override the defaults. Pruning always spares the newest snapshot, so
// even a note untouched for a year keeps one fallback version.
import fs from 'node:fs';
import path from 'node:path';
import { historyStamp } from '../shared/conflict-text.js';

const DEFAULTS = { minIntervalMinutes: 5, maxVersions: 40, maxAgeDays: 60 };
const TRACKED = /\.(md|jmd|canvas)$/i;
const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})\.(\d{2})\.(\d{2})(?:-(\d+))?$/;

export function isTracked(rel) {
	return TRACKED.test(rel);
}

function normalize(raw) {
	if (raw === false) return null;
	const opts = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
	return {
		minIntervalMs: Math.max(0, opts.minIntervalMinutes) * 60_000,
		maxVersions: Math.max(1, opts.maxVersions),
		maxAgeMs: Math.max(1, opts.maxAgeDays) * 86_400_000,
	};
}

function historyDir(root, rel) {
	return path.join(root, '.clew', 'history', rel);
}

// The stamp is shared with the conflict code (and Clew-iOS), which keeps
// versions under the same names.
const stampFor = historyStamp;

/** Snapshot files in `dir`, newest first (same-second copies by counter). */
function entriesIn(dir) {
	let names;
	try { names = fs.readdirSync(dir); } catch { return []; }
	return names
		.map((name) => {
			const m = STAMP_RE.exec(path.basename(name, path.extname(name)));
			if (!m) return null;
			return {
				name,
				time: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(),
				counter: m[7] ? +m[7] : 0,
			};
		})
		.filter(Boolean)
		.sort((a, b) => b.time - a.time || b.counter - a.counter);
}

/**
 * Preserve the current disk content of `rel` before it is overwritten.
 * Rate-limited by the interval (unless `force`, which restore uses so the
 * displaced text is never lost); skipped when the content is identical to
 * the newest snapshot. Never throws — a history failure must not block
 * the save it protects.
 */
export function snapshotBeforeWrite(root, rel, rawOptions, { force = false } = {}) {
	const opts = normalize(rawOptions);
	if (!opts || !isTracked(rel)) return null;
	try {
		const abs = path.join(root, rel);
		let stat;
		try { stat = fs.statSync(abs); } catch { return null; /* new note */ }
		const dir = historyDir(root, rel);
		const existing = entriesIn(dir);
		const newest = existing[0];
		if (newest && !force && stat.mtimeMs - newest.time < opts.minIntervalMs) return null;
		if (newest) {
			const prev = fs.readFileSync(path.join(dir, newest.name));
			if (prev.equals(fs.readFileSync(abs))) return null;
		}
		const name = snapshotName(existing, stampFor(stat.mtimeMs), path.extname(rel));
		fs.mkdirSync(dir, { recursive: true });
		fs.copyFileSync(abs, path.join(dir, name));
		fs.utimesSync(path.join(dir, name), stat.mtime, stat.mtime);
		prune(dir, [{ name, time: stat.mtimeMs }, ...existing], opts);
		return name;
	} catch (err) {
		console.warn(`[clew] history snapshot failed (${rel}):`, err?.message ?? err);
		return null;
	}
}

/**
 * A snapshot's file name for `stamp`. A same-second copy takes the counter
 * AFTER the highest in use, never the lowest free one: pruning frees low
 * counters, and a reused one sorts the newest copy below its elders
 * (entriesIn orders them by counter), so `newest` would name an older one.
 */
function snapshotName(existing, stamp, ext) {
	const sameSecond = existing.filter((e) => {
		const base = path.basename(e.name, path.extname(e.name));
		return base === stamp || base.startsWith(stamp + '-');
	});
	return sameSecond.length === 0 ? stamp + ext
		: `${stamp}-${Math.max(...sameSecond.map((e) => e.counter)) + 1}${ext}`;
}

/**
 * Keep `text` as a version of `rel` NOW — the conflict code's safety net
 * (renderer/conflicts.js): both sides of a conflict go here before anything
 * is chosen, whatever the interval, and even with history turned off for
 * the vault (a conflict's versions are not history's to decline). Skipped
 * when it equals the newest snapshot. Never throws; returns the snapshot's
 * name, or null.
 */
export function keepVersion(root, rel, text, { now = Date.now() } = {}) {
	if (!isTracked(rel)) return null;
	try {
		const dir = historyDir(root, rel);
		const existing = entriesIn(dir);
		const body = Buffer.from(String(text ?? ''));
		if (existing[0]) {
			try { if (fs.readFileSync(path.join(dir, existing[0].name)).equals(body)) return existing[0].name; } catch { /* unreadable: keep anew */ }
		}
		const name = snapshotName(existing, stampFor(now), path.extname(rel));
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, name), body);
		const when = new Date(now);
		fs.utimesSync(path.join(dir, name), when, when);
		return name;
	} catch (err) {
		console.warn(`[clew] could not keep a version of ${rel}:`, err?.message ?? err);
		return null;
	}
}

/** Drop snapshots beyond the count cap or age cap — never the newest. */
function prune(dir, entries, opts) {
	const cutoff = Date.now() - opts.maxAgeMs;
	entries.forEach((entry, i) => {
		if (i === 0) return;
		if (i >= opts.maxVersions || entry.time < cutoff) {
			fs.rmSync(path.join(dir, entry.name), { force: true });
		}
	});
}

/** Snapshots for one note, newest first: [{ id, time, size }]. */
export function listSnapshots(root, rel) {
	const dir = historyDir(root, rel);
	return entriesIn(dir).map(({ name, time }) => {
		let size = 0;
		try { size = fs.statSync(path.join(dir, name)).size; } catch { /* raced away */ }
		return { id: name, time, size };
	});
}

/** One snapshot's text. The id must be a bare name listSnapshots produced. */
export function readSnapshot(root, rel, id) {
	if (path.basename(id) !== id || !STAMP_RE.test(path.basename(id, path.extname(id)))) {
		throw new Error(`Not a snapshot id: ${id}`);
	}
	return fs.readFileSync(path.join(historyDir(root, rel), id), 'utf8');
}

/**
 * A rename moves the note's history along with it (files and folders
 * alike — the layout mirrors the vault). Best-effort: cross-device or
 * missing history must never fail the rename that triggered it.
 */
export function renameHistory(root, oldRel, newRel) {
	const from = historyDir(root, oldRel);
	if (!fs.existsSync(from)) return;
	try {
		fs.mkdirSync(path.dirname(historyDir(root, newRel)), { recursive: true });
		fs.renameSync(from, historyDir(root, newRel));
	} catch (err) {
		console.warn(`[clew] history rename failed (${oldRel} → ${newRel}):`, err?.message ?? err);
	}
}
