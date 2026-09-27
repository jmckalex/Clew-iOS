// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Syntax highlighting inside code fences, in the editor (source mode and
// live edit; the owner's report, 2026-09-27: a ```javascript block showed as
// one colour). Reading mode highlights fences with highlight.js, so the
// editor does too — the same library, so the same languages and aliases —
// with its tokens mapped onto the editor's own token colours (the jmd-*
// classes theme.js and editor.css already give keywords, strings, numbers,
// comments…), never highlight.js's stylesheets.
//
// Fences with a grammar of their own in the editor (```tikz / ```latex /
// ```tex / ```metapost — langs/fence-languages.js) are left to it. Only
// fences in the visible ranges are highlighted, each cached by language and
// text, so typing re-highlights the one fence being typed in.
import { ViewPlugin, Decoration } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import hljs from 'highlight.js/lib/common';
import { highlightRanges } from './code-tokens.js';
import { fenceLanguage } from './langs/fence-languages.js';

const cache = new Map();
const MAX_CACHE = 200;
const marks = new Map();
const markOf = (cls) => {
	let m = marks.get(cls);
	if (!m) marks.set(cls, (m = Decoration.mark({ class: `cm-code-token ${cls}` })));
	return m;
};

function build(view) {
	const out = [];
	const tree = syntaxTree(view.state);
	for (const { from, to } of view.visibleRanges) {
		tree.iterate({
			from, to,
			enter(node) {
				if (node.name !== 'FencedCode') return;
				const info = node.node.getChild('CodeInfo');
				const code = node.node.getChild('CodeText');
				if (!info || !code) return false;
				const lang = (/^[^\s{]+/.exec(view.state.doc.sliceString(info.from, info.to)) ?? [''])[0].toLowerCase();
				if (!lang || fenceLanguage(lang) || !hljs.getLanguage(lang)) return false;
				const text = view.state.doc.sliceString(code.from, code.to);
				const key = `${lang}\u0000${text}`;
				let ranges = cache.get(key);
				if (!ranges) {
					ranges = highlightRanges(text, lang);
					if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
					cache.set(key, ranges);
				}
				for (const [a, b, cls] of ranges) out.push(markOf(cls).range(code.from + a, code.from + b));
				return false;
			},
		});
	}
	return Decoration.set(out, true);
}

export const codeHighlight = ViewPlugin.fromClass(class {
	constructor(view) { this.decorations = build(view); }

	update(u) {
		if (u.docChanged || u.viewportChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) this.decorations = build(u.view);
	}
}, { decorations: (v) => v.decorations });
