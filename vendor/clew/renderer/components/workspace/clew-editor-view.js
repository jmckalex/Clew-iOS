// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// <clew-editor-view>: hosts the pooled CodeMirror view for one note tab.
// Adopts the pool's DOM on connect; never destroys it (the pool owns views).
import { ClewElement } from '../base/clew-element.js';
import { editorPool } from '../../editor/pool.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { uiStore } from '../../state/ui-store.js';
import { debounce } from '../../lib/debounce.js';
import { scrollSyncBus, makeSuppressor } from '../../preview/scroll-sync.js';
import { EditorView } from '@codemirror/view';
import { settingsStore } from '../../state/settings-store.js';
import { vaultSettingsStore } from '../../state/vault-settings-store.js';
import { liveModel } from '../../editor/live/model.js';
import { deriveState } from '../../editor/toolbar/toolbar-state.js';
import { activeCellOf } from '../../editor/live/active-cell.js';
import '../../editor/toolbar/clew-editor-toolbar.js';

/** Is the formatting bar shown in this mode, under the setting? */
export function toolbarShown(mode) {
	const setting = settingsStore.get('editorToolbar') ?? 'live';
	return setting === 'always' ? mode !== 'reading' : setting === 'live' && mode === 'live';
}

class ClewEditorView extends ClewElement {
	tabId = null;
	path = null;
	#suppressor = makeSuppressor();
	#scrollRaf = 0;
	#scrollDOM = null;
	#saveViewState = debounce(() => {
		const entry = editorPool.get(this.tabId);
		if (!entry?.view) return;
		const { anchor, head } = entry.view.state.selection.main;
		workspaceStore.updateTabView(this.tabId, {
			cursor: { anchor, head },
			cursorLine: entry.view.state.doc.lineAt(head).number,
			scrollTop: entry.view.scrollDOM.scrollTop,
		});
	}, 1000);

	async connectedCallback() {
		super.connectedCallback();
		this.classList.add('editor-host');
		const tabId = this.tabId;
		const entry = await editorPool.open(tabId, this.path);
		// The tab may have switched/closed while the note loaded.
		if (!this.isConnected || this.tabId !== tabId || !entry.view) return;

		this.replaceChildren(entry.view.dom);
		this.#applyMode();
		this.#restoreViewState(entry.view);
		this.#syncConflictBanner();

		entry.view.dom.addEventListener('focusin', this.#onFocusIn);
		entry.view.dom.addEventListener('focusout', this.#onFocusOut);
		this.addEventListener('scroll', this.#onAnyChange, true);
		this.addEventListener('keyup', this.#onAnyChange);
		this.addEventListener('pointerup', this.#onAnyChange);
		this.listen(editorPool, 'conflict-changed', ({ tabId: changed }) => {
			if (changed === this.tabId) this.#syncConflictBanner();
		});
		// Source ↔ live is a flip of THIS view (the tab group keeps it
		// mounted for both), so the mode is followed here.
		this.listen(workspaceStore, 'layout-changed', () => {
			this.#applyMode();
			// Back to an editor jump's origin (tree.js#recordAnchorJump).
			const saved = workspaceStore.findTab(this.tabId)?.tab.view;
			const view = editorPool.get(this.tabId)?.view;
			if (saved?.pendingLine && view && saved.mode !== 'reading') {
				const line = saved.pendingLine;
				delete saved.pendingLine;
				this.#landOn(view, line);
			}
		});
		this.listen(settingsStore, 'settings-changed', (key) => {
			if (key === 'editorToolbar') this.#syncToolbar();
		});
		this.listen(editorPool, 'view-update', ({ tabId: changed }) => {
			if (changed === this.tabId) this.#scheduleToolbarState();
		});
		this.addEventListener('toolbar-escape', () => editorPool.get(this.tabId)?.view?.focus());
		// The toolbar gaining or losing a row moves the editor's top edge by
		// `delta`; move the scroll with it, so the text below the bar holds
		// still on screen. A caret the NEW row now covers (on screen before,
		// in the strip just hidden) is brought back; a caret already off
		// screen stays where it is — scrolling to it jumped the note.
		this.addEventListener('toolbar-resize', (e) => {
			const view = editorPool.get(this.tabId)?.view;
			const delta = e.detail.delta;
			if (!view) return;
			this.#suppressor.suppress();
			view.scrollDOM.scrollTop += delta;
			if (delta <= 0) return;
			const head = view.state.selection.main.head;
			const at = view.coordsAtPos(head);
			const top = view.scrollDOM.getBoundingClientRect().top;
			if (at && at.bottom > top - delta && at.top < top) {
				view.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'nearest' }) });
			}
		});

		// Scroll sync with preview panes showing the same note.
		this.#scrollDOM = entry.view.scrollDOM;
		this.#scrollDOM.addEventListener('scroll', this.#onScrollSync, { passive: true });
		this.listen(scrollSyncBus, 'scroll', this.#onBusScroll);

		if (workspaceStore.activeTab()?.id === tabId) {
			entry.view.focus();
		}
	}

	cleanup() {
		this.#saveViewState.flush();
		editorPool.flush(this.tabId);
		this.#scrollDOM?.removeEventListener('scroll', this.#onScrollSync);
		this.#scrollDOM = null;
		const entry = editorPool.get(this.tabId);
		if (entry?.view) {
			entry.view.dom.removeEventListener('focusin', this.#onFocusIn);
			entry.view.dom.removeEventListener('focusout', this.#onFocusOut);
		}
	}

	/** Put the pooled editor in this tab's mode: source or live edit. */
	#applyMode() {
		const tab = workspaceStore.findTab(this.tabId)?.tab;
		if (!tab || tab.view.mode === 'reading') return;
		const wanted = tab.view.mode === 'live' ? 'live' : 'source';
		const applied = editorPool.setMode(this.tabId, wanted);
		this.dataset.mode = applied ?? wanted;
		this.#syncBigDocNotice(wanted === 'live' && applied === 'source');
		this.#syncToolbar();
	}

	#toolbar = null;
	#toolbarRaf = 0;

	/** Mount or drop the formatting bar (setting × mode), then fill it. */
	#syncToolbar() {
		const tab = workspaceStore.findTab(this.tabId)?.tab;
		const entry = editorPool.get(this.tabId);
		const want = Boolean(tab && entry?.view && toolbarShown(tab.view.mode));
		if (!want) {
			this.#toolbar?.remove();
			this.#toolbar = null;
			return;
		}
		if (!this.#toolbar) {
			this.#toolbar = document.createElement('clew-editor-toolbar');
			this.#toolbar.tabId = this.tabId;
			this.insertBefore(this.#toolbar, entry.view.dom);
		}
		this.#scheduleToolbarState();
	}

	/** The toolbar reflects the cursor — once per frame at most. */
	#scheduleToolbarState() {
		if (!this.#toolbar || this.#toolbarRaf) return;
		this.#toolbarRaf = requestAnimationFrame(() => {
			this.#toolbarRaf = 0;
			const entry = editorPool.get(this.tabId);
			const tab = workspaceStore.findTab(this.tabId)?.tab;
			if (!this.#toolbar || !entry?.view || !tab) return;
			const normalSyntax = vaultSettingsStore.get('normalSyntax') === true;
			const model = liveModel(entry.view.state, { normalSyntax });
			this.#toolbar.setState(deriveState(entry.view.state, model, {
				mode: tab.view.mode, normalSyntax, inCell: Boolean(activeCellOf(entry.view.state)),
			}));
		});
	}

	/** The toolbar element, if shown (view:focus-toolbar). */
	get toolbar() { return this.#toolbar; }

	/** Live edit refuses a very large document; say so where it shows. The
	 *  tab keeps `mode: 'live'`, so a smaller revision turns it back on. */
	#syncBigDocNotice(show) {
		this.querySelector(':scope > .live-refused-banner')?.remove();
		if (!show) return;
		const banner = document.createElement('div');
		banner.className = 'conflict-banner live-refused-banner';
		banner.textContent = 'Live edit is off for documents over 500 KB — showing source.';
		this.prepend(banner);
	}

	/** Show/hide the "file changed on disk" banner for an unresolved conflict. */
	#syncConflictBanner() {
		const entry = editorPool.get(this.tabId);
		this.querySelector(':scope > .conflict-banner')?.remove();
		if (!entry?.conflict) return;

		const banner = document.createElement('div');
		banner.className = 'conflict-banner';
		const text = document.createElement('span');
		text.textContent = 'This file changed on disk while you have unsaved edits. Auto-save is paused.';
		const keep = document.createElement('button');
		keep.textContent = 'Keep my version';
		keep.addEventListener('click', () => editorPool.resolveConflict(this.tabId, 'keep'));
		const reload = document.createElement('button');
		reload.textContent = 'Load disk version';
		reload.addEventListener('click', () => editorPool.resolveConflict(this.tabId, 'reload'));
		banner.append(text, keep, reload);
		this.prepend(banner);
	}

	/** Topmost visible 1-based line of the editor. */
	#topVisibleLine(view) {
		const rect = view.scrollDOM.getBoundingClientRect();
		const pos = view.posAtCoords({ x: rect.left + 8, y: rect.top + 4 }, false);
		return view.state.doc.lineAt(pos).number;
	}

	#onScrollSync = () => {
		if (this.#scrollRaf) return;
		this.#scrollRaf = requestAnimationFrame(() => {
			this.#scrollRaf = 0;
			if (this.#suppressor.active()) return;
			const entry = editorPool.get(this.tabId);
			if (!entry?.view || !this.isConnected) return;
			scrollSyncBus.emit('scroll', {
				path: entry.path,
				line: this.#topVisibleLine(entry.view),
				from: 'editor',
			});
		});
	};

	#onBusScroll = ({ path, line, from }) => {
		if (from === 'editor' || path !== this.path) return;
		const entry = editorPool.get(this.tabId);
		if (!entry?.view || !this.isConnected) return;
		const doc = entry.view.state.doc;
		const target = doc.line(Math.max(1, Math.min(line, doc.lines)));
		this.#suppressor.suppress();
		entry.view.dispatch({
			effects: [EditorView.scrollIntoView(target.from, { y: 'start' })],
		});
	};

	#onFocusIn = () => uiStore.setEditorFocused(true);
	#onFocusOut = () => uiStore.setEditorFocused(false);
	#onAnyChange = () => this.#saveViewState();

	#restoreViewState(view) {
		const tab = workspaceStore.findTab(this.tabId)?.tab;
		const saved = tab?.view;
		if (!saved) return;
		try {
			// Inverse search from the preview lands here as a pending line. It
			// names a spot the reader CLICKED, so it outranks the mere reading
			// position — and consumes it, or a stale line would hijack the next
			// mount of this tab.
			if (saved.pendingLine) {
				const line = saved.pendingLine;
				delete saved.pendingLine;
				delete saved.readingLine;
				this.#landOn(view, line);
				return;
			}
			// Reading mode records where the reader scrolled to. Following it
			// here is what makes ⌘E a flip rather than a jump back to the top:
			// the saved cursor and scrollTop are from BEFORE reading mode opened
			// and no longer say where this tab is. One-shot, so an ordinary tab
			// switch later restores the editor's own position as usual.
			const readingLine = saved.readingLine;
			delete saved.readingLine;
			if (Number.isFinite(readingLine)) {
				this.#landOn(view, readingLine);
				return;
			}
			if (saved.cursor && saved.cursor.head <= view.state.doc.length) {
				view.dispatch({ selection: saved.cursor });
			}
			if (saved.scrollTop) view.scrollDOM.scrollTop = saved.scrollTop;
		} catch { /* stale view state is harmless */ }
	}

	/**
	 * Put a 1-based line at the TOP of the viewport with the cursor at its
	 * start. Top, not `scrollIntoView`'s default 'nearest' (which lands it at
	 * the bottom edge of a freshly mounted view), because that is where the
	 * reading view had it; and the cursor moves with it so the next keystroke
	 * does not yank the view back to wherever the cursor used to be.
	 */
	#landOn(view, line) {
		const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
		view.dispatch({
			selection: { anchor: target.from },
			effects: [EditorView.scrollIntoView(target.from, { y: 'start' })],
		});
	}
}

customElements.define('clew-editor-view', ClewEditorView);
