// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// highlight.js's tokens for a fence's code, as ranges carrying the editor's
// own token classes (code-highlight.js draws them). Pure — tested under node.
import hljs from 'highlight.js/lib/common';

/** highlight.js scopes → the editor's token classes. First match wins
 *  (a scope like `title.function` is tried whole, then by its head). */
const SCOPES = {
	keyword: 'jmd-keyword', built_in: 'jmd-keyword', literal: 'jmd-constant', 'meta.keyword': 'jmd-keyword',
	string: 'jmd-string', regexp: 'jmd-string', 'template-tag': 'jmd-string', 'template-variable': 'jmd-variable',
	number: 'jmd-number', symbol: 'jmd-constant', bullet: 'jmd-constant',
	comment: 'jmd-comment', quote: 'jmd-comment', doctag: 'jmd-comment',
	'title.function': 'jmd-function', 'title.class': 'jmd-type', title: 'jmd-function', function: 'jmd-function',
	type: 'jmd-type', class: 'jmd-type', params: 'jmd-variable', variable: 'jmd-variable', property: 'jmd-variable',
	attr: 'jmd-variable', attribute: 'jmd-variable', tag: 'jmd-keyword', name: 'jmd-keyword', 'selector-tag': 'jmd-keyword',
	'selector-class': 'jmd-type', 'selector-id': 'jmd-type', operator: 'jmd-operator', punctuation: 'jmd-operator',
	meta: 'jmd-keyword', section: 'jmd-keyword', addition: 'jmd-string', deletion: 'jmd-keyword',
};
const classFor = (scope) => SCOPES[scope] ?? SCOPES[scope.split('.')[0]] ?? null;

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#x27;': "'", '&#39;': "'" };

/**
 * The token ranges highlight.js finds in `code`, relative to it, as
 * `[from, to, class]`. Pure over the library's HTML output: the text between
 * tags, entities decoded, is exactly the input.
 */
export function highlightRanges(code, language) {
	let html;
	try { html = hljs.highlight(code, { language, ignoreIllegals: true }).value; } catch { return []; }
	const out = [];
	const stack = [];
	let at = 0;
	const re = /<span class="hljs-([^"]+)">|<\/span>|&(?:lt|gt|amp|quot|#x27|#39);|[^<&]+/g;
	for (let m; (m = re.exec(html));) {
		if (m[1] !== undefined) { stack.push(m[1].split(' ')[0].replace(/_$/, '')); continue; }
		if (m[0] === '</span>') { stack.pop(); continue; }
		const length = ENTITIES[m[0]] ? 1 : m[0].length;
		const cls = stack.length ? classFor(stack[stack.length - 1]) : null;
		if (cls) {
			const last = out[out.length - 1];
			if (last && last[1] === at && last[2] === cls) last[1] += length;
			else out.push([at, at + length, cls]);
		}
		at += length;
	}
	return out;
}

