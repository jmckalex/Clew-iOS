// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * @file Which parts of a vault Clew leaves alone — the owner's decision,
 * 2026-09-25: "we can't really anticipate all the use-cases a person might
 * encounter, so it would be useful to switch off entirely directory
 * structures whenever it's needed."
 *
 * Two lists, in `<vault>/.clew/vault-settings.json`, because the two needs
 * are different:
 *
 *   "unindexed": ["*\/libs"]        listed in the explorer and openable,
 *                                  but not indexed and not watched
 *   "hidden":    ["**\/node_modules"]  not there at all
 *
 * `unindexed` only became reasonable once the explorer was windowed: a
 * folder of 20,000 files can be listed without costing anything, so the
 * choice is no longer "see it and pay for it" or "lose it".
 *
 * What each costs the user, plainly: an unindexed note has no backlinks,
 * no tags, no quick-switcher entry and no search hits, and — because it is
 * unwatched — a change made to it by another program will not refresh by
 * itself. A hidden one has none of that either, and is not published by a
 * site export or rewritten when a rename moves a link.
 *
 * Every vault walk consults this: the tree and the watcher (vault.js), the
 * indexer, the rename rewriter, the site export and the .bib scan. It is
 * electron-free so the rules can be tested under plain node.
 */
import path from 'node:path';

/**
 * Never listed, never indexed, never watched — whatever the vault says.
 * `.clew` is Clew's own state, `.obsidian` is Obsidian's, `.git` is the
 * repository, `node_modules` is never note material, `.trash` is deleted.
 * Dot-prefixed entries are covered separately (any depth).
 */
export const BUILTIN_HIDDEN = ['.obsidian', '.clew', '.git', 'node_modules', '.trash'];

/**
 * One vault-relative glob → a matcher for "this path, or anything beneath
 * it". The dialect is small on purpose, because it is hand-edited:
 *
 *   Archive/2019      that folder (or file) and everything under it
 *   *\/libs            `libs` one level down — every presentation folder
 *   **\/node_modules   `node_modules` at any depth, the root included
 *   *.log             a file pattern works too; segments never span `/`
 *
 * Returns null for a pattern that is empty or escapes the vault, so a
 * stray line in the settings file cannot silently exclude everything.
 */
export function compilePattern(pattern) {
	const clean = String(pattern ?? '').trim().replace(/^\.\//, '').replace(/\/+$/, '');
	if (!clean || clean.startsWith('/') || clean.split('/').includes('..')) return null;
	let source = '';
	const segments = clean.split('/');
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		if (segment === '**') {
			// `**` swallows any number of segments, INCLUDING none: `**​/x`
			// must match a top-level `x` as well as a nested one.
			source += i === segments.length - 1 ? '(?:.*)?' : '(?:[^/]+/)*';
			continue;
		}
		if (i > 0 && !source.endsWith('/') && !source.endsWith(')*')) source += '/';
		source += segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
	}
	try {
		return new RegExp(`^${source}(?:/.*)?$`);
	} catch { return null; }
}

/** Compile a list, dropping the lines that mean nothing. */
function compileList(patterns) {
	return (Array.isArray(patterns) ? patterns : [])
		.map(compilePattern)
		.filter(Boolean);
}

/**
 * The two questions every vault walk asks, from the vault's own settings.
 *
 * @param {object} [settings] the parsed vault-settings.json
 * @returns {{ isHidden(rel: string): boolean, isUnindexed(rel: string): boolean,
 *            hidden: RegExp[], unindexed: RegExp[] }}
 */
export function compileExcludes(settings = {}) {
	const hidden = compileList(settings?.hidden);
	const unindexed = compileList(settings?.unindexed);
	const builtin = new Set(BUILTIN_HIDDEN);

	/** The rules that apply everywhere, with or without a settings file. */
	const isAlwaysHidden = (rel) => rel.split('/').some((seg) => seg.startsWith('.') || builtin.has(seg));

	const isHidden = (rel) => {
		if (!rel) return false;
		if (isAlwaysHidden(rel)) return true;
		return hidden.some((re) => re.test(rel));
	};

	// Hidden implies unindexed: what is not there cannot be indexed. The
	// walks that ask this question (indexer, watcher, rename, .bib scan)
	// therefore need only the one call.
	const isUnindexed = (rel) => {
		if (!rel) return false;
		if (isHidden(rel)) return true;
		return unindexed.some((re) => re.test(rel));
	};

	return { isHidden, isUnindexed, hidden, unindexed };
}

/** The excludes for a path that arrives absolute (the watcher's case). */
export function relativeTo(root, abs) {
	const rel = path.relative(root, abs);
	return rel === '' || rel.startsWith('..') ? null : rel.split(path.sep).join('/');
}
