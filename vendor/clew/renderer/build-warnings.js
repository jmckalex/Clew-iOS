// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What the engine said about a note's last build — its warnings, which since
// jmarkdown 0631c42 include the LaTeX-export lint on every render. Kept per
// note from the render service's EV_RENDER_DONE (reading view, and the
// exports, which set them too) and said QUIETLY: one status-bar item for the
// active note, "⚠ 3", whose tooltip groups them by code (shared/
// build-warnings.js) and whose click lists them. Nothing pops up while you
// write; an export with warnings says so in its notice.
import { ipc, CH } from './ipc.js';
import { Emitter } from './lib/emitter.js';
import { groupWarnings, warningSummary } from '../shared/build-warnings.js';
import { openListModal } from './components/modals/list-modal.js';

export { warningSummary };

class BuildWarnings extends Emitter {
	#byPath = new Map();

	/** The warnings of `path`'s latest build (an empty list clears them). */
	set(path, warnings) {
		const list = Array.isArray(warnings) ? warnings.map(String) : [];
		const before = this.#byPath.get(path) ?? [];
		if (before.length === list.length && before.every((w, i) => w === list[i])) return;
		if (list.length) this.#byPath.set(path, list);
		else this.#byPath.delete(path);
		this.emit('changed', { path });
	}

	get(path) {
		return this.#byPath.get(path) ?? [];
	}

	clear() {
		this.#byPath.clear();
		this.emit('changed', { path: null });
	}
}

export const buildWarnings = new BuildWarnings();

/** The status bar's item for `path`, or null when its build said nothing. */
export function warningsItem(path) {
	const warnings = buildWarnings.get(path);
	if (!warnings.length) return null;
	const el = document.createElement('button');
	el.className = 'status-item clew-build-warnings';
	el.textContent = `⚠ ${warnings.length}`;
	el.title = `${warningSummary(warnings)} — click to list them`;
	el.addEventListener('click', () => showBuildWarnings(path));
	return el;
}

/** Every warning of `path`'s last build, the lint's code beside each. */
export function showBuildWarnings(path) {
	const { items, total } = groupWarnings(buildWarnings.get(path));
	if (!total) return;
	const name = path.split('/').pop().replace(/\.(md|jmd)$/i, '');
	openListModal({
		placeholder: `${total} warning${total === 1 ? '' : 's'} from ${name}'s last build — type to filter`,
		items: items.map((item) => ({
			label: item.text,
			hint: item.code ? `latex-export [${item.code}]` : '',
			run: () => {},
		})),
	});
}

export function installBuildWarnings() {
	ipc.on(CH.EV_RENDER_DONE, ({ path, warnings } = {}) => {
		if (path) buildWarnings.set(path, warnings);
	});
	// Another vault's notes are not this one's.
	ipc.on(CH.EV_VAULT_OPENED, () => buildWarnings.clear());
}
