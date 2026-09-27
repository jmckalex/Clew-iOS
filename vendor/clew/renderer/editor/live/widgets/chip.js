// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The small inline stand-ins live edit draws in place of a concealed
// construct: a footnote's superscript number, a citation or variable chip,
// a block-id badge, today's date, an inline embed. One widget class, keyed
// by what it shows, so CodeMirror reuses the DOM whenever nothing changed.
//
// `data` attributes carry what a click needs (live/events.js reads them);
// `le-reveal-on-click` makes a click put the cursor on the construct, which
// reveals its source.
import { WidgetType } from '@codemirror/view';

export class ChipWidget extends WidgetType {
	/**
	 * @param {{ cls: string, text: string, title?: string, tag?: string,
	 *   data?: Record<string,string>, reveal?: boolean }} spec
	 */
	constructor(spec) {
		super();
		this.spec = spec;
		this.key = JSON.stringify(spec);
	}

	eq(other) { return other.key === this.key; }

	toDOM() {
		const { cls, text, title, tag = 'span', data = {}, reveal = true } = this.spec;
		const el = document.createElement(tag);
		el.className = `le-chip ${cls}${reveal ? ' le-reveal-on-click' : ''}`;
		el.textContent = text;
		if (title) el.title = title;
		for (const [k, v] of Object.entries(data)) el.dataset[k] = v;
		return el;
	}

	ignoreEvent(event) { return event.type !== 'mousedown'; }
}
