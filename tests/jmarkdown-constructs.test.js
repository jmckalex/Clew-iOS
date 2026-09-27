// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * @file The scanner's `constructs` — the structured record live edit
 * conceals from. Every range is asserted as the TEXT it covers, which
 * is exact (an off-by-one shows as a wrong slice) and readable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';

import { scanJmarkdown } from '../vendor/clew/renderer/editor/jmd/jmarkdown-scan.js';

/** The constructs of `text`, with every range replaced by its slice. */
function sliced(text) {
	const cut = (r) => (r ? text.slice(r.start, r.end) : r);
	return scanJmarkdown(text).constructs.map((c) => {
		const out = {};
		for (const [key, value] of Object.entries(c)) {
			if (key === 'start' || key === 'end') continue;
			if (Array.isArray(value)) out[key] = value.map(cut);
			else if (value && typeof value === 'object') out[key] = cut(value);
			else out[key] = value;
		}
		out.text = text.slice(c.start, c.end);
		return out;
	});
}

function only(text, kind) {
	const found = sliced(text).filter((c) => c.kind === kind);
	assert.equal(found.length, 1, `one ${kind} in ${JSON.stringify(text)}; got ${found.length}`);
	return found[0];
}

test('an empty document has no constructs', () => {
	assert.deepEqual(scanJmarkdown('').constructs, []);
});

/* ── math ────────────────────────────────────────────────────────────── */

test('math: the four delimiter pairs, inline and display', () => {
	const cs = sliced('A $x^2$ and $$y$$ and \\(z\\) and \\[w\\].').filter((c) => c.kind === 'math');
	assert.deepEqual(cs.map((c) => [c.text, c.open, c.close, c.body, c.display]), [
		['$x^2$', '$', '$', 'x^2', false],
		['$$y$$', '$$', '$$', 'y', true],
		['\\(z\\)', '\\(', '\\)', 'z', false],
		['\\[w\\]', '\\[', '\\]', 'w', true],
	]);
});

test('math: a top-level environment is display, its body the whole environment', () => {
	const c = only('\\begin{align*}\na &= b\n\\end{align*}\n', 'math');
	assert.equal(c.env, 'align*');
	assert.equal(c.display, true);
	assert.equal(c.open, '\\begin{align*}');
	assert.equal(c.close, '\\end{align*}');
	assert.equal(c.body, c.text);
});

test('nothing is a construct inside code', () => {
	const text = 'Code `==no== [[No]] #no $x$` and\n\n```\n:::theorem\n[[No]]\n```\n';
	assert.deepEqual(sliced(text), []);
});

/* ── the metadata header ─────────────────────────────────────────────── */

test('metaHeader: fenced, with its body between the fences', () => {
	const c = only('---\ntitle: X\ntags: a\n---\n# Body\n', 'metaHeader');
	assert.equal(c.open, '---');
	assert.equal(c.close, '---');
	assert.equal(c.body, 'title: X\ntags: a');
	assert.equal(c.text, '---\ntitle: X\ntags: a\n---');
});

test('metaHeader: a legacy header has no opening fence', () => {
	const c = only('Title: X\nAuthor: Y\n---\nBody\n', 'metaHeader');
	assert.equal(c.open, null);
	assert.equal(c.close, '---');
	assert.equal(c.body, 'Title: X\nAuthor: Y');
});

test('metaHeader: no header, no construct', () => {
	assert.deepEqual(sliced('# Title: not a header\n'), []);
});

test('metaHeader: an unclosed fence runs to end of file', () => {
	const c = only('---\ntitle: X\n', 'metaHeader');
	assert.equal(c.close, null);
	assert.equal(c.body, 'title: X\n');
});

/* ── block directives and environments ───────────────────────────────── */

test('directiveBlock: name, content, attrs, body, closer', () => {
	const c = only(':::theorem[Pythagoras]{.important #pyth}\na^2 + b^2\n:::\n', 'directiveBlock');
	assert.deepEqual(
		[c.open, c.name, c.content, c.attrs, c.colons, c.body, c.close],
		[':::', 'theorem', 'Pythagoras', '.important #pyth', 3, 'a^2 + b^2', ':::']
	);
	assert.equal(c.text, ':::theorem[Pythagoras]{.important #pyth}\na^2 + b^2\n:::');
});

test('directiveBlock: nesting by colon count, outer before inner', () => {
	const text = '::::outer\n:::inner\nx\n:::\n::::\n';
	const cs = sliced(text).filter((c) => c.kind === 'directiveBlock');
	assert.deepEqual(cs.map((c) => [c.name, c.colons, c.body, c.close]), [
		['outer', 4, ':::inner\nx\n:::', '::::'],
		['inner', 3, 'x', ':::'],
	]);
});

test('directiveBlock: unclosed runs to end of file with close null', () => {
	const text = ':::abstract\nstill typing';
	const c = only(text, 'directiveBlock');
	assert.equal(c.close, null);
	assert.equal(c.body, 'still typing');
	assert.equal(c.text, text);
});

test('directiveBlock: the verbatim :::TiKZ / :::mermaid forms too', () => {
	const cs = sliced(':::TiKZ\n\\draw (0,0);\n:::\n\n:::mermaid\ngraph TD\n:::\n')
		.filter((c) => c.kind === 'directiveBlock');
	assert.deepEqual(cs.map((c) => [c.name, c.body, c.close]), [
		['TiKZ', '\\draw (0,0);', ':::'],
		['mermaid', 'graph TD', ':::'],
	]);
});

test('directiveBlock: an empty body is an empty range at the closer', () => {
	const c = only(':::note\n:::\n', 'directiveBlock');
	assert.equal(c.body, '');
});

test('environment: @begin/@end with a label and attrs', () => {
	const c = only('@begin(proof)[Sketch]{.short}\nTrivial.\n@end(proof)\n', 'environment');
	assert.deepEqual(
		[c.open, c.name, c.content, c.attrs, c.body, c.close],
		['@begin(proof)[Sketch]{.short}', 'proof', 'Sketch', '.short', 'Trivial.', '@end(proof)']
	);
});

test('environment: the verbatim TeX / mermaid / equation bodies', () => {
	const cs = sliced('@begin(equation)\nE = mc^2\n@end(equation)\n\n@begin(mermaid)\ngraph LR\n@end(mermaid)\n')
		.filter((c) => c.kind === 'environment');
	assert.deepEqual(cs.map((c) => [c.name, c.body, c.close]), [
		['equation', 'E = mc^2', '@end(equation)'],
		['mermaid', 'graph LR', '@end(mermaid)'],
	]);
});

test('environment: a sigil is not part of the name; unclosed → close null', () => {
	const c = only('@begin(.note)\nbody', 'environment');
	assert.equal(c.name, 'note');
	assert.equal(c.close, null);
	assert.equal(c.body, 'body');
});

test('html, script and style blocks', () => {
	const cs = sliced('<div class="x">\nhi\n</div>\n\n<script>\nlet a = 1;\n</script>\n\n<style>\np {}\n</style>\n');
	assert.deepEqual(cs.map((c) => [c.kind, c.text]), [
		['htmlBlock', '<div class="x">\nhi\n</div>'],
		['scriptBlock', '<script>\nlet a = 1;\n</script>'],
		['styleBlock', '<style>\np {}\n</style>'],
	]);
});

/* ── inline constructs ───────────────────────────────────────────────── */

test('italic: delimiters and body', () => {
	const c = only('Some /slanted words/ and more.', 'italic');
	assert.deepEqual([c.open, c.body, c.close], ['/', 'slanted words', '/']);
});

test('highlight: closed, and cut short by a blank line', () => {
	assert.deepEqual(
		(({ open, body, close }) => [open, body, close])(only('a ==marked== b', 'highlight')),
		['==', 'marked', '==']
	);
	const c = only('a ==runs on\n\nnext', 'highlight');
	assert.equal(c.close, null);
	assert.equal(c.body, 'runs on');
});

test('mustache', () => {
	const c = only('See {{TOC}} here.', 'mustache');
	assert.deepEqual([c.open, c.name, c.close], ['{{', 'TOC', '}}']);
});

test('wikilink: target, heading, alias', () => {
	const c = only('Go to [[Design Notes#Goals|the goals]].', 'wikilink');
	assert.deepEqual(
		[c.open, c.target, c.heading, c.blockId, c.alias, c.aliasText, c.close],
		['[[', 'Design Notes', 'Goals', null, 'the goals', 'the goals', ']]']
	);
});

test('wikilink: same-file heading and a block reference', () => {
	const [a, b] = sliced('[[#Setup]] and [[Note#^abc-1]]');
	assert.deepEqual([a.target, a.heading], [null, 'Setup']);
	assert.deepEqual([b.target, b.heading, b.blockId], ['Note', null, 'abc-1']);
});

test('embed: the bang is part of the opener', () => {
	const c = only('![[photo.png|320x60]]', 'embed');
	assert.deepEqual([c.open, c.target, c.alias, c.close], ['![[', 'photo.png', '320x60', ']]']);
});

test('tag: name without the hash; numbers are not tags', () => {
	const cs = sliced('A #project/alpha and #123.').filter((c) => c.kind === 'tag');
	assert.deepEqual(cs.map((c) => [c.text, c.name, c.open]), [['#project/alpha', 'project/alpha', null]]);
});

test('cite: command, notes, one range per key', () => {
	const c = only('As \\citep[see][p. 4]{knuth1984, lamport94} said.', 'cite');
	assert.deepEqual(
		[c.open, c.command, c.notes, c.keys, c.text],
		['\\citep', 'citep', ['see', 'p. 4'], ['knuth1984', 'lamport94'], '\\citep[see][p. 4]{knuth1984, lamport94}']
	);
});

test('footnote: anonymous, labelled, grouped', () => {
	const cs = sliced('A[fn: one] B[^n2: two] C[fn(end): three] D[^k(g): four]')
		.filter((c) => c.kind === 'footnote');
	assert.deepEqual(cs.map((c) => [c.open, c.label, c.group, c.body, c.close, c.multiline]), [
		['[fn:', null, null, ' one', ']', false],
		['[^n2:', 'n2', null, ' two', ']', false],
		['[fn(end):', null, 'end', ' three', ']', false],
		['[^k(g):', 'k', 'g', ' four', ']', false],
	]);
});

test('footnote: a body across paragraphs is multiline; an unclosed one is the opener alone', () => {
	const c = only('Text[fn: first\n\nsecond] after', 'footnote');
	assert.equal(c.multiline, true);
	assert.equal(c.body, ' first\n\nsecond');
	const open = only('Text[fn: still typing', 'footnote');
	assert.deepEqual([open.text, open.close, open.body], ['[fn:', null, null]);
});

test('directiveInline: single and double colon, content and attrs', () => {
	const cs = sliced('See :ref[fig1] and ::badge[New]{.hot} and :today.')
		.filter((c) => c.kind === 'directiveInline');
	assert.deepEqual(cs.map((c) => [c.open, c.name, c.content, c.attrs, c.block]), [
		[':ref', 'ref', 'fig1', null, false],
		['::badge', 'badge', 'New', '.hot', true],
		[':today', 'today', null, null, false],
	]);
});

test('directiveAt: inline and block forms, with the angle sigil', () => {
	const cs = sliced('An @kbd[Ctrl]{.k} key.\n\n@<figure>+[Caption]\n')
		.filter((c) => c.kind === 'directiveAt');
	assert.deepEqual(cs.map((c) => [c.open, c.name, c.content, c.attrs, c.block]), [
		['@kbd', 'kbd', 'Ctrl', '.k', false],
		['@<figure>+', 'figure', 'Caption', null, true],
	]);
});

/* ── agreement with the captures ─────────────────────────────────────── */

test('every construct delimiter sits on a painted capture (the demo vault)', () => {
	// The whole point of emitting constructs from the painting passes: a
	// delimiter live edit hides must be a span the overlay paints. Checked
	// over every note of the demo vault, which is the dialect's showcase.
	const root = new URL('../seed-vault/', import.meta.url);
	// Notes only: the vault's own `.clew/` state is not the showcase, and a
	// note-history folder is a DIRECTORY named like its note
	// (`.clew/history/Guide/Widgets.md/`), which read as a note is EISDIR —
	// found the first time this ran over a vault that had been used.
	const notes = readdirSync(root, { recursive: true })
		.filter((p) => /\.(md|jmd)$/.test(p) && !p.startsWith('.clew/') && statSync(new URL(p, root)).isFile());
	let total = 0;
	const kinds = new Set();
	for (const note of notes) {
		const text = readFileSync(new URL(note, root), 'utf8');
		const scan = scanJmarkdown(text);
		const painted = (pos) => scan.captures.some((c) => c.start <= pos && pos < c.end);
		for (const c of scan.constructs) {
			total += 1;
			kinds.add(c.kind);
			for (const r of [c.open, c.close]) {
				if (!r) continue;
				assert.ok(painted(r.start),
					`${note}: ${c.kind} delimiter ${JSON.stringify(text.slice(r.start, r.end))} unpainted`);
			}
		}
	}
	assert.ok(total > 200, `only ${total} constructs`);
	assert.ok(kinds.size >= 12, `only ${[...kinds]}`);
});
