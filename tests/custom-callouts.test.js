// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
// The rules and the table are the ENGINE's since jmarkdown a7de8c6 (Clew's
// shared/custom-callouts.js and engine/callouts.js retired); these tests hold
// what Clew relies on of them.
import { validColor, iconKey, checkEntry, resolveCallouts, NAME_RE } from '#jmarkdown/callout-definitions.js';
import {
	applyCustomCallouts, resolveType, calloutBlock, calloutIcon, calloutColor,
	CALLOUT_TYPES, BUILTIN_CALLOUT_TYPES,
} from '#jmarkdown/callouts.js';

// A stand-in for dist/main/fa-icons.json: `family:name` → [w, h, d].
const ICONS = {
	'solid:pencil': [512, 512, 'M0 0L10 10Z'],
	'solid:flask': [448, 512, 'M1 2L3 4Z'],
	'regular:circle': [512, 512, 'M5 5H9Z'],
	'brands:github': [496, 512, 'M7 7V9Z'],
	'solid:circle': [512, 512, 'M6 6H8Z'],
};
const resolve = (global, vault) => resolveCallouts({ builtins: BUILTIN_CALLOUT_TYPES, global, vault, iconTable: ICONS });

test('names: a letter, then letters, digits, - or _', () => {
	for (const ok of ['x', 'Remark', 'my-type', 'a_1']) assert.ok(NAME_RE.test(ok), ok);
	for (const bad of ['', '1x', '-x', 'a b', 'a.b', 'x!', 'é']) assert.ok(!NAME_RE.test(bad), bad);
});

test('colours: hex, rgb(), hsl() or a CSS name — nothing else', () => {
	for (const ok of ['#abc', '#abcd', '#a1b2c3', '#a1b2c3d4', 'rgb(1, 2, 3)', 'rgba(1,2,3,0.5)', 'rgb(1 2 3 / 50%)',
		'hsl(210, 50%, 40%)', 'hsla(210deg 50% 40% / .3)', 'teal', 'RebeccaPurple']) {
		assert.ok(validColor(ok), ok);
	}
	for (const bad of ['', '#12', '#12345', 'red; background: url(x)', 'var(--x)', 'url(x)', 'expression(alert(1))',
		'rgb(1, 2)', '</style>', 'notacolour', 'rgb(1,2,3);', 'red}', '"red"', 'currentColor', 'transparent']) {
		assert.ok(!validColor(bad), bad);
	}
});

test('icons resolve by name: solid first, a family when named', () => {
	assert.equal(iconKey('pencil', ICONS), 'solid:pencil');
	assert.equal(iconKey('Circle', ICONS), 'solid:circle');
	assert.equal(iconKey('regular:circle', ICONS), 'regular:circle');
	assert.equal(iconKey('github', ICONS), 'brands:github');
	for (const bad of ['nope', 'solid:nope', 'other:pencil', '../pencil', 'solid:pen cil', '<svg>', '']) {
		assert.equal(iconKey(bad, ICONS), null, bad);
	}
});

test('an entry is checked whole: a bad field skips it, with the reason', () => {
	assert.match(checkEntry({ name: '1x' }, ICONS).reason, /not a callout name/);
	assert.match(checkEntry({ name: 'x', icon: 'nope' }, ICONS).reason, /no Font Awesome icon called “nope”/);
	assert.match(checkEntry({ name: 'x', color: 'red;x:y' }, ICONS).reason, /not a colour/);
	assert.match(checkEntry({ name: 'x', aliases: ['ok', 'b a d'] }, ICONS).reason, /alias “b a d”/);
	assert.match(checkEntry('remark', ICONS).reason, /not an entry/);
	assert.match(checkEntry({}, ICONS).reason, /no name/);
	const { entry } = checkEntry({ name: 'Remark', title: `  A\u0000title${'x'.repeat(200)}`, icon: 'flask', color: ' teal ', aliases: ['REM', ''] }, ICONS);
	assert.equal(entry.name, 'remark');
	assert.equal(entry.title.length, 80);
	assert.ok(!entry.title.includes('\u0000'));
	assert.equal(entry.icon, 'solid:flask');
	assert.equal(entry.color, 'teal');
	assert.deepEqual(entry.aliases, ['rem']);
});

test('precedence: built-in < global < vault, field by field', () => {
	const { custom, problems } = resolve(
		[{ name: 'remark', title: 'Remark', icon: 'flask', color: '#123456' }, { name: 'note', color: 'teal' }],
		[{ name: 'remark', color: 'orange' }, { name: 'idea', icon: 'regular:circle' }],
	);
	assert.deepEqual(problems, []);
	// The vault's colour, the global's title and icon.
	assert.deepEqual(custom.remark, { label: 'Remark', color: 'orange', icon: ICONS['solid:flask'], aliases: [], scope: 'vault' });
	// A built-in recoloured keeps its own title, icon (null) and aliases.
	assert.deepEqual(custom.note, { label: 'Note', color: 'teal', icon: null, aliases: [], scope: 'global' });
	// No title: the name, capitalised, as Obsidian titles one.
	assert.equal(custom.idea.label, 'Idea');
	assert.equal(custom.idea.color, null);
});

test('aliases: kept, never a type name, and a moved alias is said', () => {
	const { custom, problems } = resolve([{ name: 'remark', aliases: ['rem', 'note', 'hint'] }], []);
	assert.deepEqual(custom.remark.aliases, ['rem', 'hint']);
	assert.ok(problems.some((p) => /alias “note” is a callout type of its own/.test(p.reason) && !p.skipped));
	assert.ok(problems.some((p) => /alias “hint” was tip’s/.test(p.reason)));
	// A new type named like a built-in's alias takes the name.
	const taken = resolve([{ name: 'cite', color: 'red' }], []);
	assert.ok(taken.problems.some((p) => /“cite” was quote’s alias/.test(p.reason)));
	// A built-in overridden keeps its aliases, and gains new ones.
	assert.deepEqual(resolve([{ name: 'tip', aliases: ['protip'] }], []).custom.tip.aliases, ['hint', 'important', 'protip']);
});

test('a hostile vault file is refused cleanly, entry by entry', () => {
	const hostile = [
		null, 7, 'x', [], { name: '__proto__' }, { name: 'constructor', color: 'red' },
		{ name: 'x', color: 'red; background-image: url(https://evil.example/)' },
		{ name: 'y', icon: '"><script>alert(1)</script>' },
		{ name: 'z', title: '<img src=x onerror=alert(1)>', color: '#fff' },
		{ name: 'w'.repeat(5000) },
		{ name: 'v', aliases: 'not-a-list' },
		{ name: 'u', color: { toString: () => 'red' } },
	];
	const { custom, problems } = resolve([], hostile);
	assert.deepEqual(Object.keys(custom).sort(), ['constructor', 'u', 'v', 'w'.repeat(5000), 'z'].sort());
	assert.equal(Object.getPrototypeOf(custom), Object.prototype);
	assert.equal(custom.z.label, '<img src=x onerror=alert(1)>'); // escaped where it is drawn (below)
	assert.equal(custom.u.color, 'red'); // coerced, then checked as text
	assert.deepEqual(custom.v.aliases, []);
	const skipped = problems.filter((p) => p.skipped).map((p) => p.index);
	assert.deepEqual(skipped, [0, 1, 2, 3, 4, 6, 7]);
	// Not a list at all: one problem, nothing applied.
	const notList = resolve([], { name: 'x' });
	assert.deepEqual(notList.custom, {});
	assert.equal(notList.problems.length, 1);
});

// The engine side: what reaches the markup.
const render = (src) => {
	const token = calloutBlock.tokenizer.call({ lexer: {
		blockTokens: (text, out) => out, inline: (text, out) => { out.push({ type: 'text', text }); return out; },
	} }, src);
	return calloutBlock.renderer.call({ parser: {
		parseInline: (tokens) => tokens.map((t) => t.text).join(''), parse: () => '<p>body</p>',
	} }, token);
};

test('the engine draws a custom type: colour on the element, icon, escaped title', () => {
	const { custom } = resolve([], [
		{ name: 'remark', title: 'A <b>remark</b>', icon: 'flask', color: '#a1b2c3', aliases: ['rem'] },
		{ name: 'warning', color: 'hsl(30, 80%, 50%)' },
	]);
	const warningIcon = calloutIcon('warning');
	applyCustomCallouts(custom);
	try {
		assert.equal(resolveType('REM'), 'remark');
		assert.equal(CALLOUT_TYPES.remark.label, 'A <b>remark</b>');
		const html = render('> [!rem]\n> body\n');
		assert.match(html, /class="callout markdown-alert markdown-alert-remark callout-custom" data-callout="remark" style="--clew-callout-color: #a1b2c3"/);
		assert.match(html, /viewBox="0 0 448 512"[^>]*><path fill="currentColor" d="M1 2L3 4Z"/);
		// Through an alias, untitled: the type AS WRITTEN (jmarkdown a7de8c6);
		// the canonical name gets the definition's own title, escaped.
		assert.match(html, /<span class="callout-title-inner">Rem<\/span>/);
		assert.match(render('> [!remark]\n> body\n'), /A &lt;b&gt;remark&lt;\/b&gt;/);
		// A built-in recoloured keeps its own icon.
		assert.equal(calloutColor('warning'), 'hsl(30, 80%, 50%)');
		assert.equal(calloutIcon('warning'), warningIcon);
		assert.equal(resolveType('caution'), 'warning');
		assert.match(render('> [!warning]- T\n> b\n'), /<details class="[^"]*callout-custom is-collapsible" data-callout="warning" style="--clew-callout-color: hsl\(30, 80%, 50%\)">/);
	} finally {
		applyCustomCallouts({});
	}
	assert.equal(resolveType('rem'), null);
	assert.equal(calloutColor('warning'), null);
	assert.doesNotMatch(render('> [!note]\n> body\n'), /style=|callout-custom/);
});

test('the engine re-checks what it is handed', () => {
	applyCustomCallouts({
		bad: { label: 'Bad', color: 'red;x', icon: [512, 512, '"/><script>'] },
		'Not A Name': { label: 'x' },
	});
	try {
		assert.equal(calloutColor('bad'), null);
		assert.doesNotMatch(calloutIcon('bad'), /script/);
		assert.equal(resolveType('not a name'), null);
	} finally {
		applyCustomCallouts({});
	}
});
