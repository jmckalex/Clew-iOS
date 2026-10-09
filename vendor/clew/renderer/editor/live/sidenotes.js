// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Sidenotes in live edit (docs/dev/live-edit.md §5.16): each CONCEALED
// footnote's body sits in the right margin at the height of its badge, when
// the pane is wide enough (the `sidenotes` setting: auto — a pane ≥ 960 px
// with ≥ 220 px of margin — on, off). One layer inside the scroller, the
// frame layer's arrangement; bodies drawn by the inline subset renderer. A
// revealed note shows its source inline and has no sidenote; a note of
// several paragraphs shows its first with "…" (the badge's tooltip has it).
// A body that opens with a fence or a table stays the badge's tooltip.
import { ViewPlugin } from '@codemirror/view';
import { liveStateField } from './reveal-field.js';
import { numberingFor } from './numbering-source.js';
import { inlineTokens, tokensToDom } from './inline-dom.js';
import { mathElement } from './widgets/math.js';
import { settingsStore } from '../../state/settings-store.js';

const GAP = 24;

class Sidenotes {
	constructor(view) {
		this.view = view;
		this.layer = document.createElement('div');
		this.layer.className = 'le-sidenotes';
		view.scrollDOM.append(this.layer);
		this.cache = new Map(); // key → element
		this.offSettings = settingsStore.on('settings-changed', (key) => { if (key === 'sidenotes') this.schedule(); });
		this.schedule();
	}

	// Every read of the live field is TOLERANT (`false`): a measure this
	// plugin requested can run after the live compartment left the state (a
	// mode swap, the pool putting in a fresh state) — CodeMirror keeps
	// pending measure requests past their plugin. It then does nothing.
	update(u) {
		const live = u.state.field(liveStateField, false);
		if (!live) return;
		if (!(u.docChanged || u.viewportChanged || u.geometryChanged || live !== u.startState.field(liveStateField, false))) return;
		// A note with no footnotes costs a keystroke nothing here.
		if (!this.layer.childElementCount && !live.model.some((c) => c.kind === 'footnote')) return;
		this.schedule();
	}

	destroy() {
		this.offSettings?.();
		this.layer.remove();
	}

	schedule() {
		this.view.requestMeasure({ key: this, read: () => this.read(), write: (m) => this.write(m) });
	}

	read() {
		const { view } = this;
		const live = view.state.field(liveStateField, false);
		if (!live) return { on: false };
		const notes = live.model.filter((c) => c.kind === 'footnote' && !live.revealed.has(c.id) && c.body);
		const mode = settingsStore.get('sidenotes') ?? 'auto';
		if (!notes.length || mode === 'off') return { on: false };
		const scroller = view.scrollDOM.getBoundingClientRect();
		const line = view.contentDOM.querySelector('.cm-line')?.getBoundingClientRect();
		if (!line) return { on: false };
		const margin = scroller.right - line.right;
		const on = mode === 'on' || (scroller.width >= 960 && margin >= 220);
		if (!on) return { on: false };
		const layer = this.layer.getBoundingClientRect();
		// Each concealed note's badge on screen (drawn ones only).
		const badges = [...view.contentDOM.querySelectorAll('.le-fn')];
		const placed = [];
		for (const el of badges) {
			let pos;
			try { pos = view.posAtDOM(el); } catch { continue; }
			const note = notes.find((c) => c.from === pos);
			if (!note) continue;
			const r = el.getBoundingClientRect();
			placed.push({ note, top: r.top - layer.top });
		}
		return { on: true, placed, left: line.right - layer.left + GAP, width: Math.max(140, Math.min(300, margin - GAP * 2)) };
	}

	write(m) {
		if (!m.on) { this.layer.replaceChildren(); this.layer.hidden = true; return; }
		this.layer.hidden = false;
		const { doc } = this.view.state;
		const model = this.view.state.field(liveStateField, false)?.model;
		if (!model) { this.layer.replaceChildren(); this.layer.hidden = true; return; }
		const els = [];
		let floor = -Infinity;
		for (const { note, top } of m.placed.sort((a, b) => a.top - b.top)) {
			const body = doc.sliceString(note.body.from, note.body.to);
			const paragraphs = body.trim().split(/\n[ \t]*\n/);
			if (/^\s*(```|~~~|\|)/.test(paragraphs[0])) continue; // a fence or a table: the tooltip
			const firstEnd = note.body.from + body.indexOf(paragraphs[0].trimStart()) + paragraphs[0].trimStart().length;
			const key = `${note.number}\u0000${doc.sliceString(note.body.from, firstEnd)}\u0000${paragraphs.length > 1}`;
			let el = this.cache.get(key);
			if (!el) {
				el = document.createElement('aside');
				el.className = 'le-sidenote';
				const n = document.createElement('span');
				n.className = 'le-sidenote-number';
				n.textContent = String(note.number);
				el.append(n, ' ', tokensToDom(inlineTokens(doc, note.body.from, firstEnd, model, numberingFor(doc, this.view.state.field(liveStateField, false)?.config?.notePath ?? null)), mathElement));
				if (paragraphs.length > 1) el.append(' …');
				this.cache.set(key, el);
			}
			el.dataset.number = String(note.number);
			el.style.left = `${Math.round(m.left)}px`;
			el.style.width = `${Math.round(m.width)}px`;
			els.push({ el, top });
		}
		this.layer.replaceChildren(...els.map((e) => e.el));
		// Collisions, measured after insertion: never above the previous
		// note's bottom + 8.
		for (const { el, top } of els) {
			const at = Math.max(top, floor);
			el.style.top = `${Math.round(at)}px`;
			el.dataset.shift = String(Math.round(at - top));
			floor = at + el.offsetHeight + 8;
		}
		if (this.cache.size > 200) this.cache.clear();
	}
}

export const sidenotes = ViewPlugin.fromClass(Sidenotes);
