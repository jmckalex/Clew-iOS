// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Filesystem helpers shared across the main process.
//
// Symlink-aware directory-walk helpers, shared by every vault walk (explorer
// tree, indexer, canvas-rename rewrite, bib scan). Dirents answer false to
// both isFile() and isDirectory() for symlinks, which is how symlinked notes
// and folders end up invisible in naive walks (the classic Obsidian
// weakness) — so classify through stat, which follows links, and guard
// recursion with realpaths so link cycles can't recurse forever.
//
// Plus writeFileAtomic, the write path for everything a crash must not be
// able to truncate: notes, PDFs, office documents, .clew/ state, settings.
import fs from 'node:fs';
import path from 'node:path';
import { NOTE_EXTENSIONS } from '../shared/channels.js';
import { fileKind, isCanvasPath } from '../shared/file-types.js';

// Never shown in the explorer, never indexed.
export const IGNORED_DIRS = new Set(['.obsidian', '.clew', '.git', 'node_modules', '.trash']);

// The watcher holds one open descriptor per watched FILE, and the ceiling
// that matters is a PROCESS one: past ~10,240 open descriptors libuv stops
// being able to fork at all — measured 2026-09-25 on macOS 15, 10,000 held
// descriptors → fork OK, 10,240 → `spawn EBADF`. The render worker IS a
// fork (render-service.js#spawnStandby), so a vault that watches everything
// does not merely get slow: it stops being able to RENDER, and the error
// surfaces as an unreadable `spawn EBADF` in the preview.
//
// The owner's ph341 vault is how this was found: five presentation folders
// symlink one 309 MB reveal.js library, and the watcher held 100,169
// descriptors (99,580 of them under that library, the same real tree
// watched five times over).
//
// So: a budget, shared by every window because the descriptors are, and
// well under the ceiling — the rest of the app needs descriptors too.
//
// CLEW_WATCH_BUDGET=<n> is for scenarios only: a vault whose budget is SPENT
// — the watcher blind to anything new — without generating 10,000 files. It
// sets both numbers, so nothing is watched past the scan either.
const FORCED_BUDGET = Number(process.env.CLEW_WATCH_BUDGET) || 0;
export const WATCH_BUDGET = FORCED_BUDGET || 8000;
// What the watcher may grow to AFTER the initial scan, for the files a
// session actually creates. The budget bounds the walk; this bounds the
// drift, and both stay clear of the ~10,240 descriptors where fork() dies.
export const WATCH_CEILING = FORCED_BUDGET || 9000;

// How much of the budget a window's SCAN may take. The budget is shared by
// every window, and first-come used to mean all-taken: a second window
// opened after a capped one got nothing for its scan — nothing of its vault
// watched — and its first event then spent the ceiling's whole headroom
// (measured 2026-09-30, smoke/watch-repro.mjs). So a scan takes all but
// SCAN_KEEP of what is left, and never more than half once that is less:
// the first window of a fresh process can still hold 6,000 (a 5,000-note
// vault fits), and every later window gets a share, halving as they come,
// never nothing.
export const SCAN_KEEP = 2000;
export function scanShare(remaining) {
	const left = Math.max(0, Math.floor(remaining));
	// A forced budget (CLEW_WATCH_BUDGET) is a scenario's BLIND watcher: the
	// scan takes it all, so nothing is left for a new file.
	if (FORCED_BUDGET) return left;
	return Math.max(Math.floor(left / 2), left - SCAN_KEEP);
}

/**
 * Every path the vault walk saw: its files and every directory above them.
 * After the scan, the watcher answers these WITHOUT charging the budget —
 * a path the scan knew and did not buy stays unwatched, rather than being
 * bought the first time chokidar re-reads its folder (it asks about every
 * entry on every event) and reported as a spurious `add`. Only paths that
 * are genuinely NEW draw on the headroom above the budget.
 * @param {string[]} files vault-relative, '/'-separated
 */
export function knownPaths(files) {
	const known = new Set();
	for (const rel of files) {
		known.add(rel);
		for (let i = rel.lastIndexOf('/'); i > 0; i = rel.lastIndexOf('/', i - 1)) {
			const dir = rel.slice(0, i);
			if (known.has(dir)) break;
			known.add(dir);
		}
	}
	return known;
}

/**
 * WHAT to spend the budget on, in what order — the owner's policy,
 * 2026-09-25: "watch all the markdown documents first, then a heuristic for
 * the other document types that need to be watched, then everything else on
 * a breadth-first-search policy."
 *
 * It exists because the budget alone was not enough. chokidar walks a vault
 * in directory order and takes what it meets, so a big non-note folder that
 * sorts early spends the whole budget before the notes are reached: in the
 * owner's ph226-426, watching stopped inside a font icon set after SIX of
 * the vault's eighty-one notes. The limit had done its job and the app
 * worked; the automatic refresh that vault actually wanted was the part it
 * lost. Deciding the order ourselves is what fixes that, and it is only
 * possible because Clew already walks the vault for the tree before the
 * watcher starts.
 *
 * Three tiers:
 *
 *   0 — NOTES. `.md`/`.jmd`, which is what the app is for: indexed,
 *       rendered, backlinked, searched. Excalidraw drawings are
 *       `.excalidraw.md` and so land here by construction, which is right.
 *   1 — DOCUMENTS Clew opens and EDITS as documents: canvas, PDF, office,
 *       `.base`, `.bib`. Few in any real vault, and a change to one of them
 *       is always something a tab or a render wants to hear about.
 *   2 — EVERYTHING ELSE, breadth-first.
 *
 * Attachments — images, media, data files — are deliberately NOT a tier of
 * their own, and that is the heuristic worth explaining. Giving every image
 * a high tier would hand the budget straight back to the font icon set that
 * caused the problem (20,000 `.svg` files, all of them images by
 * extension). Depth answers it instead: a vault's own attachments sit
 * beside or just below its notes, while a vendored library is five or six
 * folders down, so breadth-first ordering reaches `Attachments/photo.png`
 * long before `x/libs/fontawesome6/svgs/regular/*.svg` without either of
 * them being named. Within one depth, a file Clew has a use for goes first.
 */
export const WATCH_TIER = { NOTE: 0, DOCUMENT: 1, OTHER: 2 };

/** Documents that open in a tab of their own, beyond the viewer kinds. */
const DOCUMENT_EXTENSIONS = ['.base', '.bib'];

/** Which tier a vault-relative path belongs to. */
export function watchTier(rel) {
	const lower = rel.toLowerCase();
	if (NOTE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return WATCH_TIER.NOTE;
	if (isCanvasPath(lower) || DOCUMENT_EXTENSIONS.some((ext) => lower.endsWith(ext))) return WATCH_TIER.DOCUMENT;
	// The viewer kinds split: a PDF and an office document are EDITED in
	// Clew and must hear about an external change; an image or a video is
	// only ever displayed, so it rides depth with everything else.
	const kind = fileKind(lower);
	if (kind === 'pdf' || kind === 'office' || kind === 'excalidraw') return WATCH_TIER.DOCUMENT;
	return WATCH_TIER.OTHER;
}

/** Sort key: tier, then depth (breadth-first), then usefulness, then name. */
function watchRank(rel) {
	// A file Clew knows what to do with beats one it does not, at equal
	// depth — `Attachments/photo.png` before `Attachments/notes.bak`.
	const known = fileKind(rel.toLowerCase()) === null ? 1 : 0;
	return [watchTier(rel), rel.split('/').length, known, rel];
}

/**
 * The order the watcher should claim paths in. Pure, and the whole policy
 * lives here: tests/watch-order.test.js is where it is pinned.
 */
export function watchOrder(files) {
	return [...files].sort((a, b) => {
		const ra = watchRank(a);
		const rb = watchRank(b);
		for (let i = 0; i < ra.length; i++) {
			if (ra[i] < rb[i]) return -1;
			if (ra[i] > rb[i]) return 1;
		}
		return 0;
	});
}

/**
 * Turn that order into the set of paths the watcher will actually hold,
 * spending the budget from the front of the list.
 *
 * A file is unreachable without its ancestors — chokidar cannot descend
 * into a directory it has been told to ignore — so each file is charged
 * together with any parent not yet paid for. When the budget runs out it is
 * out for the rest of the scan: what follows is counted, so the window can
 * say how much went unwatched and name the first of it.
 *
 * @param {string[]} files vault-relative paths, already filtered by the
 *   vault's own exclusion rules
 * @param {() => boolean} take claim one unit of the (process-wide) budget
 */
export function watchPlan(files, take = () => true) {
	const admit = new Set();
	let skipped = 0;
	let firstSkipped = null;
	let spent = false;
	for (const rel of watchOrder(files)) {
		if (!spent) {
			const needed = [];
			const segments = rel.split('/');
			for (let i = 1; i < segments.length; i++) {
				const dir = segments.slice(0, i).join('/');
				if (!admit.has(dir)) needed.push(dir);
			}
			needed.push(rel);
			let paid = true;
			for (const one of needed) {
				if (!take()) { paid = false; break; }
				admit.add(one);
			}
			if (paid) continue;
			spent = true;
		}
		skipped += 1;
		firstSkipped ??= rel;
	}
	return { admit, skipped, firstSkipped };
}

/**
 * The watcher's gate: chokidar's `ignored` predicate plus the bookkeeping
 * behind it. Pure enough to unit-test (tests/watch-filter.test.js) — the
 * only I/O is the caller's.
 *
 * chokidar passes ABSOLUTE paths even when `cwd` is set, and asks about the
 * same path more than once (with and without a stats object), so the rules
 * are applied to the vault-RELATIVE path and acceptance is remembered.
 * Testing segments of the absolute path, as this once did, ignores every
 * file in a vault that merely lives under a dot-directory (`~/.notes/…`).
 *
 * @param {object} options
 * @param {string} options.root the vault root
 * @param {(rel: string) => boolean} [options.isExcluded] the vault's own rule
 *   (vault-excludes.js — both lists, since what is not indexed is not
 *   watched); defaults to the built-ins alone
 * @param {Set<string>} [options.duplicates] relative dirs already reached by another path
 * @param {() => boolean} [options.take] claim one unit of budget; false when spent
 * @param {Set<string>} [options.admit] the paths the scan may hold, decided
 *   in advance by watchPlan so the budget goes to notes first rather than to
 *   whatever chokidar happens to meet first. `null` means the old
 *   first-come behaviour, which is what a caller with no walk of its own
 *   (and every unit test of the rules themselves) wants.
 * @param {() => boolean} [options.settled] has the initial scan finished?
 *   After it has, the plan is spent and new paths are judged on the budget
 *   alone — a file the user creates must be watched, plan or no plan.
 * @param {Set<string>} [options.known] every path the scan saw (knownPaths):
 *   after it, those it did not admit are refused free of charge, so only
 *   NEW paths spend the headroom.
 */
export function watchFilter({
	root, isExcluded = null, duplicates = new Set(), take = () => true,
	admit = null, settled = () => false, known = null,
}) {
	const excluded = isExcluded ?? ((rel) => rel.split('/').some((seg) => seg.startsWith('.') || IGNORED_DIRS.has(seg)));
	// Everything the plan bought is already charged and already ours.
	const accepted = new Set(admit ?? []);
	const state = { accepted, skipped: 0, firstSkipped: null };
	const ignored = (abs) => {
		const rel = path.relative(root, abs);
		// The root itself, and the parent chokidar watches to notice the root
		// being renamed, are its own bookkeeping — leave them alone.
		if (rel === '' || rel.startsWith('..')) return false;
		const segments = rel.split(path.sep);
		if (excluded(segments.join('/'))) return true;
		// A second way into a tree already watched through another link, or
		// anything beneath one. chokidar has no cycle guard of its own; the
		// vault walk's realpath dedupe (shouldRecurse, below) is where these
		// come from. Checking the ancestors costs a handful of Set lookups
		// and does not depend on chokidar refusing to descend for us.
		if (duplicates.size > 0) {
			for (let i = 1; i <= segments.length; i++) {
				if (duplicates.has(segments.slice(0, i).join('/'))) return true;
			}
		}
		if (accepted.has(rel)) return false;
		// During the scan the plan is the answer: anything it did not buy is
		// refused, and watchPlan has already counted it as skipped. Asking
		// the budget here as well would let chokidar's own walk order spend
		// what the plan reserved for notes deeper down.
		if (admit && !settled()) return true;
		// After the scan: what the scan already knew and did not buy is not
		// bought now (knownPaths). No charge, and no `add` for an old file.
		if (known?.has(rel)) return true;
		if (!take()) {
			state.skipped += 1;
			state.firstSkipped ??= rel;
			return true;
		}
		accepted.add(rel);
		return false;
	};
	return { ignored, state };
}

/**
 * What a dirent really is, following symlinks: 'file' | 'dir' | null
 * (null covers sockets, dangling links, and anything unreadable).
 */
export function direntKind(dir, entry) {
	if (entry.isFile()) return 'file';
	if (entry.isDirectory()) return 'dir';
	if (entry.isSymbolicLink()) {
		try {
			const stat = fs.statSync(path.join(dir, entry.name));
			return stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : null;
		} catch {
			return null; // dangling link
		}
	}
	return null;
}

/**
 * Cycle guard for recursive walks: true exactly once per real directory.
 * Seed `seen` via `walkGuard(root)` so links pointing back into the walk's
 * own root are skipped too.
 */
export function shouldRecurse(absDir, seen) {
	try {
		const real = fs.realpathSync(absDir);
		if (seen.has(real)) return false;
		seen.add(real);
		return true;
	} catch {
		return false;
	}
}

/** A fresh `seen` set for one walk, pre-seeded with the root's realpath. */
export function walkGuard(root) {
	const seen = new Set();
	try {
		seen.add(fs.realpathSync(root));
	} catch { /* root itself unreadable; walk will no-op */ }
	return seen;
}

/**
 * Write a file so that a crash at any moment leaves either the old content
 * or the new — never a truncated half. The bytes land in a temp file beside
 * the target (same directory, so the rename can't cross filesystems), are
 * fsynced, and only then renamed into place.
 *
 * The temp name is dot-prefixed, which keeps it out of every vault walk and
 * the chokidar watcher for free (both skip dotfiles), and FIXED per target,
 * so a temp orphaned by a crash is swept up by the next successful save of
 * the same file. Measured on macOS/fsevents: the rename still reaches the
 * watcher as a plain 'change' on the target, so editors and previews see
 * exactly what a bare writeFileSync produced.
 *
 * Symlinks are written THROUGH (vaults support symlinked notes; renaming
 * onto the link itself would replace it with a regular file and orphan the
 * real note), and the target's permissions survive the inode swap.
 */
export function writeFileAtomic(file, data) {
	let target = file;
	try {
		target = fs.realpathSync(file);
	} catch { /* new file — nothing to follow */ }
	const temp = path.join(path.dirname(target), `.${path.basename(target)}.clew-tmp`);
	let mode;
	try {
		mode = fs.statSync(target).mode;
	} catch { /* new file — default mode */ }
	const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
	const fd = fs.openSync(temp, 'w');
	try {
		if (mode !== undefined) fs.fchmodSync(fd, mode);
		for (let off = 0; off < buf.length;) {
			off += fs.writeSync(fd, buf, off);
		}
		fs.fsyncSync(fd);
		fs.closeSync(fd);
	} catch (err) {
		try { fs.closeSync(fd); } catch { /* already closed */ }
		fs.rmSync(temp, { force: true });
		throw err;
	}
	fs.renameSync(temp, target);
}
