// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The files a font family a figure NAMES is given, from this machine's font
// index (main/system-fonts.js builds it) — ONE rule for the preview
// (protocol.js serves the files, preview-client/figures.js hands them over)
// and for an export (export-worker.mjs: processFile's `figureFonts`, jmarkdown
// 97caa3e): the family's files, whole — a face per file included (Times New
// Roman, Georgia: their bold and italic are files of their own) — and none
// for a family this machine lacks or one past FAMILY_LIMIT. The engine takes
// that answer as final, as the preview has to: it searches no folder then.
// Here, in src/engine, because the export worker loads it from beside itself;
// system-fonts.js re-exports it for main.
import fs from 'node:fs';

/** A family's files past this many bytes, together, are not handed over. */
export const FAMILY_LIMIT = 64 * 1024 * 1024;

/**
 * The files to hand over for a family name, as the index has them — none
 * when the family is unknown, or larger together than FAMILY_LIMIT.
 * @param {Map<string, string[]>} index - family (lowercased) → files
 */
export function familyFiles(index, family) {
	const files = (index.get(String(family).toLowerCase()) ?? []).filter((f) => fs.existsSync(f));
	const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
	return bytes > FAMILY_LIMIT ? [] : files;
}

/**
 * The index as system-fonts.js#buildIndex keeps it in its cache file
 * (`{ stamp, families }`), or null when that cannot be read.
 */
export function readFontIndex(file) {
	try {
		const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
		return kept?.families && typeof kept.families === 'object' ? new Map(Object.entries(kept.families)) : null;
	} catch {
		return null;
	}
}
