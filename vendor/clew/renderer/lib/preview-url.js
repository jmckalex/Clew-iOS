// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Session-scoped clew-preview:// URLs. Every vault URL carries the window's
// session id (multi-window: the protocol handler can't see which window is
// asking, so the URL says which vault it means). main.js sets the id from
// the vault-opened event before any preview renders.
let sessionId = 'none';

export function setPreviewSession(id) {
	sessionId = id ?? 'none';
}

const encode = (path) => path.split('/').map(encodeURIComponent).join('/');

/** Rendered-note URL (reading mode, canvas note embeds). */
export function previewUrl(path) {
	return `clew-preview://vault/${sessionId}/${encode(path)}.html`;
}

/** Raw vault file URL (images, PDFs, media). */
export function vaultFileUrl(path) {
	return `clew-preview://vault/${sessionId}/${encode(path)}`;
}

/** Engine fragment-render endpoint (canvas cards; POST markdown → HTML). */
export function fragmentUrl() {
	return `clew-preview://vault/${sessionId}/__clew_fragment__`;
}

/** Base URL of the preview origin (rewrites root-relative asset paths). */
export function previewOrigin() {
	return 'clew-preview://vault';
}
