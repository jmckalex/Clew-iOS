// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// A formula typeset in place (plan §5.6) — MathJax in the APP page, through
// lib/mathjax.js, with no engine round trip. Before MathJax has loaded the
// widget shows the source in the math face and fills itself in when it can;
// a TeX error shows the source underlined in red with the message as its
// tooltip, which is what an author needs to fix it.
import { WidgetType } from '@codemirror/view';
import { typesetTex, mathReady, mathLoaded } from '../../../lib/mathjax.js';

export class MathWidget extends WidgetType {
	/**
	 * @param {string} tex - the formula, delimiters stripped
	 * @param {boolean} display - display style (`$$…$$`, `\[…\]`, environments)
	 * @param {string} source - the construct's full source, shown while pending
	 * @param {boolean} [block] - a block replacement (its own line or lines)
	 * @param {string} [tag] - an `@begin(equation)`'s number, shown "(n)" at
	 *   the right as the engine's .eqn-number (numbering.js)
	 */
	constructor(tex, display, source, block = false, tag = '') {
		super();
		this.tex = tex;
		this.display = display;
		this.source = source;
		this.block = block;
		this.tag = tag;
	}

	eq(other) {
		return other.tex === this.tex && other.display === this.display && other.block === this.block && other.tag === this.tag;
	}

	toDOM(view) {
		const el = document.createElement(this.block ? 'div' : 'span');
		el.className = `le-math le-reveal-on-click${this.display ? ' le-math-display' : ''}${this.block ? ' le-math-block' : ''}`;
		if (this.tag) el.dataset.leTag = `(${this.tag})`;
		if (!this.fill(el) ) {
			el.classList.add('le-math-pending');
			el.textContent = this.source;
			mathReady().then(() => {
				if (!el.isConnected) return;
				el.classList.remove('le-math-pending');
				el.textContent = '';
				this.fill(el);
				view.requestMeasure();
			}).catch(() => {});
		}
		return el;
	}

	/** Put the typeset formula in `el`; false when MathJax is not in yet. */
	fill(el) {
		if (!mathLoaded()) return false;
		const out = typesetTex(this.tex, { display: this.display });
		if (!out) return false;
		const error = out.getAttribute('data-mjx-error');
		if (error) {
			el.classList.add('le-math-error');
			el.title = error;
			el.textContent = this.source;
			return true;
		}
		el.append(out);
		return true;
	}

	get estimatedHeight() { return this.block ? 48 : -1; }

	ignoreEvent(event) { return event.type !== 'mousedown'; }
}

/**
 * A formula as a free-standing element (table cells, the inline renderer):
 * typeset now when MathJax is in, else the source until it is.
 */
export function mathElement(tex, display, source) {
	const el = document.createElement('span');
	el.className = `le-math${display ? ' le-math-display' : ''}`;
	const fill = () => {
		const out = typesetTex(tex, { display });
		if (!out) return false;
		el.textContent = '';
		if (out.getAttribute('data-mjx-error')) {
			el.classList.add('le-math-error');
			el.textContent = source;
		} else el.append(out);
		return true;
	};
	if (!mathLoaded() || !fill()) {
		el.textContent = source;
		el.classList.add('le-math-pending');
		mathReady().then(() => { el.classList.remove('le-math-pending'); fill(); }).catch(() => {});
	}
	return el;
}
