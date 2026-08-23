// Generic fuzzy list modal: powers the command palette and template picker.
// items: [{label, detail?, hint?, run()}]
import { fuzzyFilter } from '../../lib/fuzzy.js';

export function openListModal({ placeholder, items, emptyText = 'No matches' }) {
	if (document.querySelector('.clew-modal')) return;

	const overlay = document.createElement('div');
	overlay.className = 'clew-modal';
	overlay.innerHTML = `
		<div class="modal-box">
			<input class="modal-input" type="text" placeholder="${placeholder}" spellcheck="false">
			<div class="modal-results"></div>
		</div>
	`;
	const input = overlay.querySelector('.modal-input');
	const results = overlay.querySelector('.modal-results');
	let filtered = [];
	let selected = 0;

	const close = () => {
		overlay.remove();
		window.removeEventListener('keydown', onKey, true);
	};

	const pick = (item) => {
		close();
		item?.run();
	};

	const renderResults = () => {
		const query = input.value.trim();
		filtered = query ? fuzzyFilter(query, items, (i) => i.label, 40) : items.slice(0, 40);
		selected = Math.min(selected, Math.max(0, filtered.length - 1));
		results.replaceChildren(...filtered.map((item, i) => {
			const row = document.createElement('div');
			row.className = 'modal-result' + (i === selected ? ' is-selected' : '');
			const label = document.createElement('span');
			label.className = 'result-label';
			label.textContent = item.label;
			row.append(label);
			if (item.detail) {
				const detail = document.createElement('span');
				detail.className = 'result-detail';
				detail.textContent = item.detail;
				row.append(detail);
			}
			if (item.hint) {
				const hint = document.createElement('span');
				hint.className = 'result-hint';
				hint.textContent = item.hint;
				row.append(hint);
			}
			row.addEventListener('pointerdown', (e) => { e.preventDefault(); pick(item); });
			return row;
		}));
		if (filtered.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'modal-empty';
			empty.textContent = emptyText;
			results.replaceChildren(empty);
		}
	};

	const onKey = (e) => {
		if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
		if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(selected + 1, filtered.length - 1); renderResults(); }
		else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(selected - 1, 0); renderResults(); }
		else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); pick(filtered[selected]); }
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
