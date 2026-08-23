// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Scroll-sync bus between editor views and preview panes showing the same
// note. Either side emits `{path, line, from}` on a USER scroll; the other
// side follows. Feedback loops are broken by a per-side suppression window:
// a follower ignores its own scroll events briefly after applying a
// programmatic scroll (the "last user gesture wins" rule falls out of that).
import { Emitter } from '../lib/emitter.js';

export const scrollSyncBus = new Emitter();

const SUPPRESS_MS = 400;

/** Per-follower suppression helper. */
export function makeSuppressor() {
	let until = 0;
	return {
		suppress() { until = performance.now() + SUPPRESS_MS; },
		active() { return performance.now() < until; },
	};
}
