// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Minimal event emitter: on() returns an unsubscribe function.
export class Emitter {
	#listeners = new Map();

	on(event, fn) {
		let set = this.#listeners.get(event);
		if (!set) this.#listeners.set(event, (set = new Set()));
		set.add(fn);
		return () => set.delete(fn);
	}

	emit(event, payload) {
		const set = this.#listeners.get(event);
		if (set) for (const fn of [...set]) fn(payload);
		if (event !== 'change') {
			const all = this.#listeners.get('change');
			if (all) for (const fn of [...all]) fn({ event, payload });
		}
	}
}
