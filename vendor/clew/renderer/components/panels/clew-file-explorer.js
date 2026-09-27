// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// <clew-file-explorer>: the vault file tree. Click opens notes; folders
// collapse; context menus offer create/rename/trash/reveal; renames are
// inline. (Drag-to-move folders/files arrives with M3.)
import { ClewElement } from '../base/clew-element.js';
import { extractAnnotations } from '../../pdf-annotations.js';
import { vaultStore, isNotePath } from '../../state/vault-store.js';
import { isViewablePath, isCanvasPath } from '../../lib/file-types.js';
import { icon } from '../../lib/icons.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { editorPool } from '../../editor/pool.js';
import { ipc, CH } from '../../ipc.js';
import { showMenu } from '../chrome/menu.js';
import { newMarkdownFile, emptyScene } from '../../../shared/excalidraw-file.js';
import { bookmarkStore } from '../../state/bookmark-store.js';
import { settingsStore } from '../../state/settings-store.js';
import * as actions from '../../commands/actions.js';
import { flattenTree, visibleRange, scrollTopFor } from '../../lib/tree-window.js';

class ClewFileExplorer extends ClewElement {
	#collapsed = new Set();
	#pendingRename = null;
	// ---- windowing --------------------------------------------------------
	// Only the rows on screen exist in the DOM. The tree is drawn flat (depth
	// is padding), so the row height is uniform and any scroll position has
	// an index — see lib/tree-window.js for the arithmetic and why: a vault
	// with a library in it had 20,503 rows and took 23.5s to appear.
	#rows = [];          // [{ entry, depth }], the flattened visible tree
	#rowHeight = 0;      // measured once per render, not assumed
	#scroller = null;    // .file-tree — its own scroll container (panels.css)
	#sizer = null;       // holds the full height; rows are absolute inside it
	#painted = null;     // the range currently in the DOM
	#renaming = false;   // an inline rename must not be repainted away
	#resizeObserver = null;

	subscribe() {
		this.listen(vaultStore, 'tree-changed', () => this.render());
		this.listen(vaultStore, 'vault-changed', () => this.render());
		this.listen(workspaceStore, 'active-changed', () => this.#updateActiveHighlight());
		this.listen(workspaceStore, 'layout-changed', () => this.#updateActiveHighlight());
		// Which folders are closed is saved with the workspace, and arrives
		// with it — AFTER the vault-changed/tree-changed renders above, since
		// the workspace loads over IPC once the tree is already on screen.
		// Hence a redraw here rather than a one-time read at startup.
		this.listen(workspaceStore, 'workspace-restored', () => {
			this.#collapsed = new Set(workspaceStore.collapsedFolders);
			this.render();
		});
	}

	#updateActiveHighlight() {
		const activePath = workspaceStore.activeTab()?.path;
		for (const row of this.querySelectorAll('.tree-item.is-file')) {
			row.classList.toggle('is-active', row.dataset.path === activePath);
		}
	}

	render() {
		const header = document.createElement('div');
		header.className = 'panel-header';
		const title = document.createElement('span');
		title.className = 'panel-title';
		title.textContent = vaultStore.vault?.name ?? 'No vault';
		const actions = document.createElement('span');
		actions.className = 'panel-actions';
		actions.append(
			this.#actionButton('New note', 'file-plus', () => this.createNote()),
			this.#actionButton('New folder', 'folder-plus', () => this.createFolder('')),
		);
		header.append(title, actions);

		// Keep the reader where they were: a tree-changed redraw (a file saved
		// somewhere else in the vault, say) must not jump the explorer home.
		const keepScroll = this.#scroller?.scrollTop ?? 0;

		const treeEl = document.createElement('div');
		treeEl.className = 'file-tree';
		const sizer = document.createElement('div');
		sizer.className = 'file-tree-sizer';
		treeEl.append(sizer);
		// The background of the tree is the vault root as a drop target and as
		// a context menu; with windowing the sizer is usually what the pointer
		// actually lands on, so both count as "not a row".
		treeEl.addEventListener('contextmenu', (e) => {
			if (e.target === treeEl || e.target === sizer) {
				e.preventDefault();
				this.#rootMenu(e.clientX, e.clientY);
			}
		});
		treeEl.addEventListener('scroll', () => this.#paint(), { passive: true });

		this.replaceChildren(header, treeEl);
		this.#scroller = treeEl;
		this.#sizer = sizer;
		this.#painted = null;
		this.#rows = flattenTree(vaultStore.tree, this.#collapsed);
		this.#rowHeight = this.#measureRowHeight();
		sizer.style.height = `${this.#rows.length * this.#rowHeight}px`;
		treeEl.scrollTop = keepScroll;
		this.#paint();

		// The sidebar is resizable, and a taller panel shows more rows.
		this.#resizeObserver?.disconnect();
		this.#resizeObserver = new ResizeObserver(() => this.#paint());
		this.#resizeObserver.observe(treeEl);

		if (this.#pendingRename) {
			const path = this.#pendingRename;
			this.#pendingRename = null;
			const row = this.#revealRow(path);
			if (row) this.#startRename(row);
		}
	}

	cleanup() {
		this.#resizeObserver?.disconnect();
		this.#resizeObserver = null;
	}

	/**
	 * One row's height, measured rather than assumed: the row is a flex box
	 * of text, so a theme or a font change moves it, and every index in the
	 * window depends on it being right.
	 */
	#measureRowHeight() {
		const probe = document.createElement('div');
		probe.className = 'tree-item is-file';
		probe.style.visibility = 'hidden';
		const name = document.createElement('span');
		name.className = 'tree-name';
		name.textContent = 'Ag';
		probe.append(name);
		this.#sizer.append(probe);
		const height = probe.offsetHeight;
		probe.remove();
		return height || 22; // detached or display:none — a sane row height
	}

	/** Build exactly the rows the viewport needs, and no others. */
	#paint() {
		if (!this.#scroller || !this.#sizer || this.#renaming) return;
		const range = visibleRange({
			scrollTop: this.#scroller.scrollTop,
			viewportHeight: this.#scroller.clientHeight,
			rowHeight: this.#rowHeight,
			total: this.#rows.length,
		});
		if (this.#painted && this.#painted.first === range.first && this.#painted.last === range.last) return;
		this.#painted = range;
		const rows = [];
		for (let i = range.first; i < range.last; i++) {
			const { entry, depth } = this.#rows[i];
			const row = this.#buildRow(entry, depth);
			row.style.top = `${i * this.#rowHeight}px`;
			rows.push(row);
		}
		this.#sizer.replaceChildren(...rows);
	}

	/**
	 * Scroll a path into view and return its row, building the window around
	 * it — "Rename…" on a row the user right-clicked is always on screen, but
	 * a note just created by the palette need not be.
	 */
	#revealRow(path) {
		const index = this.#rows.findIndex((r) => r.entry.path === path);
		if (index < 0) return null;
		const top = scrollTopFor({
			index,
			scrollTop: this.#scroller.scrollTop,
			viewportHeight: this.#scroller.clientHeight,
			rowHeight: this.#rowHeight,
		});
		if (top !== null) {
			this.#scroller.scrollTop = top;
			this.#painted = null;
			this.#paint();
		}
		return this.#sizer.querySelector(`.tree-item[data-path="${CSS.escape(path)}"]`);
	}

	#actionButton(titleText, iconName, onClick) {
		const button = document.createElement('button');
		button.className = 'icon-button';
		button.title = titleText;
		button.append(icon(iconName));
		button.addEventListener('click', onClick);
		return button;
	}

	/** One row. The same element the explorer always drew, positioned by index. */
	#buildRow(entry, depth) {
		const row = document.createElement('div');
		row.className = `tree-item is-${entry.type}`;
		row.dataset.path = entry.path;
		row.style.paddingLeft = `${10 + depth * 18}px`;

		if (entry.type === 'folder') {
			const chevron = document.createElement('span');
			chevron.className = 'tree-chevron';
			chevron.append(icon(this.#collapsed.has(entry.path) ? 'chevron-right' : 'chevron-down'));
			row.append(chevron);
		}

		const name = document.createElement('span');
		name.className = 'tree-name';
		name.textContent = entry.type === 'file' ? entry.name.replace(/\.(md|jmd|canvas)$/i, '') : entry.name;
		row.append(name);

		const activePath = workspaceStore.activeTab()?.path;
		if (entry.type === 'file' && entry.path === activePath) row.classList.add('is-active');

		row.addEventListener('click', (e) => {
			if (this.#dragJustEnded) return;
			if (entry.type === 'folder') {
				this.#toggleFolder(entry.path);
				return;
			}
			// Default per the explorer setting (new tab, Obsidian-style
			// replace available); ⌘/Ctrl-click inverts it. A file already
			// open in the group focuses its existing tab either way.
			const newTabDefault = settingsStore.get('explorerOpenMode') !== 'replace';
			const newTab = (e.metaKey || e.ctrlKey) ? !newTabDefault : newTabDefault;
			this.#openEntry(entry, { newTab });
		});
		row.addEventListener('pointerdown', (e) => this.#maybeStartDrag(e, entry, row));
		row.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.#itemMenu(entry, e.clientX, e.clientY);
		});

		return row;
	}

	#openEntry(entry, opts = {}) {
		if (isNotePath(entry.path)) workspaceStore.openNote(entry.path, opts);
		else if (isCanvasPath(entry.path)) workspaceStore.openCanvas(entry.path, opts);
		else if (isViewablePath(entry.path)) workspaceStore.openFile(entry.path, opts);
	}

	#toggleFolder(path) {
		if (this.#collapsed.has(path)) this.#collapsed.delete(path);
		else this.#collapsed.add(path);
		workspaceStore.setCollapsedFolders(this.#collapsed);
		this.render();
	}

	// ---- drag to move -----------------------------------------------------

	#dragJustEnded = false;

	#maybeStartDrag(e, entry, row) {
		if (e.button !== 0 || e.target.classList.contains('tree-rename-input')) return;
		const startX = e.clientX;
		const startY = e.clientY;
		let ghost = null;
		let highlighted = null;
		let target = null; // '' for vault root, or a folder path, or null (invalid)

		const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

		const clearHighlight = () => {
			highlighted?.classList.remove('drop-into');
			this.querySelector('.file-tree')?.classList.remove('drop-into-root');
			highlighted = null;
		};

		const onMove = (ev) => {
			if (!ghost) {
				if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
				ghost = document.createElement('div');
				ghost.className = 'tab-ghost';
				ghost.textContent = entry.name.replace(/\.(md|jmd)$/i, '');
				document.body.append(ghost);
				try { row.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
				document.body.classList.add('is-tab-dragging');
			}
			ghost.style.transform = `translate(${ev.clientX + 8}px, ${ev.clientY + 8}px)`;

			const under = document.elementFromPoint(ev.clientX, ev.clientY);
			const folderRow = under?.closest('.tree-item.is-folder');
			const treeBg = under?.closest('.file-tree');
			clearHighlight();
			target = null;

			let candidate = null;
			if (folderRow) candidate = folderRow.dataset.path;
			else if (treeBg) candidate = ''; // vault root
			if (candidate === null) return;

			// Guards: no-op moves and folders into their own subtree.
			if (candidate === parentOf(entry.path)) return;
			if (entry.type === 'folder'
				&& (candidate === entry.path || candidate.startsWith(entry.path + '/'))) return;

			target = candidate;
			if (folderRow) {
				highlighted = folderRow;
				folderRow.classList.add('drop-into');
			} else {
				treeBg.classList.add('drop-into-root');
			}
		};

		const finish = async (apply) => {
			row.removeEventListener('pointermove', onMove);
			row.removeEventListener('pointerup', onUp);
			row.removeEventListener('pointercancel', onCancel);
			clearHighlight();
			const dragged = ghost !== null;
			ghost?.remove();
			ghost = null;
			document.body.classList.remove('is-tab-dragging');
			if (dragged) {
				this.#dragJustEnded = true;
				setTimeout(() => { this.#dragJustEnded = false; }, 0);
			}
			if (!apply || !dragged || target === null) return;
			const name = entry.path.split('/').pop();
			await this.#moveEntry(entry.path, target ? `${target}/${name}` : name);
		};

		const onUp = () => finish(true);
		const onCancel = () => finish(false);
		row.addEventListener('pointermove', onMove);
		row.addEventListener('pointerup', onUp);
		row.addEventListener('pointercancel', onCancel);
	}

	/** Rename/move + all the renderer-side path remaps. */
	async #moveEntry(path, newPath) {
		if (path === newPath) return;
		try {
			await ipc.invoke(CH.FS_RENAME, { path, newPath });
			workspaceStore.remapPaths(path, newPath);
			editorPool.remapPath(path, newPath);
			bookmarkStore.remap(path, newPath);
			this.#remapCollapsed(path, newPath);
		} catch (err) {
			console.error('Move failed:', err);
		}
	}

	/** Follow a renamed or moved folder — and everything closed inside it,
	 *  which a rename of an ancestor moves just as surely. */
	#remapCollapsed(path, newPath) {
		let touched = false;
		for (const collapsed of [...this.#collapsed]) {
			if (collapsed !== path && !collapsed.startsWith(path + '/')) continue;
			this.#collapsed.delete(collapsed);
			this.#collapsed.add(newPath + collapsed.slice(path.length));
			touched = true;
		}
		if (touched) workspaceStore.setCollapsedFolders(this.#collapsed);
	}

	// ---- actions ----------------------------------------------------------

	async createNote(folder = '') {
		if (!vaultStore.vault) return;
		const rel = folder ? `${folder}/Untitled.md` : 'Untitled.md';
		try {
			const created = await ipc.invoke(CH.NOTE_CREATE, { path: rel });
			this.#pendingRename = created;
			workspaceStore.openNote(created);
		} catch (err) {
			console.error('Create note failed:', err);
		}
	}

	async createCanvas(folder = '') {
		if (!vaultStore.vault) return;
		const rel = folder ? `${folder}/Untitled.canvas` : 'Untitled.canvas';
		try {
			const created = await ipc.invoke(CH.NOTE_CREATE, { path: rel });
			this.#pendingRename = created;
			workspaceStore.openCanvas(created);
		} catch (err) {
			console.error('Create canvas failed:', err);
		}
	}

	/**
	 * A new Excalidraw drawing. Unlike a canvas, the file cannot start empty:
	 * Obsidian's plugin only claims a file that carries its frontmatter key and
	 * a Drawing section, so we write the scaffold before opening it — otherwise
	 * the same file would open here as a drawing and there as a blank note.
	 */
	async createDrawing(folder = '') {
		if (!vaultStore.vault) return;
		// Obsidian's convention by default (.excalidraw.md), because a shared
		// vault should look native there. A Clew-only vault can prefer the
		// honest extension — Clew indexes both identically, so nothing is lost
		// by choosing it (see excalidrawFormat in vault settings).
		const settings = await ipc.invoke(CH.VAULT_SETTINGS_GET).catch(() => ({}));
		const plain = settings?.excalidrawFormat === 'json';
		const name = plain ? 'Untitled.excalidraw' : 'Untitled.excalidraw.md';
		const rel = folder ? `${folder}/${name}` : name;
		try {
			const created = await ipc.invoke(CH.NOTE_CREATE, { path: rel });
			await ipc.invoke(CH.NOTE_WRITE, {
				path: created,
				content: plain ? JSON.stringify(emptyScene(), null, 2) : newMarkdownFile(),
			});
			this.#pendingRename = created;
			workspaceStore.openFile(created);
		} catch (err) {
			console.error('Create drawing failed:', err);
		}
	}

	async createFolder(parent = '') {
		if (!vaultStore.vault) return;
		let name = 'New folder';
		let rel = parent ? `${parent}/${name}` : name;
		for (let i = 1; vaultStore.pathExists(rel); i++) {
			name = `New folder ${i}`;
			rel = parent ? `${parent}/${name}` : name;
		}
		try {
			await ipc.invoke(CH.FS_CREATE_FOLDER, { path: rel });
			this.#pendingRename = rel;
		} catch (err) {
			console.error('Create folder failed:', err);
		}
	}

	#itemMenu(entry, x, y) {
		const items = [];
		if (entry.type === 'file') {
			items.push(
				{ label: 'Open in new tab', click: () => this.#openEntry(entry, { newTab: true }) },
				{ label: 'Open in current tab', click: () => this.#openEntry(entry, { newTab: false }) },
				{ label: 'Open to the right (split)', click: () => {
					actions.splitActive('right');
					this.#openEntry(entry, { newTab: false });
				} },
				{ separator: true },
			);
			// A PDF's highlights and notes, as a note beside it (§5.15).
			if (/\.pdf$/i.test(entry.path)) {
				items.push({ label: 'Extract annotations to a note', click: () => extractAnnotations(entry.path) }, { separator: true });
			}
		}
		if (entry.type === 'folder') {
			items.push(
				{ label: 'New note', click: () => this.createNote(entry.path) },
				{ label: 'New canvas', click: () => this.createCanvas(entry.path) },
				{ label: 'New drawing (Excalidraw)', click: () => this.createDrawing(entry.path) },
				{ label: 'New folder', click: () => this.createFolder(entry.path) },
				{ separator: true },
			);
		}
		items.push(
			{ label: 'Rename…', click: () => this.#startRename(this.#revealRow(entry.path)) },
			{ label: 'Reveal in Finder', click: () => ipc.invoke(CH.FS_REVEAL, { path: entry.path }) },
			{ separator: true },
			{ label: 'Delete', danger: true, click: () => this.#trash(entry) },
		);
		showMenu(x, y, items);
	}

	#rootMenu(x, y) {
		showMenu(x, y, [
			{ label: 'New note', click: () => this.createNote() },
			{ label: 'New canvas', click: () => this.createCanvas() },
			{ label: 'New folder', click: () => this.createFolder('') },
		]);
	}

	async #trash(entry) {
		try {
			await ipc.invoke(CH.FS_TRASH, { path: entry.path });
			// Close tabs showing the deleted note (or notes inside a deleted folder).
			for (const group of workspaceStore.allGroups()) {
				for (const tab of [...group.tabs]) {
					if (tab.kind !== 'note') continue;
					if (tab.path === entry.path || tab.path?.startsWith(entry.path + '/')) {
						editorPool.close(tab.id);
						workspaceStore.closeTab(tab.id);
					}
				}
			}
		} catch (err) {
			console.error('Delete failed:', err);
		}
	}

	#startRename(row) {
		if (!row) return;
		// Windowing would otherwise rebuild this row — and the input inside
		// it — the moment the list scrolled a pixel.
		this.#renaming = true;
		const path = row.dataset.path;
		const isFile = row.classList.contains('is-file');
		const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
		const fullName = path.split('/').pop();
		const ext = isFile && /\.[^.]+$/.test(fullName) ? fullName.slice(fullName.lastIndexOf('.')) : '';
		const stem = ext ? fullName.slice(0, -ext.length) : fullName;

		const nameEl = row.querySelector('.tree-name');
		const input = document.createElement('input');
		input.className = 'tree-rename-input';
		input.value = stem;
		nameEl.replaceWith(input);
		input.focus();
		input.select();

		let done = false;
		const commit = async () => {
			if (done) return;
			done = true;
			this.#renaming = false;
			const newStem = input.value.trim();
			if (!newStem || newStem === stem || newStem.includes('/')) {
				this.render();
				return;
			}
			const newPath = (dir ? dir + '/' : '') + newStem + ext;
			await this.#moveEntry(path, newPath);
		};
		input.addEventListener('blur', commit);
		input.addEventListener('keydown', (e) => {
			e.stopPropagation();
			if (e.key === 'Enter') commit();
			if (e.key === 'Escape') { done = true; this.#renaming = false; this.render(); }
		});
		input.addEventListener('click', (e) => e.stopPropagation());
	}
}

customElements.define('clew-file-explorer', ClewFileExplorer);
