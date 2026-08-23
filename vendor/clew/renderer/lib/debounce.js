// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

export function debounce(fn, wait) {
	let timer = null;
	let lastArgs = [];
	const debounced = (...args) => {
		lastArgs = args;
		clearTimeout(timer);
		timer = setTimeout(() => { timer = null; fn(...lastArgs); }, wait);
	};
	/** Run a pending call immediately (no-op when nothing is pending). */
	debounced.flush = () => {
		if (timer !== null) { clearTimeout(timer); timer = null; fn(...lastArgs); }
	};
	debounced.cancel = () => { clearTimeout(timer); timer = null; };
	debounced.pending = () => timer !== null;
	return debounced;
}
