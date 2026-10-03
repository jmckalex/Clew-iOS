// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Where a vault ends, for a vault this device has NOT trusted
// (docs/dev/frame-bridge.md §4, the symlink check of 2026-10-03). Clew
// follows a vault's symlinks — the owner's own vaults link bibliographies,
// slide libraries and PDFs from elsewhere on the machine, and in a TRUSTED
// vault that stands. But a vault someone sends can carry a link to the home
// directory (Clew-iOS found its preview scheme serving the app's own
// preferences through one), and nothing legitimate in a sent vault needs an
// outside link: its links point at the SENDER's paths. So in a restricted
// vault a path counts as the vault's only when its REALPATH lies inside the
// vault root's realpath — not a lexical check, which a link passes — and a
// path that cannot be resolved (missing, dangling) counts as outside.
//
// One rule for every reader: main (vault.js, indexer.js, protocol.js) and
// the render worker's extensions (wikilinks.js, vault-model.js,
// query-fences.js, obsidian-fences.js, …), which learn the vault's state
// from CLEW_VAULT_RESTRICTED at spawn. No imports beyond node, so both sides
// can load it.
import fs from 'node:fs';
import path from 'node:path';

const realRoots = new Map();

function realRoot(root) {
	if (!realRoots.has(root)) {
		let real;
		try { real = fs.realpathSync(root); } catch { real = path.resolve(root); }
		realRoots.set(root, real);
	}
	return realRoots.get(root);
}

/** Is `abs` inside `root` by realpath? (Missing or dangling: no.) */
export function insideByRealpath(abs, root) {
	let real;
	try { real = fs.realpathSync(abs); } catch { return false; }
	const top = realRoot(root);
	return real === top || real.startsWith(top + path.sep);
}

/** The render worker's view: may it read `abs`? Always, in a trusted vault. */
export function withinVault(abs, root = process.env.CLEW_VAULT_ROOT) {
	if (process.env.CLEW_VAULT_RESTRICTED !== '1' || !root) return true;
	return insideByRealpath(abs, root);
}
