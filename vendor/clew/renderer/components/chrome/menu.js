// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Lightweight DOM context menu. showMenu(x, y, items) where items are
// {label, click, danger?} or {separator: true}. Closes on click-outside,
// Escape, or item selection.
export function showMenu(x, y, items) {
	document.querySelector('.clew-menu')?.remove();

	const menu = document.createElement('div');
	menu.className = 'clew-menu';
	for (const item of items) {
		if (item.separator) {
			const hr = document.createElement('div');
			hr.className = 'menu-separator';
			menu.append(hr);
			continue;
		}
		const row = document.createElement('button');
		row.className = 'menu-item' + (item.danger ? ' is-danger' : '');
		row.textContent = item.label;
		row.addEventListener('click', () => {
			close();
			item.click?.();
		});
		menu.append(row);
	}

	const close = () => {
		menu.remove();
		window.removeEventListener('pointerdown', onOutside, true);
		window.removeEventListener('keydown', onKey, true);
	};
	const onOutside = (e) => {
		if (!menu.contains(e.target)) close();
	};
	const onKey = (e) => {
		if (e.key === 'Escape') { e.stopPropagation(); close(); }
	};
	window.addEventListener('pointerdown', onOutside, true);
	window.addEventListener('keydown', onKey, true);

	document.body.append(menu);
	// Keep the menu on-screen.
	const rect = menu.getBoundingClientRect();
	menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
	menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
	return close;
}
