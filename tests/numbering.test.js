// Cross-reference numbering (src/renderer/editor/live/numbering.js) — the
// mirror of the engine's post-processor. Parity with the engine itself is the
// smoke scenario's job (crossref-scenario.js); these pin the rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	numberDocument, refDisplay, typedRefText, commandForDepth, SECTIONING, CHAPTER_CLASSES, headText,
} from '../vendor/clew/renderer/editor/live/numbering.js';

const num = (text, options) => numberDocument(text, options);
const nbsp = ' ';

test('the ported sectioning tables equal the vendored engine’s', () => {
	const src = readFileSync(new URL('../vendor/jmarkdown/src/sectioning.js', import.meta.url), 'utf8');
	const list = (name) => JSON.parse(new RegExp(`const ${name} = (\\[[^\\]]*\\])`).exec(src)[1].replace(/'/g, '"'));
	assert.deepEqual(SECTIONING, list('SECTIONING'));
	assert.deepEqual(CHAPTER_CLASSES, list('CHAPTER_CLASSES'));
});

test('typed words come from the engine: equation parenthesised, capitalised form', () => {
	assert.equal(typedRefText('theorem', '3'), `theorem${nbsp}3`);
	assert.equal(typedRefText('equation', '2', true), `Equation${nbsp}(2)`);
	assert.equal(typedRefText('section', '2.1'), `section${nbsp}2.1`);
});

test('theorem kinds share ONE counter; proof is unnumbered', () => {
	const n = num('@begin(theorem)[Main]{#t}\nA\n@end(theorem)\n\n@begin(proof){#p}\nB\n@end(proof)\n\n@begin(lemma){#l}\nC\n@end(lemma)\n\n:::corollary{id=c}\nD\n:::\n');
	assert.deepEqual([n.labels.get('t').number, n.labels.get('l').number, n.labels.get('c').number], ['1', '2', '3']);
	assert.equal(n.labels.get('l').type, 'lemma');
	assert.equal(n.labels.get('p').status, 'numberless');
	assert.equal(refDisplay(n, 'l', 'cref').text, `lemma${nbsp}2`);
	assert.equal(refDisplay(n, 'c', 'Cref').text, `Corollary${nbsp}3`);
	assert.equal(headText(n.lines.get(1)), 'Theorem 1');
});

test('equations: @begin(equation) only; $$ is unnumbered; a label inside is not one', () => {
	const n = num('$$\nx\n$$\n\n@begin(equation){#a}\ny @label[inside]\n@end(equation)\n\n\\[z\\]\n\n@begin(equation){id=eq:b}\nw\n@end(equation)\n');
	assert.deepEqual([n.labels.get('a').number, n.labels.get('eq:b').number], ['1', '2']);
	assert.equal(n.labels.has('inside'), false);
	assert.equal(refDisplay(n, 'eq:b', 'ref').text, '2', '@ref is the bare number, as the engine prints it');
	assert.equal(refDisplay(n, 'eq:b', 'cref').text, `equation${nbsp}(2)`);
});

test('figures with subfigures, tables and listings each count alone', () => {
	const n = num('@begin(figure)[One]{#f1}\n@begin(subfigure)[a]{#s1}\nx\n@end(subfigure)\n@begin(subfigure)[b]{#s2}\ny\n@end(subfigure)\n@end(figure)\n\n@begin(table)[T]{#t1}\n| a |\n@end(table)\n\n@begin(figure)[Two]{#f2}\nz\n@end(figure)\n\n@begin(listing)[L]{#l1}\ncode\n@end(listing)\n');
	assert.deepEqual(['f1', 's1', 's2', 't1', 'f2', 'l1'].map((k) => n.labels.get(k).number), ['1', '1a', '1b', '1', '2', '1']);
	assert.equal(n.labels.get('s2').type, 'figure');
});

test('headings: numbered only under Headings: numeric, h1 included', () => {
	const on = num('---\nHeadings: numeric\n---\n# Doc\n\n## Setup @label[sec]\n\n### Deep\n\n## Next\n');
	assert.equal(on.headingsNumeric, true);
	assert.deepEqual([...on.lines.values()].map((l) => l.number), ['1', '1.1', '1.1.1', '1.2']);
	assert.equal(refDisplay(on, 'sec', 'ref').text, '1.1');
	assert.equal(refDisplay(on, 'sec', 'cref').text, `subsection${nbsp}1.1`, 'depth 2 in an article is a subsection');
	const off = num('# Doc\n\n## Setup @label[sec]\n');
	assert.equal(refDisplay(off, 'sec', 'ref').text, '??');
	assert.equal(refDisplay(off, 'sec', 'ref').state, 'numberless');
	assert.equal(commandForDepth(1, { documentClass: 'book' }), 'chapter');
});

test('a plain label has no number, nor a footnote label (as the engine behaves); a label in a theorem its number', () => {
	const n = num('Loose @label[loose].\n\nA note[fn: see @label[fnl]] and another[fn: two].\n\n@begin(theorem)\nBody @label[inthm]\n@end(theorem)\n');
	assert.equal(refDisplay(n, 'loose', 'ref').text, '??');
	assert.equal(refDisplay(n, 'fnl', 'ref').text, '??', 'measured: the engine prints ?? for a footnote label');
	assert.match(refDisplay(n, 'fnl', 'ref').tip, /footnote/);
	assert.equal(n.labels.get('inthm').number, '1');
	assert.equal(n.labels.get('inthm').type, 'theorem');
});

test('unknown keys, duplicates, undeclared and declared custom environments', () => {
	const doc = '@begin(exercise){#e1}\nx\n@end(exercise)\n\nA @label[d] B @label[d]\n';
	const n = num(doc);
	assert.equal(refDisplay(n, 'nowhere', 'ref').state, 'missing');
	assert.equal(refDisplay(n, 'e1', 'ref').text, '?');
	assert.equal(n.labels.get('d').count, 2);
	const declared = num(doc, { numbered: new Map([['exercise', { counter: 'exercise', type: 'exercise', title: 'Exercise' }]]) });
	assert.equal(refDisplay(declared, 'e1', 'ref').text, '1');
	assert.equal(headText(declared.lines.get(1)), 'Exercise 1');
});

test('fences and code hide everything', () => {
	const n = num('```md\n@begin(theorem){#hidden}\n@end(theorem)\n```\n\n`@label[x]`\n');
	assert.equal(n.labels.size, 0);
});
