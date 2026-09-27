// Fence highlighting's pure half (src/renderer/editor/code-tokens.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightRanges } from '../vendor/clew/renderer/editor/code-tokens.js';

const tokens = (code, lang) => highlightRanges(code, lang).map(([a, b, cls]) => `${cls}:${code.slice(a, b)}`);

test('javascript: keywords, numbers, strings, comments, function names', () => {
	const t = tokens('let i = 10; // count\nfunction foo() { return "x<y"; }', 'javascript');
	for (const want of ['jmd-keyword:let', 'jmd-number:10', 'jmd-comment:// count', 'jmd-keyword:function', 'jmd-function:foo', 'jmd-keyword:return', 'jmd-string:"x<y"']) {
		assert.ok(t.includes(want), `${want} in ${JSON.stringify(t)}`);
	}
});

test('ranges index the original text (entities decoded), aliases work', () => {
	const code = 'if (a < b && c > "d") {}';
	const r = highlightRanges(code, 'js');
	assert.ok(r.every(([a, b]) => a >= 0 && b <= code.length && a < b));
	assert.ok(tokens(code, 'js').includes('jmd-string:"d"'));
	assert.ok(tokens('def f(x):\n    return x', 'python').includes('jmd-keyword:def'));
});

test('an unknown language is nothing', () => {
	assert.deepEqual(highlightRanges('x', 'no-such-language'), []);
});
