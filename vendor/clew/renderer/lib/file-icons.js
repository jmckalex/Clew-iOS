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
 * @file Which icon the file explorer draws before a name (the owner's ask,
 * 2026-11-12: "icons before the name of the folder or file so as to help make
 * it more clear what the type is"). The icons are Material Icon Theme's, the
 * set the owner's jmacs uses, vendored by scripts/vendor-file-icons.js; the
 * table is its generated file-icons-data.js. Pure — tests/file-icons.test.js.
 */
import { FILE_ICONS } from './file-icons-data.js';

const LIGHT = new Set(FILE_ICONS.light);

/**
 * The icon for a file called `name` (a name, not a path): the whole name if
 * the table knows it (`readme.md`, `makefile`), else the longest extension it
 * knows — `x.excalidraw.md` is a drawing before it is markdown — else the
 * plain file. Case is ignored, as the theme ignores it.
 *
 * @param {string} name
 * @returns {string} an icon name
 */
export function fileIconName(name) {
	const lower = String(name ?? '').toLowerCase();
	if (Object.hasOwn(FILE_ICONS.fileNames, lower)) return FILE_ICONS.fileNames[lower];
	const parts = lower.split('.');
	for (let i = 1; i < parts.length; i++) {
		const ext = parts.slice(i).join('.');
		if (Object.hasOwn(FILE_ICONS.extensions, ext)) return FILE_ICONS.extensions[ext];
	}
	return FILE_ICONS.file;
}

/** A folder's icon: open while its contents are shown. */
export function folderIconName(open) {
	return open ? FILE_ICONS.folderOpen : FILE_ICONS.folder;
}

/**
 * Where an icon's SVG is, relative to the app page (scripts/build.js copies
 * vendor/material-icons/ to dist/renderer/file-icons/). On a light page an
 * icon drawn for a dark one takes its `_light` variant where the set has one.
 *
 * @param {string} icon
 * @param {string} [theme] 'light' or 'dark'
 */
export function fileIconUrl(icon, theme) {
	return `file-icons/${icon}${theme === 'light' && LIGHT.has(icon) ? '_light' : ''}.svg`;
}
