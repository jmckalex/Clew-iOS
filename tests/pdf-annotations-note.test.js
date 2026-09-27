// PDF annotations → note (src/shared/pdf-annotations-note.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotationsNote, annotationsNotePath, blockIdFor } from '../vendor/clew/shared/pdf-annotations-note.js';

const A = [
	{ id: 'a1', page: 1, kind: 'highlight', text: 'The first highlight.' },
	{ id: 'a2', page: 1, kind: 'highlight', text: 'The second.', contents: 'My comment.' },
	{ id: 'n1', page: 2, kind: 'note', contents: 'A sticky note.' },
];

test('the note beside the PDF, per page, one quote block per annotation', () => {
	assert.equal(annotationsNotePath('Papers/paper.pdf'), 'Papers/paper — Annotations.md');
	const { text, added } = annotationsNote('Papers/paper.pdf', A, null, { date: '2026-09-27' });
	assert.equal(added, 3);
	assert.equal(text, `---
source: "[[paper.pdf]]"
extracted: 2026-09-27
---
# paper — Annotations

## Page 1

> The first highlight.
>
> [[paper.pdf#page=1|p. 1]] ^pdf-a1

> The second.
>
> My comment.
>
> [[paper.pdf#page=1|p. 1]] ^pdf-a2

## Page 2

> A sticky note.
>
> [[paper.pdf#page=2|p. 2]] ^pdf-n1
`);
});

test('re-running changes nothing; a new one lands under its page; nothing is deleted', () => {
	const first = annotationsNote('paper.pdf', A, null, { date: '2026-09-27' }).text;
	const edited = first.replace('## Page 2', 'My own thoughts.\n\n## Page 2');
	const again = annotationsNote('paper.pdf', A, edited);
	assert.equal(again.added, 0);
	assert.equal(again.text, edited, 'byte-identical');
	const more = annotationsNote('paper.pdf', [...A.slice(1), { id: 'a3', page: 1, kind: 'underline', text: 'Third.' }, { id: 'p5', page: 5, kind: 'highlight', text: 'Late.' }], edited);
	assert.equal(more.added, 2);
	assert.ok(more.text.includes('^pdf-a1'), 'a1 is gone from the PDF but stays in the note');
	assert.ok(more.text.indexOf('^pdf-a3') < more.text.indexOf('## Page 2'), 'under page 1');
	assert.ok(more.text.indexOf('My own thoughts.') < more.text.indexOf('^pdf-a3') || more.text.indexOf('^pdf-a3') < more.text.indexOf('## Page 2'));
	assert.ok(more.text.trimEnd().endsWith('^pdf-p5'), 'page 5 at the end');
	assert.ok(more.text.indexOf('## Page 5') > more.text.indexOf('## Page 2'));
});

test('a page heading is created in page order; ids are made legal; no text is named', () => {
	const base = annotationsNote('p.pdf', [{ id: 'x', page: 3, kind: 'highlight', text: 'three' }], null).text;
	const merged = annotationsNote('p.pdf', [{ id: 'y', page: 2, kind: 'highlight', text: 'two' }], base).text;
	assert.ok(merged.indexOf('## Page 2') < merged.indexOf('## Page 3'));
	assert.equal(blockIdFor('{A:1}'), 'pdf--A-1-');
	assert.ok(annotationsNote('p.pdf', [{ id: 'i', page: 1, kind: 'ink' }], null).text.includes('(ink — text not available)'));
});
