// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// A `\fullcite{…}` concealed in live edit: the full reference INLINE, as
// reading mode draws it — the engine's entry, italic titles and all — not a
// chip (the owner, 2026-10-01: "the text should be the full citation
// entry"). It wraps like the prose around it; a click puts the cursor in it,
// which reveals the source like any construct.
import { WidgetType } from '@codemirror/view';

export class FullciteWidget extends WidgetType {
	/**
	 * @param {{ html: string|null, text: string, missing?: boolean, title?: string }} spec -
	 *   `html` only ever from cite-text.js#inlineHtml (attribute-free inline
	 *   tags, rebuilt); else `text`, the local entry or the key
	 */
	constructor(spec) {
		super();
		this.spec = spec;
		this.key = JSON.stringify(spec);
	}

	eq(other) { return other.key === this.key; }

	toDOM() {
		const el = document.createElement('span');
		el.className = `le-fullcite le-reveal-on-click${this.spec.missing ? ' le-cite-missing' : ''}`;
		if (this.spec.html) el.innerHTML = this.spec.html;
		else el.textContent = this.spec.text;
		if (this.spec.title) el.title = this.spec.title;
		return el;
	}

	ignoreEvent(event) { return event.type !== 'mousedown'; }
}
