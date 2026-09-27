// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// An image drawn in place (plan §5.5b, Tier B), from the vault over
// clew-preview:// — a `data:` URL as it is. A REMOTE image is not loaded:
// the app's CSP has no http(s) in img-src (a decision in force, docs/dev/live-edit.md §12 — a note would
// otherwise contact remote hosts just by being opened for editing), so it
// shows as a chip that says where it can be seen. A reference that resolves
// to nothing says that by name. The size comes from the wikilink alias
// (`|300`, `|300x200`), read by the engine's own parser (media-alias.js).
import { WidgetType } from '@codemirror/view';

export class ImageWidget extends WidgetType {
	/**
	 * @param {{ src: string|null, alt: string, width: number|null,
	 *   height: number|null, remote: boolean, missing: string|null,
	 *   block: boolean }} spec
	 */
	constructor(spec) {
		super();
		this.spec = spec;
		this.key = JSON.stringify(spec);
	}

	eq(other) { return other instanceof ImageWidget && other.key === this.key; }

	toDOM(view) {
		const { src, alt, width, height, remote, missing, block } = this.spec;
		const wrap = document.createElement(block ? 'div' : 'span');
		wrap.className = `le-image${block ? ' le-image-block' : ''}`;
		if (remote || missing || !src) {
			const chip = document.createElement('span');
			chip.className = 'le-chip le-image-chip le-reveal-on-click';
			chip.textContent = remote ? `Remote image — shown in reading mode` : `Image not found: ${missing}`;
			chip.title = remote ? src : missing;
			wrap.append(chip);
			return wrap;
		}
		const img = document.createElement('img');
		img.className = 'le-reveal-on-click';
		img.src = src;
		img.alt = alt ?? '';
		if (alt) img.title = alt;
		if (width) img.width = width;
		if (height) img.height = height;
		img.addEventListener('load', () => view.requestMeasure());
		img.addEventListener('error', () => {
			img.replaceWith(Object.assign(document.createElement('span'), {
				className: 'le-chip le-image-chip le-reveal-on-click',
				textContent: `Image could not be loaded: ${alt || src}`,
			}));
			view.requestMeasure();
		});
		wrap.append(img);
		return wrap;
	}

	get estimatedHeight() { return this.spec.block ? (this.spec.height ?? 200) + 8 : -1; }

	ignoreEvent(event) { return event.type !== 'mousedown'; }
}
