// The quick switcher (Cmd+O): fuzzy-find a note by name, alias, or path.
// Enter opens (in place), Cmd+Enter opens in a new tab, Shift+Enter creates
// a note with the typed name.
import { vaultStore } from '../../state/vault-store.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { fuzzyFilter } from '../../lib/fuzzy.js';
import { isCanvasPath } from '../../lib/file-types.js';
import { ipc, CH } from '../../ipc.js';

export function openQuickSwitcher() {
	if (document.querySelector('.clew-modal')) return;

	const overlay = document.createElement('div');
	overlay.className = 'clew-modal';
	overlay.innerHTML = `
		<div class="modal-box">
			<input class="modal-input" type="text" placeholder="Find or create a note…" spellcheck="false">
			<div class="modal-results"></div>
			<div class="modal-hint">↵ open · ⌘↵ new tab · ⇧↵ create · esc dismiss</div>
		</div>
	`;
	const input = overlay.querySelector('.modal-input');
	const results = overlay.querySelector('.modal-results');

	let items = [];
	let selected = 0;

	const close = () => {
		overlay.remove();
		window.removeEventListener('keydown', onKey, true);
	};

	const openItem = async (item, { newTab = false, create = false } = {}) => {
		close();
		if (create || !item) {
			const name = input.value.trim();
			if (!name) return;
			try {
				const created = await ipc.invoke(CH.NOTE_CREATE, { path: `${name}.md` });
				workspaceStore.openNote(created, { newTab });
			} catch (err) {
				console.error('Create failed:', err);
			}
			return;
		}
		if (isCanvasPath(item.path)) workspaceStore.openCanvas(item.path, { newTab });
		else workspaceStore.openNote(item.path, { newTab });
	};

	const renderResults = () => {
		const query = input.value.trim();
		const canvases = vaultStore.allPaths().filter(isCanvasPath).map((path) => ({
			label: path.split('/').pop().replace(/\.canvas$/i, ''),
			path,
		}));
		const candidates = [...vaultStore.linkCandidates(), ...canvases];
		items = query
			? fuzzyFilter(query, candidates, (c) => `${c.label} ${c.path}`, 40)
			: candidates.slice(0, 40);
		selected = Math.min(selected, Math.max(0, items.length - 1));

		results.replaceChildren(...items.map((item, i) => {
			const row = document.createElement('div');
			row.className = 'modal-result' + (i === selected ? ' is-selected' : '');
			const label = document.createElement('span');
			label.className = 'result-label';
			label.textContent = item.label + (item.isAlias ? ' ⤷' : '');
			const detail = document.createElement('span');
			detail.className = 'result-detail';
			detail.textContent = item.path;
			row.append(label, detail);
			row.addEventListener('pointerdown', (e) => {
				e.preventDefault();
				openItem(item, { newTab: e.metaKey || e.ctrlKey });
			});
			return row;
		}));
		if (query && items.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'modal-empty';
			empty.textContent = `⇧↵ to create “${query}”`;
			results.replaceChildren(empty);
		}
	};

	const onKey = (e) => {
		if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
		if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(selected + 1, items.length - 1); renderResults(); }
		else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(selected - 1, 0); renderResults(); }
		else if (e.key === 'Enter') {
			e.preventDefault();
			e.stopPropagation();
			openItem(e.shiftKey ? null : items[selected], {
				newTab: e.metaKey || e.ctrlKey,
				create: e.shiftKey,
			});
		}
	};

	input.addEventListener('input', () => { selected = 0; renderResults(); });
	window.addEventListener('keydown', onKey, true);
	overlay.addEventListener('pointerdown', (e) => {
		if (e.target === overlay) close();
	});

	document.body.append(overlay);
	input.focus();
	renderResults();
}
