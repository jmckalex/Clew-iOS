// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Named TeX fragments: preamble text a figure asks for by name rather than
// carrying a copy of (`clew-fragments='math macros, colours'`). Two halves —
// src/engine/tex-fragments.js decides WHICH text a name means (and that a
// vault fragment shadows a global one), src/engine/figures.js decides WHERE
// in the document it goes, which differs per kind exactly as `font=note`
// does. Both run in the render worker; the settings view imports the first
// for its own hints, so a name that shadows in one place shadows in both.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	collectFragments, fragmentKey, fragmentNames, fragmentSets, resolveFragments,
} from '../vendor/clew/engine/tex-fragments.js';
import { applyTexFragments, figureElement, TiKZ, tikzDirective } from '../vendor/clew/engine/figures.js';

const macros = '\\newcommand{\\R}{\\mathbb{R}}';
const colours = '\\definecolor{accent}{HTML}{4C8BF5}';

const table = resolveFragments({
	global: [{ name: 'math macros', text: macros }, { name: 'colours', text: colours }],
	vault: [],
});

// ---- names and scopes ------------------------------------------------------

test('a name matches whatever the case and spacing', () => {
	assert.equal(fragmentKey('Math  Macros '), 'math macros');
	assert.equal(fragmentKey('  colours'), 'colours');
	assert.equal(fragmentKey(undefined), '');
});

test('the attribute is a comma list, in the order asked', () => {
	assert.deepEqual(fragmentNames("math macros, colours"), ['math macros', 'colours']);
	assert.deepEqual(fragmentNames('  spaced  '), ['spaced']);
	assert.deepEqual(fragmentNames(',,'), []);
	assert.deepEqual(fragmentNames(undefined), []);
});

test('a vault fragment shadows a global one of the same name', () => {
	const both = resolveFragments({
		global: [{ name: 'math macros', text: macros }],
		vault: [{ name: 'Math Macros', text: '\\newcommand{\\R}{\\mathbf{R}}' }],
	});
	const entry = both.get('math macros');
	assert.equal(entry.scope, 'vault');
	assert.equal(entry.text, '\\newcommand{\\R}{\\mathbf{R}}');
	// …and the global one is still there under its own name if renamed.
	assert.equal(both.size, 1);
});

test('an unnamed row is not a fragment, and a name repeated in one scope takes the last', () => {
	const resolved = resolveFragments({
		global: [{ name: '', text: 'ignored' }, { name: 'dup', text: 'first' }, { name: 'dup', text: 'second' }],
	});
	assert.equal(resolved.size, 1);
	assert.equal(resolved.get('dup').text, 'second');
});

test('junk in the stored list cannot break a render', () => {
	const resolved = resolveFragments({ global: [null, 42, { text: 'no name' }], vault: 'not a list' });
	assert.equal(resolved.size, 0);
	assert.deepEqual(collectFragments(['whatever'], resolved), { text: '', missing: ['whatever'] });
});

test('collect: the order asked, once each, and the names nothing defines', () => {
	assert.deepEqual(collectFragments(['colours', 'math macros'], table),
		{ text: `${colours}\n${macros}`, missing: [] });
	assert.deepEqual(collectFragments(['math macros', 'MATH MACROS'], table),
		{ text: macros, missing: [] });
	assert.deepEqual(collectFragments(['math macros', 'typo'], table),
		{ text: macros, missing: ['typo'] });
});

test('a defined but empty fragment contributes nothing and is not missing', () => {
	const resolved = resolveFragments({ global: [{ name: 'empty', text: '   \n' }] });
	assert.deepEqual(collectFragments(['empty'], resolved), { text: '', missing: [] });
});

test('the sets come from the environment, and nothing there is not a failure', () => {
	const saved = globalThis.CLEW_TEX_FRAGMENTS;
	try {
		globalThis.CLEW_TEX_FRAGMENTS = JSON.stringify({ global: [{ name: 'a', text: 'x' }] });
		assert.equal(resolveFragments(fragmentSets()).get('a').text, 'x');
		globalThis.CLEW_TEX_FRAGMENTS = 'not json';
		assert.deepEqual(fragmentSets(), {});
		globalThis.CLEW_TEX_FRAGMENTS = undefined;
		assert.deepEqual(fragmentSets(), {});
	} finally { globalThis.CLEW_TEX_FRAGMENTS = saved; }
});

// ---- where the text lands --------------------------------------------------

test('a ```latex snippet takes its fragments through the preamble attribute', () => {
	const { source, attrs, refusal } = applyTexFragments('latex', '$\\R$', { 'clew-fragments': 'math macros' }, table);
	assert.equal(refusal, null);
	assert.equal(source, '$\\R$'); // the wrapper has not run yet
	assert.equal(attrs.preamble, macros);
	assert.equal(attrs['clew-fragments'], undefined); // consumed, never an element attribute
});

test("the author's own preamble= on the fence stays last: the fence is the more specific", () => {
	const { attrs } = applyTexFragments('latex', '$\\R$',
		{ 'clew-fragments': 'math macros', preamble: '\\usepackage{mine}' }, table);
	assert.equal(attrs.preamble, `${macros}\n\\usepackage{mine}`);
});

test('a complete document takes them after its own \\documentclass', () => {
	const doc = '\\documentclass[12pt]{article}\n\\begin{document}\n$\\R$\n\\end{document}';
	const { source, attrs } = applyTexFragments('latex', doc, { 'clew-fragments': 'math macros' }, table);
	assert.equal(source, `\\documentclass[12pt]{article}\n${macros}\n\\begin{document}\n$\\R$\n\\end{document}`);
	assert.equal(attrs.preamble, undefined); // nothing for the library to apply twice
});

test('a \\documentclass written with spaces still takes them (it is TeX-legal)', () => {
	// The insert is silent when it fails, and font=note uses the same helper,
	// so the spacing TeX allows is allowed here.
	const doc = '\\documentclass [12pt] {article}\n\\begin{document}\nx\n\\end{document}';
	const { source } = applyTexFragments('latex', doc, { 'clew-fragments': 'math macros' }, table);
	assert.ok(source.includes(`{article}\n${macros}`), source.slice(0, 80));
});

test('plain ```tex has no preamble, so the text goes at the top', () => {
	const { source } = applyTexFragments('tex', '\\notefont Hello\n\\bye', { 'clew-fragments': 'math macros' }, table);
	assert.equal(source, `${macros}\n\\notefont Hello\n\\bye`);
});

test('a ```tikz picture: the library wraps it, so the text rides in preamble', () => {
	const { source, attrs } = applyTexFragments('tikz', '\\begin{tikzpicture}\\end{tikzpicture}',
		{ 'clew-fragments': 'colours' }, table);
	assert.equal(source, '\\begin{tikzpicture}\\end{tikzpicture}');
	assert.equal(attrs.preamble, colours);
});

test('no attribute is no change at all', () => {
	const attrs = { border: '2pt' };
	const out = applyTexFragments('latex', 'x', attrs, table);
	assert.deepEqual(out, { source: 'x', attrs: { border: '2pt' }, refusal: null });
});

test('the directive and the environment take the attribute too', () => {
	// The directive is parsed by figures.js' own attribute subset…
	const token = tikzDirective.tokenizer(":::TiKZ{clew-fragments='colours'}\n\\fill[accent] (0,0) circle (1);\n:::\n");
	assert.equal(token.figureAttrs['clew-fragments'], 'colours');
	// …and the environment by the ENGINE's own parser, which keeps a
	// hyphenated key verbatim (attributes-parser, measured 2026-09-18) —
	// which is the only reason `clew-fragments` works on all six syntaxes.
	const saved = globalThis.CLEW_TEX_FRAGMENTS;
	try {
		globalThis.CLEW_TEX_FRAGMENTS = JSON.stringify({ global: [{ name: 'colours', text: colours }] });
		const html = TiKZ.html({ rawText: '\\fill[accent] (0,0) circle (1);', attrs: { 'clew-fragments': 'colours' } });
		assert.match(html, /data-preamble="[^"]*definecolor/);
	} finally { globalThis.CLEW_TEX_FRAGMENTS = saved; }
});

// ---- refusals BY NAME ------------------------------------------------------

test('a name nothing defines refuses the figure, and says which name', () => {
	const { refusal } = applyTexFragments('latex', '$\\R$', { 'clew-fragments': 'math macros, typo' }, table);
	assert.match(refusal, /TeX fragment not defined here: “typo”/);
	assert.match(refusal, /Settings → TeX fragments/);
});

test('several missing names are all reported, and the plural is right', () => {
	const { refusal } = applyTexFragments('latex', '$x$', { 'clew-fragments': 'one, two' }, table);
	assert.match(refusal, /TeX fragments not defined here: “one”, “two”/);
});

test('MetaPost has no preamble, and says so rather than dropping the attribute', () => {
	const { refusal } = applyTexFragments('metapost', 'beginfig(1); endfig;',
		{ 'clew-fragments': 'math macros' }, table);
	assert.match(refusal, /MetaPost figure has no preamble/);
	assert.match(refusal, /verbatimtex/);
});

// ---- end to end, through the element ---------------------------------------

test('the element carries the fragment text, not the name', () => {
	const saved = globalThis.CLEW_TEX_FRAGMENTS;
	try {
		globalThis.CLEW_TEX_FRAGMENTS = JSON.stringify({
			global: [{ name: 'math macros', text: macros }],
			vault: [{ name: 'colours', text: colours }],
		});
		const html = figureElement('latex', '$\\R$', { 'clew-fragments': 'math macros, colours' });
		assert.match(html, /<tikz-diagram/);
		assert.match(html, /newcommand\{\\R\}/);
		assert.match(html, /definecolor\{accent\}/);
		assert.ok(!/clew-fragments/.test(html), 'the name must not reach the element');
		// The wrapper put them in the preamble, after the packages Clew adds
		// and before the document: a fragment can redefine what is above it.
		const body = html.slice(html.indexOf('>') + 1);
		assert.ok(body.indexOf('usepackage{amsmath') < body.indexOf('newcommand'), 'fragments come after Clew\'s own packages');
		assert.ok(body.indexOf('newcommand') < body.indexOf('begin{document}'), 'fragments are preamble, not body');
	} finally { globalThis.CLEW_TEX_FRAGMENTS = saved; }
});

test('a refused figure is the message, and no engine is asked to run', () => {
	const saved = globalThis.CLEW_TEX_FRAGMENTS;
	try {
		globalThis.CLEW_TEX_FRAGMENTS = JSON.stringify({ global: [] });
		const html = figureElement('latex', '$x$', { 'clew-fragments': 'nope' });
		assert.match(html, /class="clew-figure-refused"/);
		assert.match(html, /“nope”/);
		assert.ok(!/<tikz-diagram/.test(html));
	} finally { globalThis.CLEW_TEX_FRAGMENTS = saved; }
});

test('font=note puts its block in first, so a fragment can still override the face', () => {
	const saved = { frags: globalThis.CLEW_TEX_FRAGMENTS, fonts: globalThis.CLEW_NOTE_FONTS };
	try {
		globalThis.CLEW_TEX_FRAGMENTS = JSON.stringify({ global: [{ name: 'f', text: '\\setmainfont{Mine.ttf}' }] });
		globalThis.CLEW_NOTE_FONTS = JSON.stringify({ Regular: 'AvenirNext-Regular.ttf' });
		const html = figureElement('latex', 'Hello', { 'clew-fragments': 'f', font: 'note' });
		const setmain = html.indexOf('setmainfont{AvenirNext-Regular.ttf}');
		const mine = html.indexOf('setmainfont{Mine.ttf}');
		assert.ok(setmain > -1 && mine > -1, 'both font blocks are present');
		assert.ok(setmain < mine, 'the fragment comes last, so TeX gives it the final word');
	} finally {
		globalThis.CLEW_TEX_FRAGMENTS = saved.frags;
		globalThis.CLEW_NOTE_FONTS = saved.fonts;
	}
});

test('the same fragment text produces the same figure key, a different one does not', () => {
	const keyOf = (html) => /data-fig-key="([^"]+)"/.exec(html)?.[1];
	const saved = globalThis.CLEW_TEX_FRAGMENTS;
	try {
		globalThis.CLEW_TEX_FRAGMENTS = JSON.stringify({ global: [{ name: 'f', text: macros }] });
		const first = keyOf(figureElement('latex', '$\\R$', { 'clew-fragments': 'f' }));
		globalThis.CLEW_TEX_FRAGMENTS = JSON.stringify({ global: [{ name: 'f', text: `${macros}\n\\newcommand{\\C}{\\mathbb{C}}` }] });
		const second = keyOf(figureElement('latex', '$\\R$', { 'clew-fragments': 'f' }));
		assert.ok(first && second && first !== second, 'editing a fragment re-typesets what uses it');
	} finally { globalThis.CLEW_TEX_FRAGMENTS = saved; }
});
