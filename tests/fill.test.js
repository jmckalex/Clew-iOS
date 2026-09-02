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
import {
	inertMap, tokenize, fillWords, paragraphAt, fillLineRange, autoBreakLine,
} from '../vendor/clew/renderer/editor/fill.js';

const lines = (s) => s.split('\n');

// A paragraph's words survive any fill: joining the output back with spaces
// and stripping prefixes must reproduce the input words exactly.
function wordsOf(ls, prefixFirst, prefixRest) {
	return ls
		.map((l, i) => l.slice((i === 0 ? prefixFirst : prefixRest).length))
		.join(' ')
		.split(/\s+/)
		.filter(Boolean);
}

test('tokenize keeps wikilinks, code, math, and cite commands whole', () => {
	assert.deepEqual(
		tokenize('see [[Note Headers]] and ![[img.png|300]] now'),
		['see', '[[Note Headers]]', 'and', '![[img.png|300]]', 'now']);
	assert.deepEqual(
		tokenize('a `let x = 1` span and $y + z$ math'),
		['a', '`let x = 1`', 'span', 'and', '$y + z$', 'math']);
	assert.deepEqual(
		tokenize('per \\citep[p. 17]{maynardsmith1973} today'),
		['per', '\\citep[p. 17]{maynardsmith1973}', 'today']);
	assert.deepEqual(
		tokenize('a [link text](https://x.y/z) here'),
		['a', '[link text](https://x.y/z)', 'here']);
	// Punctuation glued to an atom stays glued to it.
	assert.deepEqual(tokenize('([[A B]]).'), ['([[A B]]).']);
});

test('tokenize does not let a lone dollar swallow the paragraph', () => {
	assert.deepEqual(tokenize('costs $5 today'), ['costs', '$5', 'today']);
	// "$5 today $" — closing $ preceded by a space is not math.
	assert.deepEqual(tokenize('give $5 now $ later'), ['give', '$5', 'now', '$', 'later']);
});

test('fillWords wraps at the column with prefixes', () => {
	const out = fillWords(['one', 'two', 'three', 'four'], 12, '', '');
	assert.deepEqual(out, ['one two', 'three four']);
	const quoted = fillWords(['one', 'two', 'three'], 12, '> ', '> ');
	assert.deepEqual(quoted, ['> one two', '> three']);
	const list = fillWords(['alpha', 'beta', 'gamma'], 12, '- ', '  ');
	assert.deepEqual(list, ['- alpha beta', '  gamma']);
});

test('fillWords never opens a line with a would-be list marker', () => {
	// Breaking before "-" would create "- 4 kg", a list item.
	const out = fillWords('it weighs 3 - 4 kg or so'.split(' '), 12, '', '');
	for (const line of out.slice(0)) assert.ok(!/^[-*+] /.test(line), line);
	assert.equal(out.join(' ').replace(/\s+/g, ' '), 'it weighs 3 - 4 kg or so');
});

test('a long word overflows rather than breaking', () => {
	const out = fillWords(['short', '[[A Very Long Wikilink Name]]'], 10, '', '');
	assert.deepEqual(out, ['short', '[[A Very Long Wikilink Name]]']);
});

test('inertMap covers frontmatter, fences, and $$ math', () => {
	const doc = lines('---\ntitle: x\n---\nprose\n```js\ncode here\n```\nmore\n$$\nx^2\n$$\ntail');
	const inert = inertMap(doc);
	assert.deepEqual(inert, [
		true, true, true,      // frontmatter
		false,
		true, true, true,      // fence
		false,
		true, true, true,      // math
		false,
	]);
});

test('paragraphAt finds the whole paragraph and stops at structure', () => {
	const doc = lines('# Head\nfirst line\nsecond line\n\nnext para');
	const para = paragraphAt(doc, inertMap(doc), 2);
	assert.equal(para.from, 1);
	assert.equal(para.to, 2);
	assert.deepEqual(para.words, ['first', 'line', 'second', 'line']);
	// The heading itself is not fillable.
	assert.equal(paragraphAt(doc, inertMap(doc), 0), null);
});

test('paragraphAt treats each list item as its own paragraph', () => {
	const doc = lines('- first item wraps\n  onto this line\n- second item');
	const inert = inertMap(doc);
	const first = paragraphAt(doc, inert, 1);
	assert.equal(first.from, 0);
	assert.equal(first.to, 1);
	assert.equal(first.prefixFirst, '- ');
	assert.equal(first.prefixRest, '  ');
	const second = paragraphAt(doc, inert, 2);
	assert.equal(second.from, 2);
	assert.equal(second.to, 2);
});

test('paragraphAt carries quote prefixes and separates callout headers', () => {
	const doc = lines('> [!note]\n> quoted prose that\n> continues here\nplain');
	const inert = inertMap(doc);
	const para = paragraphAt(doc, inert, 1);
	assert.equal(para.from, 1);
	assert.equal(para.to, 2);   // stops before the unquoted line
	assert.equal(para.prefixFirst, '> ');
	assert.equal(paragraphAt(doc, inert, 0), null);   // the [!note] header
});

test('paragraphAt refuses indented code and block-id lines', () => {
	const doc = lines('para\n\n    indented code\n\n^anchor-1');
	const inert = inertMap(doc);
	assert.equal(paragraphAt(doc, inert, 2), null);
	assert.equal(paragraphAt(doc, inert, 4), null);
});

test('fillLineRange fills a long paragraph and reports no-ops as empty', () => {
	const doc = lines('This is a rather long single line of prose that certainly exceeds the fill column in use.');
	const [r] = fillLineRange(doc, 0, 0, 40);
	assert.ok(r.lines.length > 1);
	for (const l of r.lines) assert.ok(l.length <= 40, l);
	assert.deepEqual(wordsOf(r.lines, '', ''), doc[0].split(' '));
	// Already-filled text is left alone.
	assert.deepEqual(fillLineRange(r.lines, 0, r.lines.length - 1, 40), []);
});

test('fillLineRange joins short lines back up to the column', () => {
	const doc = lines('one\ntwo\nthree\nfour');
	const [r] = fillLineRange(doc, 0, 3, 40);
	assert.deepEqual(r.lines, ['one two three four']);
});

test('fillLineRange over a selection fills each paragraph independently', () => {
	const doc = lines('alpha beta gamma delta epsilon zeta eta\n\n- item one which is also long enough to wrap\n\n```\nnever touch code\n```');
	const repls = fillLineRange(doc, 0, doc.length - 1, 20);
	assert.equal(repls.length, 2);
	assert.equal(repls[1].from, 2);
	for (const l of repls[1].lines.slice(1)) assert.ok(l.startsWith('  '), l);
	// The fence body is untouched by construction: no replacement covers it.
	for (const r of repls) assert.ok(r.to < 4);
});

test('centered text (>> … <<) is its own paragraph with both delimiters', () => {
	const doc = lines('plain before\n>> a centered block long enough that it wraps <<\n>> and a second centered line <<\n> a real quote');
	const inert = inertMap(doc);
	const para = paragraphAt(doc, inert, 1);
	assert.equal(para.from, 1);
	assert.equal(para.to, 2);        // joins centered lines only
	assert.equal(para.prefixFirst, '>> ');
	assert.equal(para.suffix, ' <<');
	assert.ok(!para.words.includes('<<') && !para.words.includes('>>'), para.words.join('|'));
	// The plain line and the real quote stay separate paragraphs.
	assert.equal(paragraphAt(doc, inert, 0).to, 0);
	assert.equal(paragraphAt(doc, inert, 3).from, 3);
});

test('fillLineRange keeps << on every centered line, within the column', () => {
	const doc = lines('>> a centered block long enough that it certainly wraps at forty <<');
	const [r] = fillLineRange(doc, 0, 0, 40);
	assert.ok(r.lines.length > 1);
	for (const l of r.lines) {
		assert.match(l, /^>> .*<<$/);
		assert.ok(l.length <= 40, l);
	}
	// Refilling the result is a no-op.
	assert.deepEqual(fillLineRange(r.lines, 0, r.lines.length - 1, 40), []);
});

test('auto-break of a centered head closes each completed line', () => {
	// The handler's composition: budget = column - width(' <<'), suffix
	// appended to every piece but the one still being typed.
	const head = '>> a centered block long enough that it wraps ';
	const broken = autoBreakLine(head, 40 - 3, '>> ', 3);
	assert.ok(broken.length > 1);
	for (let k = 0; k < broken.length - 1; k++) broken[k] += ' <<';
	for (const l of broken.slice(0, -1)) {
		assert.match(l, /^>> .*<<$/);
		assert.ok(l.length <= 40, l);
	}
	assert.ok(broken.at(-1).startsWith('>> '));
	assert.ok(broken.at(-1).endsWith(' '));   // the typed space survives
});

test('autoBreakLine breaks behind the cursor and carries the prefix', () => {
	// Trailing space = the just-typed one; it must survive on the last line.
	const out = autoBreakLine('aaa bbb ccc dddddd ', 11, '', 0);
	assert.deepEqual(out, ['aaa bbb ccc', 'dddddd ']);
	const quoted = autoBreakLine('> alpha beta gamma ', 12, '> ', 2);
	assert.deepEqual(quoted, ['> alpha beta', '> gamma ']);
});

test('autoBreakLine breaks repeatedly when far past the column', () => {
	const out = autoBreakLine('one two three four five six seven ', 9, '', 0);
	for (const l of out.slice(0, -1)) assert.ok(l.length <= 9, l);
	assert.equal(out.join(' ').replace(/ +/g, ' '), 'one two three four five six seven ');
});

test('autoBreakLine preserves inner spacing except at the break', () => {
	const out = autoBreakLine('one  two.  Three four ', 12, '', 0);
	assert.deepEqual(out, ['one  two.', 'Three four ']);
});

test('autoBreakLine never breaks inside an atom or before a marker word', () => {
	const wiki = autoBreakLine('see [[A Long Note Name]] end ', 12, '', 0);
	assert.ok(wiki.some((l) => l.includes('[[A Long Note Name]]')), wiki.join('|'));
	// "3 - 4": the "-" may not open a line.
	const dash = autoBreakLine('it weighs 3 - 4 kg ', 12, '', 0);
	for (const l of dash.slice(1)) assert.ok(!/^- /.test(l), l);
});

test('autoBreakLine respects minIndex and gives up without a break point', () => {
	// The list marker itself is never a break site.
	const list = autoBreakLine('- aaa bbb ccc ', 6, '  ', 2);
	assert.equal(list[0], '- aaa');
	assert.deepEqual(list.slice(1), ['  bbb', '  ccc ']);
	// One unbreakable word: length 1, caller inserts normally.
	assert.equal(autoBreakLine('supercalifragilistic ', 10, '', 0).length, 1);
});

test('quoted list items refill with the quote and hanging indent', () => {
	const doc = lines('> - a quoted list item long enough that it must wrap somewhere');
	const [r] = fillLineRange(doc, 0, 0, 30);
	assert.ok(r.lines.length > 1);
	assert.ok(r.lines[0].startsWith('> - '));
	for (const l of r.lines.slice(1)) assert.ok(l.startsWith('>   '), l);
});
