// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// One line of text asked for, in the list modal's frame: Enter answers with
// what was typed (possibly empty), Escape or a click outside with null.
// `hint` is a line under the field saying what an answer does.
export function openInputModal({ placeholder = '', value = '', hint = '' }) {
	if (document.querySelector('.clew-modal')) return Promise.resolve(null);
	const overlay = document.createElement('div');
	overlay.className = 'clew-modal';
	const box = document.createElement('div');
	box.className = 'modal-box';
	const input = document.createElement('input');
	input.className = 'modal-input';
	input.type = 'text';
	input.spellcheck = false;
	input.placeholder = placeholder;
	input.value = value;
	box.append(input);
	if (hint) {
		const line = document.createElement('div');
		line.className = 'modal-hint';
		line.textContent = hint;
		box.append(line);
	}
	overlay.append(box);
	return new Promise((resolve) => {
		const close = (answer) => {
			overlay.remove();
			window.removeEventListener('keydown', onKey, true);
			resolve(answer);
		};
		const onKey = (e) => {
			if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
			else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(input.value); }
		};
		window.addEventListener('keydown', onKey, true);
		overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(null); });
		document.body.append(overlay);
		input.focus();
		input.select();
	});
}
