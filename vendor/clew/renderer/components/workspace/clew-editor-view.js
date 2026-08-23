// <clew-editor-view>: hosts the pooled CodeMirror view for one note tab.
// Adopts the pool's DOM on connect; never destroys it (the pool owns views).
import { ClewElement } from '../base/clew-element.js';
import { editorPool } from '../../editor/pool.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { uiStore } from '../../state/ui-store.js';
import { debounce } from '../../lib/debounce.js';
import { scrollSyncBus, makeSuppressor } from '../../preview/scroll-sync.js';
import { EditorView } from '@codemirror/view';

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
			// Inverse search from the preview lands here as a pending line.
			if (saved.pendingLine) {
				const line = view.state.doc.line(Math.min(saved.pendingLine, view.state.doc.lines));
				delete saved.pendingLine;
				view.dispatch({
					selection: { anchor: line.from },
					effects: [],
					scrollIntoView: true,
				});
				return;
			}
			if (saved.cursor && saved.cursor.head <= view.state.doc.length) {
				view.dispatch({ selection: saved.cursor });
			}
			if (saved.scrollTop) view.scrollDOM.scrollTop = saved.scrollTop;
		} catch { /* stale view state is harmless */ }
	}
}

customElements.define('clew-editor-view', ClewEditorView);
