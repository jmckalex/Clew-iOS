// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// <clew-app>: the top-level shell — titlebar, left sidebar (explorer),
// workspace, right sidebar (backlinks/outgoing/tags/outline), status bar —
// plus the welcome screen when no vault is open.
import { ClewElement } from '../base/clew-element.js';
import { vaultStore } from '../../state/vault-store.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { ipc, CH } from '../../ipc.js';
import '../workspace/clew-workspace.js';
import '../workspace/clew-shell-panel.js';
import '../workspace/clew-split.js';
import '../workspace/clew-tab-group.js';
import '../panels/clew-file-explorer.js';
import '../panels/clew-search-panel.js';
import '../panels/clew-bookmarks.js';
import '../panels/clew-diary.js';
import '../panels/clew-backlinks.js';
import '../panels/clew-outgoing-links.js';
import '../panels/clew-tag-pane.js';
import '../panels/clew-outline.js';
import '../panels/clew-properties.js';
import '../panels/clew-bibliography.js';
import '../views/clew-graph-view.js';
import './clew-status-bar.js';

const TOOLS = {
	left: [
		{ id: 'files', label: 'Files', element: 'clew-file-explorer' },
		{ id: 'search', label: 'Search', element: 'clew-search-panel' },
		{ id: 'bookmarks', label: 'Marks', element: 'clew-bookmarks' },
		{ id: 'diary', label: 'Diary', element: 'clew-diary' },
	],
	right: [
		{ id: 'backlinks', label: 'Links', element: 'clew-backlinks' },
		{ id: 'outgoing', label: 'Out', element: 'clew-outgoing-links' },
		{ id: 'tags', label: 'Tags', element: 'clew-tag-pane' },
		{ id: 'outline', label: 'Outline', element: 'clew-outline' },
		// Always there (§5.14): its Library needs no render; its "This note"
		// mode stays behind the vault's bibliographyPanel setting.
		{ id: 'bibliography', label: 'Refs', element: 'clew-bibliography' },
		{ id: 'props', label: 'Props', element: 'clew-properties' },
		{
			id: 'graph', label: 'Graph', element: 'clew-graph-view',
			setup: (el) => { el.local = true; el.depth = 1; },
		},
	],
};

class ClewApp extends ClewElement {
	#vaultSettings = null;

	subscribe() {
		this.listen(vaultStore, 'vault-changed', () => { this.render(); this.#refreshVaultTools(); });
		// The settings view announces per-vault setting changes (window-level:
		// the settings tab and this chrome share no store for vault settings).
		this.listen({ on: (ev, cb) => { window.addEventListener(ev, cb); return () => window.removeEventListener(ev, cb); } },
			'clew:vault-settings-changed', () => this.#refreshVaultTools());
		this.listen(workspaceStore, 'sidebar-changed', () => this.#applySidebars());
		this.listen(workspaceStore, 'shell-changed', () => this.#applyShell());
		this.listen(workspaceStore, 'active-changed', () => this.#updateTitle());
		this.listen(workspaceStore, 'layout-changed', () => this.#updateTitle());
	}

	render() {
		if (!vaultStore.vault) {
			this.#renderWelcome();
			return;
		}
		this.innerHTML = `
			<div class="titlebar"><span class="titlebar-text"></span></div>
			<div class="app-body">
				<div class="sidebar sidebar-left">
					<div class="tool-tabs" data-side="left"></div>
					<div class="tool-body" data-side="left"></div>
				</div>
				<div class="sidebar-resizer" data-side="left"></div>
				<div class="center-column">
					<clew-workspace></clew-workspace>
					<div class="shell-resizer"></div>
					<clew-shell-panel></clew-shell-panel>
				</div>
				<div class="sidebar-resizer" data-side="right"></div>
				<div class="sidebar sidebar-right">
					<div class="tool-tabs" data-side="right"></div>
					<div class="tool-body" data-side="right"></div>
				</div>
			</div>
			<clew-status-bar></clew-status-bar>
		`;
		this.#renderTools('left');
		this.#renderTools('right');
		this.#applySidebars();
		this.#updateTitle();
		this.#wireSidebarResize('left');
		this.#wireSidebarResize('right');
		this.#applyShell();
		this.#wireShellResize();
	}

	/** The shell panel's height and whether it is showing at all. */
	#applyShell() {
		const { open, height } = workspaceStore.shell;
		const panel = this.querySelector('clew-shell-panel');
		const resizer = this.querySelector('.shell-resizer');
		if (!panel) return;
		panel.style.height = `${Math.max(80, height)}px`;
		panel.classList.toggle('is-open', open);
		if (resizer) resizer.style.display = open ? '' : 'none';
	}

	/** Drag the seam between the workspace and the shell. */
	#wireShellResize() {
		const resizer = this.querySelector('.shell-resizer');
		const panel = this.querySelector('clew-shell-panel');
		if (!resizer || !panel) return;
		resizer.addEventListener('pointerdown', (event) => {
			event.preventDefault();
			const startY = event.clientY;
			const startHeight = panel.getBoundingClientRect().height;
			resizer.setPointerCapture(event.pointerId);
			const onMove = (move) => {
				// Up is bigger: the panel grows from its top edge.
				const next = Math.min(Math.max(80, startHeight - (move.clientY - startY)),
					Math.max(120, window.innerHeight - 200));
				panel.style.height = `${Math.round(next)}px`;
			};
			const onUp = () => {
				resizer.removeEventListener('pointermove', onMove);
				resizer.removeEventListener('pointerup', onUp);
				workspaceStore.setShell({ height: Math.round(panel.getBoundingClientRect().height) });
			};
			resizer.addEventListener('pointermove', onMove);
			resizer.addEventListener('pointerup', onUp);
		});
	}

	/** Re-fetch vault settings and re-render conditional right-bar tools. */
	#refreshVaultTools() {
		ipc.invoke(CH.VAULT_SETTINGS_GET).then((vs) => {
			this.#vaultSettings = vs ?? {};
			if (this.querySelector('.tool-tabs[data-side="right"]')) this.#renderTools('right');
		}).catch(() => {});
	}

	#renderTools(side) {
		const tools = TOOLS[side].filter((t) => !t.when || t.when(this.#vaultSettings));
		const tabs = this.querySelector(`.tool-tabs[data-side="${side}"]`);
		if (!tabs) return;
		const active = workspaceStore.state.sidebars[side].activeTool ?? tools[0].id;
		tabs.replaceChildren(...tools.map((tool) => {
			const button = document.createElement('button');
			button.className = 'tool-tab' + (tool.id === active ? ' is-active' : '');
			button.textContent = tool.label;
			button.addEventListener('click', () => {
				workspaceStore.setSidebar(side, { activeTool: tool.id });
			});
			return button;
		}));
		const body = this.querySelector(`.tool-body[data-side="${side}"]`);
		const spec = tools.find((t) => t.id === active) ?? tools[0];
		if (body.firstElementChild?.tagName.toLowerCase() !== spec.element) {
			const el = document.createElement(spec.element);
			spec.setup?.(el);
			body.replaceChildren(el);
		}
	}

	/** Open the search tool (left sidebar) and focus its input — with a
	 *  query already in it when one is given (live edit's tag clicks). */
	openSearch(query) {
		workspaceStore.setSidebar('left', { open: true, activeTool: 'search' });
		requestAnimationFrame(() => {
			const panel = this.querySelector('clew-search-panel');
			if (typeof query === 'string') panel?.setQuery(query);
			panel?.focusInput();
		});
	}

	#updateTitle() {
		const el = this.querySelector('.titlebar-text');
		if (!el) return;
		const tab = workspaceStore.activeTab();
		const name = tab?.path ? tab.path.split('/').pop().replace(/\.(md|jmd)$/i, '') : '';
		el.textContent = name ? `${name} — ${vaultStore.vault?.name ?? ''}` : vaultStore.vault?.name ?? '';
	}

	#applySidebars() {
		for (const side of ['left', 'right']) {
			const sidebar = this.querySelector(`.sidebar-${side}`);
			if (!sidebar) continue;
			const { open, width } = workspaceStore.state.sidebars[side];
			sidebar.style.width = `${width}px`;
			sidebar.classList.toggle('is-closed', !open);
			// Tool selection may have changed from elsewhere.
			if (this.querySelector(`.tool-tabs[data-side="${side}"]`)) this.#renderTools(side);
		}
	}

	#wireSidebarResize(side) {
		const handle = this.querySelector(`.sidebar-resizer[data-side="${side}"]`);
		handle?.addEventListener('pointerdown', (e) => {
			e.preventDefault();
			handle.setPointerCapture(e.pointerId);
			const startX = e.clientX;
			const startWidth = workspaceStore.state.sidebars[side].width;
			const direction = side === 'left' ? 1 : -1;
			const onMove = (ev) => {
				const width = Math.max(170, Math.min(520, startWidth + direction * (ev.clientX - startX)));
				workspaceStore.setSidebar(side, { width });
			};
			const onUp = () => {
				handle.removeEventListener('pointermove', onMove);
				handle.removeEventListener('pointerup', onUp);
			};
			handle.addEventListener('pointermove', onMove);
			handle.addEventListener('pointerup', onUp);
		});
	}

	async #renderWelcome() {
		this.innerHTML = `
			<div class="titlebar"><span class="titlebar-text">Clew</span></div>
			<div class="welcome">
				<h1>Clew</h1>
				<p class="welcome-tagline">A thread through your notes.</p>
				<button class="welcome-open">Open vault…</button>
				<div class="welcome-actions">
					<button class="welcome-create">Create new vault…</button>
					<button class="welcome-demo">Explore the demo vault</button>
				</div>
				<p class="welcome-hint">New here? The demo vault is the guided
				tour — every feature, documented in notes you can edit.</p>
				<div class="welcome-recent"></div>
			</div>
		`;
		this.querySelector('.welcome-open').addEventListener('click', () => {
			ipc.invoke(CH.VAULT_OPEN_DIALOG).catch((err) => console.error(err));
		});
		this.querySelector('.welcome-create').addEventListener('click', () => {
			ipc.invoke(CH.VAULT_CREATE_DIALOG).catch((err) => console.error(err));
		});
		this.querySelector('.welcome-demo').addEventListener('click', () => {
			ipc.invoke(CH.VAULT_OPEN_DEMO).catch((err) => console.error(err));
		});

		const recent = await ipc.invoke(CH.VAULT_RECENT).catch(() => []);
		const list = this.querySelector('.welcome-recent');
		if (list && recent?.length) {
			const heading = document.createElement('p');
			heading.className = 'welcome-recent-heading';
			heading.textContent = 'Recent vaults';
			list.append(heading);
			for (const path of recent) {
				const button = document.createElement('button');
				button.className = 'welcome-recent-item';
				button.textContent = path.split('/').pop();
				button.title = path;
				button.addEventListener('click', () => {
					ipc.invoke(CH.VAULT_OPEN_PATH, { path }).catch((err) => console.error(err));
				});
				list.append(button);
			}
		}
	}
}

customElements.define('clew-app', ClewApp);
