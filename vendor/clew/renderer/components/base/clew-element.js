// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Base class for Clew's web components (light DOM). Subscriptions are
// declared in subscribe() via this.listen() and are flushed automatically on
// disconnect — safe across the reconnects that tree reconciliation causes.
export class ClewElement extends HTMLElement {
	#subs = [];

	/** Subscribe to a store event for this component's connected lifetime. */
	listen(emitter, event, fn) {
		this.#subs.push(emitter.on(event, fn));
	}

	connectedCallback() {
		this.subscribe?.();
		this.render?.();
	}

	disconnectedCallback() {
		for (const off of this.#subs) off();
		this.#subs = [];
		this.cleanup?.();
	}
}
