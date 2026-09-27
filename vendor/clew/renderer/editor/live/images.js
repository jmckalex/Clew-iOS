// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Where an image construct points: the spec ImageWidget draws. A markdown
// image's path resolves against the note's own folder first, then the vault
// root, then (Obsidian's habit) by file name anywhere in the vault; a
// wikilink embed resolves by name as the engine does.
import { vaultStore } from '../../state/vault-store.js';
import { vaultFileUrl } from '../../lib/preview-url.js';
import { parseMediaAlias } from '../../../engine/media-alias.js';

function normalize(path) {
	const out = [];
	for (const part of path.split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') out.pop();
		else out.push(part);
	}
	return out.join('/');
}

/**
 * @param {object} c - an `image` construct (live/model.js)
 * @param {string|null} notePath - the note it is in (vault-relative)
 * @param {boolean} block - alone on its line
 */
export function imageSpec(c, notePath, block) {
	if (c.markdown) {
		const raw = c.src.replace(/^<|>$/g, '').trim();
		if (/^https?:/i.test(raw)) return { src: raw, alt: c.alt, width: null, height: null, remote: true, missing: null, block };
		if (/^(data|clew-preview):/i.test(raw)) return { src: raw, alt: c.alt, width: null, height: null, remote: false, missing: null, block };
		let decoded = raw;
		try { decoded = decodeURI(raw); } catch { /* keep raw */ }
		const dir = notePath?.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '';
		const candidates = [normalize(`${dir}/${decoded}`), normalize(decoded)];
		const path = candidates.find((p) => vaultStore.pathExists(p))
			?? vaultStore.resolveFileName(decoded.split('/').pop());
		return { src: path ? vaultFileUrl(path) : null, alt: c.alt, width: null, height: null, remote: false, missing: path ? null : decoded, block };
	}
	const { alt, width, height } = parseMediaAlias(c.aliasText);
	const path = vaultStore.resolveFileName(c.target);
	return { src: path ? vaultFileUrl(path) : null, alt: alt ?? c.target, width, height, remote: false, missing: path ? null : c.target, block };
}
