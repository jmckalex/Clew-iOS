// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Runtime for EXPORTED vault websites (File → Export Vault as Website):
// everything a static page needs that isn't plain HTML — interactive maps
// and mermaid diagrams. No app bridge, no morphs, no note API: exported
// pages are documents. window.__clewAssetBase (set by the exporter, per
// page depth) points leaflet at the copied assets.
import { initLeafletMaps } from './leaflet-maps.js';
import { installAnchorClicks } from './anchors.js';

initLeafletMaps();
// Hand-written `#anchor` TOCs vs the engine's toc-<slug> heading ids — the
// same resolution reading mode does (anchors.js), for static pages.
installAnchorClicks();

if (window.mermaid) {
	window.mermaid.initialize({ startOnLoad: false, theme: 'dark' });
	window.mermaid.run({ querySelector: '.mermaid' }).catch?.(() => {});
}
