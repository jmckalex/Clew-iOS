// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// File-type classification shared by the explorer, viewer tabs, attachment
// handling, and wikilink resolution.
export const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.bmp'];
export const AUDIO_EXT = ['.mp3', '.m4a', '.wav', '.ogg', '.flac'];
export const VIDEO_EXT = ['.mp4', '.webm', '.mov'];

import { isExcalidrawPath } from '../../shared/excalidraw-file.js';
export { isExcalidrawPath };

const extOf = (path) => {
	const i = path.lastIndexOf('.');
	return i === -1 ? '' : path.slice(i).toLowerCase();
};

export function fileKind(path) {
	// Checked before the extension map: a drawing is named `.excalidraw.md`,
	// whose extension is `.md`, and Obsidian's plugin owns it. Getting this
	// order wrong opens someone's drawing as a wall of base64.
	if (isExcalidrawPath(path)) return 'excalidraw';
	const ext = extOf(path);
	if (IMAGE_EXT.includes(ext)) return 'image';
	if (ext === '.pdf') return 'pdf';
	if (AUDIO_EXT.includes(ext)) return 'audio';
	if (VIDEO_EXT.includes(ext)) return 'video';
	return null;
}

/** Files Clew can open in a viewer tab. */
export function isViewablePath(path) {
	return fileKind(path) !== null;
}

/** JSON Canvas files (Obsidian-compatible), opened in a canvas tab. */
export function isCanvasPath(path) {
	return extOf(path) === '.canvas';
}

/** Files that embed with `![[...]]` (vs a plain `[[...]]` link). */
export function isEmbeddablePath(path) {
	return fileKind(path) !== null;
}
