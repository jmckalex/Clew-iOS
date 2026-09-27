// The `//` menu's pure half (src/renderer/editor/complete/slash-spec.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slashQuery, slashItems } from '../vendor/clew/renderer/editor/complete/slash-spec.js';
import { FORMAT_MENU, CELL_SAFE_COMMANDS } from '../vendor/clew/shared/format-spec.js';

test('// at a line start or after whitespace opens the menu', () => {
	assert.deepEqual(slashQuery('//'), { query: '', slashes: 0 });
	assert.deepEqual(slashQuery('Some text //'), { query: '', slashes: 10 });
	assert.deepEqual(slashQuery('\t//head'), { query: 'head', slashes: 1 });
	assert.deepEqual(slashQuery('- //task'), { query: 'task', slashes: 2 });
});

test('the query may run to several words', () => {
	assert.deepEqual(slashQuery('//heading 2'), { query: 'heading 2', slashes: 0 });
	assert.deepEqual(slashQuery('//insert table (2×2'), { query: 'insert table (2×2', slashes: 0 });
	assert.deepEqual(slashQuery('//heading '), { query: 'heading ', slashes: 0 });
});

test('// that is not a request stays text', () => {
	assert.equal(slashQuery('https://'), null, 'a URL');
	assert.equal(slashQuery('see https://example'), null);
	assert.equal(slashQuery('a//b'), null, 'mid-word');
	assert.equal(slashQuery('///'), null, 'three slashes');
	assert.equal(slashQuery('// comment'), null, 'a space after the slashes');
	assert.equal(slashQuery('//heading  2'), null, 'two spaces end it');
	assert.equal(slashQuery('/italic'), null, 'the dialect’s italic');
});

test('the menu is the Format menu, in its order, with the syntax as detail', () => {
	const items = slashItems();
	const ids = items.map((i) => i.id);
	const menuIds = FORMAT_MENU.flatMap((g) => g.items.filter((i) => i.id).map((i) => i.id))
		.filter((id) => id !== 'format:table-row');
	assert.deepEqual(ids.filter((id) => menuIds.includes(id)), menuIds);
	assert.ok(ids.includes('format:insert-link'));
	const strong = items.find((i) => i.id === 'edit:format-strong');
	assert.deepEqual([strong.label, strong.detail, strong.section], ['Strong', '*text*', 'Text Style']);
	const ranks = items.map((i) => i.rank);
	assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'sections in menu order');
});

test('normalSyntax hides the dialect-only styles and relabels', () => {
	const items = slashItems({ normalSyntax: true });
	const ids = new Set(items.map((i) => i.id));
	for (const id of ['edit:format-intense', 'format:underline', 'edit:format-highlight']) assert.ok(!ids.has(id), id);
	const strong = items.find((i) => i.id === 'edit:format-strong');
	assert.deepEqual([strong.label, strong.detail], ['Bold', '**text**']);
});

test('in a table cell only inline items are offered', () => {
	const items = slashItems({ inCell: true });
	assert.ok(items.length > 0);
	for (const item of items) assert.ok(CELL_SAFE_COMMANDS.has(item.id), item.id);
	assert.ok(!items.some((i) => i.id.startsWith('format:heading')));
});
