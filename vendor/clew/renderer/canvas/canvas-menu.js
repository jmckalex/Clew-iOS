// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Canvas context menu: the shared .clew-menu look plus a color-swatch row.
// Items: {label, click, danger?}, {separator: true}, {swatches: true,
// current, onPick(color)} where colors are 'ink' | '1'..'6', or
// {choices: true, label, options: [{value, label, title?}], current,
// onPick(value)} — a compact labeled row of pick-one buttons.

export const CANVAS_COLORS = ['ink', '1', '2', '3', '4', '5', '6'];

export function showCanvasMenu(x, y, items) {
	document.querySelector('.clew-menu')?.remove();
	const menu = document.createElement('div');
	menu.className = 'clew-menu';

	for (const item of items) {
		if (item.separator) {
			const hr = document.createElement('div');
			hr.className = 'menu-separator';
			menu.append(hr);
		} else if (item.choices) {
			const row = document.createElement('div');
			row.className = 'menu-choices';
			if (item.label) {
				const label = document.createElement('span');
				label.className = 'menu-choices-label';
				label.textContent = item.label;
				row.append(label);
			}
			for (const opt of item.options) {
				const button = document.createElement('button');
				button.className = 'menu-choice' + (item.current === opt.value ? ' is-current' : '');
				button.textContent = opt.label;
				if (opt.title) button.title = opt.title;
				button.addEventListener('click', () => {
					close();
					item.onPick(opt.value);
				});
				row.append(button);
			}
			menu.append(row);
		} else if (item.swatches) {
			const row = document.createElement('div');
			row.className = 'menu-swatches';
			for (const color of CANVAS_COLORS) {
				const dot = document.createElement('button');
				dot.className = 'menu-swatch' + (item.current === color ? ' is-current' : '');
				dot.dataset.canvasColor = color;
				dot.title = color === 'ink' ? 'Default' : `Color ${color}`;
				dot.addEventListener('click', () => {
					close();
					item.onPick(color);
				});
				row.append(dot);
			}
			menu.append(row);
		} else {
			const row = document.createElement('button');
			row.className = 'menu-item' + (item.danger ? ' is-danger' : '');
			row.textContent = item.label;
			row.addEventListener('click', () => {
				close();
				item.click?.();
			});
			menu.append(row);
		}
	}

	const close = () => {
		menu.remove();
		window.removeEventListener('pointerdown', onOutside, true);
		window.removeEventListener('keydown', onKey, true);
	};
	const onOutside = (e) => { if (!menu.contains(e.target)) close(); };
	const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
	window.addEventListener('pointerdown', onOutside, true);
	window.addEventListener('keydown', onKey, true);

	document.body.append(menu);
	const rect = menu.getBoundingClientRect();
	menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
	menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
}
