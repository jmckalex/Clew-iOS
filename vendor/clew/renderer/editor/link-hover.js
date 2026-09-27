// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Hovering a link in the editor previews it (docs/dev/live-edit.md §5.11):
// source mode and live edit alike. The pointer must be over something drawn
// AS a link — live edit's concealed link marks and chips, source mode's
// wikilink and link highlighting — and then the line's text says which link
// (link-at.js, the same reader ⌘-click uses). The popover
// (<clew-link-preview>) owns the timing; this only reports which link is
// under the pointer, and closes the popover on a keystroke or a scroll.
//
// No `update` method: it adds nothing to a keystroke.
import { ViewPlugin } from '@codemirror/view';
import { linkAt, previewSpec } from './link-at.js';
import { literalAt } from './literal-at.js';
import { linkPreview } from './link-preview.js';
import { vaultStore } from '../state/vault-store.js';
import { settingsStore } from '../state/settings-store.js';
import { labelPreview } from './live/numbering.js';
import { citationLabel } from './complete/citations.js';
import { vaultSettingsStore } from '../state/vault-settings-store.js';

/** What is drawn as a link, in either mode. */
const LINK_SELECTOR = '.le-link, .le-wikilink, .le-embed-chip, .le-ref, .le-cite, .jmd-cite, .jmd-cite-key, .jmd-wikilink-bracket, .jmd-wikilink-target, .jmd-wikilink-alias, .cmt-link, .cmt-url, .jmd-directive-name, .jmd-directive-bracket, .jmd-directive-punct';
const MOD_KEYS = new Set(['Meta', 'Control']);

/** `'hover' | 'mod' | 'off'`. */
export const previewMode = () => settingsStore.get('linkPreview') ?? 'hover';

/** The vault's resolvers, for previewSpec. */
export const vaultResolvers = (current, doc = null) => ({
	note: (name) => vaultStore.resolveNoteName(name),
	file: (name) => vaultStore.resolveFileName(name),
	current,
	// A reference's label lives in the note being edited (v1: per note).
	label: (key) => (doc ? labelPreview(doc, key, current) : null),
	// A citation's entry, from the .bib cache completion keeps (§5.14).
	cite: (key) => citationLabel(key),
	fullcite: Boolean(String(vaultSettingsStore.get('bibliography') ?? '').trim()),
});

/** Which note each view shows — the pool says (pool.js), since a state
 *  outlives any one path and a view is re-pointed on navigation. */
const notePaths = new WeakMap();
export function setViewNotePath(view, path) { notePaths.set(view, path); }
/** The note a view shows (null before the pool has said). */
export const viewNotePath = (view) => notePaths.get(view) ?? null;

export function linkHover() {
	return ViewPlugin.fromClass(class {
		constructor(view) {
			this.view = view;
			this.key = null;      // the link under the pointer, previewed
			this.last = null;     // the latest pointer sample
			this.frame = 0;
			this.onMove = (e) => {
				this.last = { x: e.clientX, y: e.clientY, target: e.target, mod: e.metaKey || e.ctrlKey };
				if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.check(); });
			};
			this.onLeave = () => { this.last = null; this.key = null; linkPreview().unhover(); };
			this.onKey = (e) => {
				if (MOD_KEYS.has(e.key)) {
					// ⌘ pressed over a link, in `mod` mode: preview now.
					if (this.last && previewMode() === 'mod') { this.last.mod = true; this.key = null; this.check(true); }
					return;
				}
				// Any other key closes it; the same link previews again once
				// the pointer next moves over it.
				this.key = null;
				if (linkPreview().showing) linkPreview().hide();
			};
			this.onScroll = () => { if (linkPreview().showing) linkPreview().hide(); this.key = null; };
			view.dom.addEventListener('mousemove', this.onMove);
			view.dom.addEventListener('mouseleave', this.onLeave);
			view.dom.addEventListener('keydown', this.onKey, true);
			view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
		}

		destroy() {
			cancelAnimationFrame(this.frame);
			this.view.dom.removeEventListener('mousemove', this.onMove);
			this.view.dom.removeEventListener('mouseleave', this.onLeave);
			this.view.dom.removeEventListener('keydown', this.onKey, true);
			this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
		}

		check(now = false) {
			const mode = previewMode();
			const found = mode === 'off' || !this.last ? null : this.linkUnder(this.last);
			if (!found || (mode === 'mod' && !this.last.mod)) {
				if (this.key !== null) { this.key = null; linkPreview().unhover(); }
				return;
			}
			if (found.key === this.key) return;
			this.key = found.key;
			const path = notePaths.get(this.view) ?? null;
			linkPreview().hover(previewSpec(found.link, vaultResolvers(path, this.view.state.doc)), found.rect, path, { now });
		}

		linkUnder({ x, y, target }) {
			const node = target?.nodeType === 1 ? target : target?.parentElement;
			const { view } = this;
			let el = node?.closest?.(LINK_SELECTOR);
			// A reference's KEY is unpainted text in source mode (only the
			// sigil, name and brackets are classed): accept the bare line,
			// and let the geometry below decide.
			const bare = !el && node?.closest?.('.cm-line') && !node.closest('.le-cell-editor') ? node.closest('.cm-line') : null;
			el ??= bare;
			// A table cell edited in place is its own editor (not in v1).
			if (!el || !view.contentDOM.contains(el) || el.closest('.le-cell-editor')) return null;
			const pos = view.posAtCoords({ x, y });
			if (pos === null || literalAt(view.state, pos)) return null;
			const line = view.state.doc.lineAt(pos);
			const link = linkAt(line.text, pos - line.from);
			if (!link || (bare && link.kind !== 'xref')) return null;
			if (bare) {
				// posAtCoords snaps to the nearest position: be sure the
				// pointer is really over the reference's text.
				const a = view.coordsAtPos(line.from + link.from, 1);
				const b = view.coordsAtPos(line.from + link.to, -1);
				if (!a || !b || y < a.top || y > b.bottom || (a.top === b.top && (x < a.left || x > b.right))) return null;
			}
			return { link, key: `${line.from + link.from}:${line.text.slice(link.from, link.to)}`, rect: el.getBoundingClientRect() };
		}
	});
}
