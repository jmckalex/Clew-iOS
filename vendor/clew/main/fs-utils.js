// Symlink-aware directory-walk helpers, shared by every vault walk (explorer
// tree, indexer, canvas-rename rewrite, bib scan). Dirents answer false to
// both isFile() and isDirectory() for symlinks, which is how symlinked notes
// and folders end up invisible in naive walks (the classic Obsidian
// weakness) — so classify through stat, which follows links, and guard
// recursion with realpaths so link cycles can't recurse forever.
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
