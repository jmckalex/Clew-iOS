// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// In-document anchors, resolved the way the wild writes them.
//
// The engine ids every heading `toc-<slug>` (marked-gfm-heading-id with a
// prefix, so heading ids can never collide with ids notes author
// themselves). But hand-written tables of contents — GitHub's style, which
// real vaults are full of — say `#deep-work`, `#Deep%20Work`, even
// `#Deep Work`. Left to the browser those silently miss, so clicking an
// entry does nothing. This resolves a hash against, in order: an exact id,
// the engine's toc-prefixed slug, and finally any heading whose own text
// slugs to the same thing.
export function anchorTarget(rawHash) {
	let hash = String(rawHash).replace(/^#/, '');
	try { hash = decodeURIComponent(hash); } catch { /* literal percent — keep as written */ }
	const direct = document.getElementById(hash) ?? document.getElementById(`toc-${hash}`);
	if (direct) return direct;
	const want = slug(hash);
	if (!want) return null;
	const bySlug = document.getElementById(`toc-${want}`);
	if (bySlug) return bySlug;
	for (const heading of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
		if (slug(heading.textContent) === want) return heading;
	}
	return null;
}

/** GitHub's heading slug, near enough: lowercase, punctuation out, spaces → -. */
const slug = (s) => String(s).trim().toLowerCase()
	.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');

/** Install a capture-phase resolver for `#…` links (exported sites). */
export function installAnchorClicks() {
	document.addEventListener('click', (event) => {
		const link = event.target.closest?.('a[href^="#"]');
		if (!link) return;
		const target = anchorTarget(link.getAttribute('href'));
		if (!target) return;
		event.preventDefault();
		target.scrollIntoView({ block: 'start' });
	}, true);
}
