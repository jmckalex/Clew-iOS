// The live preview pane's targets (src/renderer/editor/preview-target.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { noteMarkdown } from '../vendor/clew/renderer/editor/jmd/markdown-config.js';
import { previewTargetAt, sameTarget } from '../vendor/clew/renderer/editor/preview-target.js';

function at(doc, needle, offset = 0, config = {}) {
	const state = EditorState.create({ doc, extensions: [noteMarkdown(config)] });
	ensureSyntaxTree(state, state.doc.length, 5000);
	const i = doc.indexOf(needle);
	assert.ok(i !== -1, needle);
	return previewTargetAt(state, i + offset);
}

test('inline math, both delimiters, and its boundaries', () => {
	const doc = 'Text $a^2$ and \\(b\\) end.';
	const t = at(doc, '$a');
	assert.deepEqual([t.kind, t.tex, doc.slice(t.from, t.to)], ['math-inline', 'a^2', '$a^2$']);
	assert.equal(at(doc, '$a', 5).kind, 'math-inline', 'right after the closing $');
	assert.equal(at(doc, '\\(b').tex, 'b');
	assert.equal(at(doc, 'Text'), null);
	assert.equal(at(doc, 'end'), null);
});

test('display math: $$, \\[ \\], a top-level environment, @begin(align)', () => {
	const doc = 'P\n\n$$\nx = 1\n$$\n\n\\[y\\]\n\n\\begin{align}\na &= b\n\\end{align}\n\n@begin(align)\nc &= d\n@end(align)\n';
	const t = at(doc, '$$');
	assert.deepEqual([t.kind, t.tex.trim()], ['math-display', 'x = 1']);
	assert.equal(at(doc, '$$', 2).kind, 'math-display', 'the cursor right after the opening $$');
	assert.equal(at(doc, '\\[y').tex, 'y');
	const env = at(doc, 'a &=');
	assert.equal(env.kind, 'math-display');
	assert.ok(env.tex.startsWith('\\begin{align}') && env.tex.includes('a &= b'));
	const begin = at(doc, 'c &=');
	assert.equal(begin.tex, '\\begin{align}\nc &= d\n\\end{align}');
});

test('@begin(equation) is an unnumbered display: the "(n)" is Clew\'s, as the engine\'s HTML is', () => {
	// Wrapped in \begin{equation}, MathJax (tags: 'ams') numbered it as well,
	// from its own count — "(1)(1)" in live edit (mathEnvironmentTex).
	const doc = 'P\n\n@begin(equation){#eq-e}\ne^{i\\pi} + 1 = 0\n@end(equation)\n';
	const t = at(doc, 'e^{');
	assert.equal(t.kind, 'math-display');
	assert.equal(t.tex, 'e^{i\\pi} + 1 = 0');
	assert.ok(!/\\begin\{equation\}/.test(t.tex));
});

test('fences: previewed languages only, closed only, from the first character', () => {
	const doc = 'P\n\n```mermaid\ngraph TD\n  A --> B\n```\n\n```js\nx\n```\n\n```tikz\n\\draw (0,0);\n```\n\n```query\ntable: a\n```\n';
	const m = at(doc, '```mermaid');
	assert.deepEqual([m.kind, m.lang, m.pause], ['fence', 'mermaid', 400]);
	assert.equal(m.text, '```mermaid\ngraph TD\n  A --> B\n```');
	assert.equal(at(doc, 'A --> B').lang, 'mermaid');
	assert.deepEqual([at(doc, '\\draw').lang, at(doc, '\\draw').pause], ['tikz', 700]);
	assert.equal(at(doc, 'x\n```'), null, 'js');
	assert.equal(at(doc, 'table: a'), null, 'a query is never previewed');
	assert.equal(at('```mermaid\ngraph TD\n', 'graph'), null, 'unclosed');
});

test('directives and environments', () => {
	const doc = 'P\n\n:::TiKZ\n\\draw (0,0) -- (1,1);\n:::\n\n@begin(mermaid)\ngraph LR\n  X --> Y\n@end(mermaid)\n\n:::theorem\nNot previewed.\n:::\n';
	const d = at(doc, '\\draw');
	assert.deepEqual([d.kind, d.lang], ['directive', 'TiKZ']);
	assert.ok(d.text.startsWith(':::TiKZ') && d.text.endsWith(':::'));
	const e = at(doc, 'X --> Y');
	assert.deepEqual([e.kind, e.lang, e.pause], ['environment', 'mermaid', 400]);
	assert.equal(at(doc, 'Not previewed'), null);
});

test('nothing complete, nothing literal', () => {
	assert.equal(at('Open $$\nx = 1\n\nmore', 'x ='), null, 'an unclosed $$');
	assert.equal(at('Code `$x$` here', 'x$'), null, 'a $ inside a code span');
	assert.equal(at('```js\nlet a = $b$;\n```\n', 'b$'), null, 'maths inside a code fence');
});

test('normalSyntax does not change the targets', () => {
	const doc = 'Text $a^2$ and\n\n```mermaid\ngraph TD\n```\n';
	for (const needle of ['$a', 'graph']) {
		assert.deepEqual(at(doc, needle, 0, { normalSyntax: true }), at(doc, needle));
	}
});

test('sameTarget: the same construct while its text changes', () => {
	const a = at('X $a$ Y', '$a');
	const b = at('X $ab$ Y', '$ab');
	assert.ok(sameTarget(a, b));
	assert.ok(!sameTarget(a, null));
});
