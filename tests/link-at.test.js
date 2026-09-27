// Link hover previews' pure half (src/renderer/editor/link-at.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkAt, parseTarget, previewSpec } from '../vendor/clew/renderer/editor/link-at.js';

const at = (line, needle) => linkAt(line, line.indexOf(needle));

test('wikilinks: target, alias, heading, block id, embed', () => {
	const l = at('See [[Note]] here', 'Note');
	assert.deepEqual([l.kind, l.target, l.heading, l.from, l.to], ['wikilink', 'Note', '', 4, 12]);
	assert.deepEqual([at('[[Note|Shown]]', 'Shown').target, at('[[Note|Shown]]', 'Shown').alias], ['Note', 'Shown']);
	assert.equal(at('[[Note#Part two]]', 'Part').heading, 'Part two');
	assert.equal(at('[[Note#^abc123]]', 'abc').heading, '^abc123');
	assert.equal(at('![[Pic.png]]', 'Pic').embed, true);
	assert.equal(at('[[a.pdf|external]]', 'a.pdf').external, true);
});

test('both ends count; outside does not', () => {
	const line = 'x [[Note]] y';
	assert.equal(linkAt(line, 2)?.target, 'Note');
	assert.equal(linkAt(line, 10)?.target, 'Note', 'the position just after ]]');
	assert.equal(linkAt(line, 0), null);
	assert.equal(linkAt(line, 12), null);
});

test('markdown links', () => {
	const l = at('a [text](Note.md) b', 'text');
	assert.deepEqual([l.kind, l.url, l.text], ['markdown', 'Note.md', 'text']);
	assert.equal(at('[go](https://example.com/x)', 'go').url, 'https://example.com/x');
	assert.equal(at('[s](<My Note.md>)', 's').url, 'My Note.md');
	assert.equal(at('[t](#heading "Title")', 't').url, '#heading');
});

test('inside a code span a link is text', () => {
	assert.equal(at('`[[Note]]` and', 'Note'), null);
	assert.equal(at('``a `[[Note]]` b``', 'Note'), null);
	assert.equal(at('`code` then [[Note]]', 'Note').target, 'Note');
});

test('reading mode targets parse like wikilinks', () => {
	assert.deepEqual([parseTarget('Note#H').target, parseTarget('Note#H').heading], ['Note', 'H']);
	assert.deepEqual([parseTarget('#^id').target, parseTarget('#^id').heading], ['', '^id']);
});

const resolve = {
	note: (n) => ({ note: 'Folder/Note.md', welcome: 'Welcome.md' })[n.toLowerCase()] ?? null,
	file: (n) => ({ 'pic.png': 'Attachments/pic.png', 'doc.pdf': 'Docs/doc.pdf' })[n.toLowerCase()] ?? null,
	current: 'Here.md',
};
const spec = (line, needle) => previewSpec(at(line, needle), resolve);

test('a note previews through the block path, bare, sectioned', () => {
	assert.deepEqual(spec('[[Note]]', 'Note'), { kind: 'block', path: 'Folder/Note.md', text: '![[Folder/Note|bare]]', label: 'Note' });
	assert.equal(spec('[[Note#Part]]', 'Note').text, '![[Folder/Note#Part|bare]]');
	assert.equal(spec('[[Note#^b1]]', 'Note').text, '![[Folder/Note#^b1|bare]]');
	assert.equal(spec('[[#Local]]', 'Local').text, '![[Here#Local|bare]]', 'same note');
	assert.equal(spec('[x](Note.md#Part)', 'x').text, '![[Folder/Note#Part|bare]]');
	assert.equal(spec('[x](#Local)', 'x').text, '![[Here#Local|bare]]');
});

test('files: images plain, the rest embedded', () => {
	assert.deepEqual(spec('![[pic.png]]', 'pic'), { kind: 'image', path: 'Attachments/pic.png', label: 'pic.png' });
	assert.deepEqual(spec('[[doc.pdf]]', 'doc'), { kind: 'block', path: 'Docs/doc.pdf', text: '![[Docs/doc.pdf]]', label: 'doc.pdf' });
});

test('refused: unresolved by name; URLs, mailto and |external not at all', () => {
	assert.deepEqual(spec('[[Nowhere]]', 'Nowhere'), { kind: 'unresolved', name: 'Nowhere', label: 'Nowhere' });
	assert.equal(spec('[[missing.pdf]]', 'missing').kind, 'unresolved');
	assert.equal(spec('[[doc.pdf|external]]', 'doc'), null);
	assert.equal(spec('[go](https://example.com)', 'go'), null);
	assert.equal(spec('[me](mailto:a@b.c)', 'me'), null);
	assert.equal(previewSpec(null, resolve), null);
});

test('references: the four spellings, @ and :, and what they preview', () => {
	for (const form of ['ref', 'cref', 'Cref']) {
		for (const sigil of ['@', ':']) {
			const l = at(`See ${sigil}${form}[thm-a] here`, 'thm');
			assert.deepEqual([l.kind, l.form, l.key], ['xref', form, 'thm-a']);
		}
	}
	assert.equal(at('an email@ref[x]', 'x]'), null, 'not after a word');
	assert.equal(at('`@ref[x]`', 'x]'), null, 'inside code');
	const withLabel = { ...resolve, label: (key) => (key === 'thm-a' ? { text: 'SRC', label: 'Theorem 1' } : null) };
	assert.deepEqual(previewSpec(at('@cref[thm-a]', 'thm'), withLabel), { kind: 'block', path: 'Here.md', text: 'SRC', label: 'Theorem 1' });
	assert.equal(previewSpec(at('@ref[none]', 'none'), withLabel).kind, 'unresolved');
});

test('citations: the family, keys split, and what they preview', () => {
	const l = at('As \\citep[p. 3]{knuth84, lamport94} says', 'knuth');
	assert.deepEqual([l.kind, l.command, l.keys], ['cite', 'citep', ['knuth84', 'lamport94']]);
	const cite = { ...resolve, cite: (k) => (k === 'knuth84' ? { label: 'Knuth 1984', title: 'TeX' } : null) };
	assert.deepEqual(previewSpec(l, { ...cite, fullcite: true }), { kind: 'block', path: 'Here.md', text: '\\fullcite{knuth84}', label: 'Knuth 1984' });
	assert.equal(previewSpec(l, cite).message, 'Knuth 1984 — TeX', 'no bibliography named: the .bib fields on a card');
	assert.match(previewSpec(at('\\cite{nobody}', 'nobody'), cite).message, /No entry “nobody”/);
});

test('a PDF page anchor parses as the heading part', () => {
	const t = parseTarget('paper.pdf#page=12');
	assert.deepEqual([t.target, t.heading], ['paper.pdf', 'page=12']);
	const l = at('See [[paper.pdf#page=12]] there', 'paper');
	assert.deepEqual([l.target, l.heading], ['paper.pdf', 'page=12']);
});
