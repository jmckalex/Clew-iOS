// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The stand-ins for LINE constructs (plan §5.4, §5.5): a list bullet, a task
// checkbox, a callout's head, a code fence's opener and closer, a directive's
// opener and closer. Each replaces text WITHIN one line, so the inline layer
// (a ViewPlugin) can draw them; none changes a line's height, which is the
// §5.10 rule — the line classes that give a line its size or indent are
// applied in both states, only the marks toggle.
//
// Interactions travel on data attributes (live/events.js): `data-le-task`
// toggles a checkbox, `data-le-fold` folds a callout, `data-le-copy` copies
// a fence body.
import { WidgetType } from '@codemirror/view';
import { calloutIcon, calloutGeneration, untitledCalloutTitle } from '#jmarkdown/callout-table.js';

const BULLETS = ['•', '◦', '▪'];

class KeyedWidget extends WidgetType {
	constructor(key) {
		super();
		this.key = key;
	}

	eq(other) { return other.constructor === this.constructor && other.key === this.key; }

	ignoreEvent(event) { return event.type !== 'mousedown'; }
}

export class BulletWidget extends KeyedWidget {
	constructor(depth) { super(String(depth)); this.depth = depth; }

	toDOM() {
		const el = document.createElement('span');
		el.className = 'le-bullet';
		el.textContent = BULLETS[(this.depth - 1) % BULLETS.length];
		return el;
	}
}

export class TaskWidget extends KeyedWidget {
	constructor(checked) { super(String(checked)); this.checked = checked; }

	toDOM() {
		const box = document.createElement('input');
		box.type = 'checkbox';
		box.className = 'le-task';
		box.checked = this.checked;
		box.dataset.leTask = '1';
		box.setAttribute('aria-label', this.checked ? 'Done' : 'To do');
		return box;
	}
}

export class CalloutHeadWidget extends KeyedWidget {
	/**
	 * @param {string} type - canonical callout type
	 * @param {string} fold - '', '+' or '-'
	 * @param {boolean} folded - current fold state
	 * @param {boolean} titled - the author wrote a title (else the label shows)
	 * @param {string} id - the callout construct's id (for folding)
	 * @param {string} written - the type as the author wrote it (`CAUTION`),
	 *   whose untitled heading is the engine's untitledCalloutTitle
	 */
	constructor(type, fold, folded, titled, id, written = type) {
		// The table's generation too: a type's icon or title edited in
		// Settings must redraw a head whose source did not change.
		super(`${type}|${written}|${fold}|${folded}|${titled}|${id}|${calloutGeneration()}`);
		Object.assign(this, { type, fold, folded, titled, id, written });
	}

	toDOM() {
		const el = document.createElement('span');
		el.className = 'le-callout-marker';
		el.innerHTML = calloutIcon(this.type);
		if (!this.titled) {
			const label = document.createElement('span');
			label.className = 'le-callout-label';
			// The ENGINE's rule, imported, never mirrored: the canonical name
			// is headed by its type's title, anything else by the name as
			// written, capitalised (`[!CAUTION]` → Caution, `[!my-type]` → My-type).
			label.textContent = untitledCalloutTitle(this.written);
			el.append(label);
		}
		if (this.fold) {
			const chevron = document.createElement('span');
			chevron.className = `le-callout-fold${this.folded ? ' is-folded' : ''}`;
			chevron.dataset.leFold = this.id;
			chevron.title = this.folded ? 'Expand' : 'Collapse';
			el.append(chevron);
		}
		return el;
	}
}

export class FenceHeadWidget extends KeyedWidget {
	constructor(lang) { super(lang); this.lang = lang; }

	toDOM() {
		const el = document.createElement('span');
		el.className = 'le-fence-head';
		const badge = document.createElement('span');
		badge.className = 'le-fence-lang le-reveal-on-click';
		badge.textContent = this.lang || 'code';
		const copy = document.createElement('span');
		copy.className = 'le-fence-copy';
		copy.dataset.leCopy = '1';
		copy.title = 'Copy code';
		copy.textContent = 'Copy';
		el.append(badge, copy);
		return el;
	}
}

export class FenceFootWidget extends KeyedWidget {
	constructor() { super(''); }

	toDOM() {
		const el = document.createElement('span');
		el.className = 'le-fence-foot le-reveal-on-click';
		return el;
	}
}

export class EnvHeadWidget extends KeyedWidget {
	/**
	 * @param {string} name - directive / environment name
	 * @param {string} caption - its `[content]`, or ''
	 * @param {string} attrs - its `{attrs}` summary, or ''
	 * @param {string} note - an extra word ("LaTeX only")
	 * @param {string} [numbered] - what the engine prints for it, "Theorem 2"
	 *   (live/numbering.js), shown in place of the bare name
	 */
	constructor(name, caption, attrs, note, numbered = '') {
		super(`${name}|${caption}|${attrs}|${note}|${numbered}`);
		Object.assign(this, { name, caption, attrs, note, numbered });
	}

	toDOM() {
		const el = document.createElement('span');
		el.className = 'le-env-head le-reveal-on-click';
		const name = document.createElement('span');
		name.className = `le-env-name${this.numbered ? ' le-env-numbered' : ''}`;
		name.textContent = this.numbered || this.name;
		el.append(name);
		if (this.caption) {
			const caption = document.createElement('span');
			caption.className = 'le-env-caption';
			caption.textContent = this.caption;
			el.append(caption);
		}
		if (this.note) {
			const note = document.createElement('span');
			note.className = 'le-env-note';
			note.textContent = this.note;
			el.append(note);
		}
		if (this.attrs) el.title = `{${this.attrs}}`;
		return el;
	}
}

export class EnvFootWidget extends KeyedWidget {
	constructor() { super(''); }

	toDOM() {
		const el = document.createElement('span');
		el.className = 'le-env-foot le-reveal-on-click';
		return el;
	}
}
