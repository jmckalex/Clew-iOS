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
