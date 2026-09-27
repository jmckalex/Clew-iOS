// Label completion (src/renderer/editor/complete/crossrefs.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refPrefix, labelOptions } from '../vendor/clew/renderer/editor/complete/crossrefs.js';
import { numberDocument } from '../vendor/clew/renderer/editor/live/numbering.js';

test('the six spellings open it; @label and mid-word do not', () => {
	for (const form of ['ref', 'cref', 'Cref']) {
		assert.equal(refPrefix(`See @${form}[`), '');
		assert.equal(refPrefix(`See :${form}[th`), 'th');
	}
	assert.equal(refPrefix('@label['), null);
	assert.equal(refPrefix('email@ref['), null);
	assert.equal(refPrefix('@ref[done] and'), null);
});

test('options carry the engine number and title, ranked by the query', () => {
	const n = numberDocument('@begin(theorem)[Main]{#thm-main}\nx\n@end(theorem)\n\n@begin(equation){#eq-a}\ny\n@end(equation)\n\nLoose @label[loose].\n');
	const all = labelOptions(n, '');
	assert.deepEqual(all.map((o) => o.label), ['thm-main', 'eq-a', 'loose']);
	assert.equal(all[0].detail, 'theorem 1 — Main');
	assert.equal(all[1].detail, 'equation (1)');
	assert.equal(all[2].detail, 'no number');
	const ranked = labelOptions(n, 'eq').sort((a, b) => b.boost - a.boost);
	assert.equal(ranked[0].label, 'eq-a');
});
