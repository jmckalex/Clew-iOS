// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The live-edit construct model (src/renderer/editor/live/model.js): the
// one list both decoration providers read. Built over a real EditorState
// with the editor's own markdown config, so the tree is the editor's.
// Ranges are asserted as the text they cover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { noteMarkdown } from '../vendor/clew/renderer/editor/jmd/markdown-config.js';
import { liveModel } from '../vendor/clew/renderer/editor/live/model.js';

function model(doc, config = {}) {
	const state = EditorState.create({ doc, extensions: [noteMarkdown(config)] });
	const cut = (r) => doc.slice(r.from, r.to);
	return liveModel(state, config).map((c) => ({
		...c, text: cut(c), hiddenText: c.hidden.map(cut), extentText: c.extents.map(cut),
	}));
}
const kinds = (doc, config) => model(doc, config).map((c) => c.kind);
const one = (doc, kind, config) => {
	const found = model(doc, config).filter((c) => c.kind === kind);
	assert.equal(found.length, 1, `one ${kind}; got ${found.length}`);
	return found[0];
};

test('the dialect\'s emphasis: *strong*, **intense**, __underline__, /italic/', () => {
	const m = model('A *s* and **i** and __u__ and /it/ here.\n');
	assert.deepEqual(m.map((c) => [c.kind, c.text, c.hiddenText]), [
		['strong', '*s*', ['*', '*']],
		['intense', '**i**', ['**', '**']],
		['underline', '__u__', ['__', '__']],
		['italic', '/it/', ['/', '/']],
	]);
	assert.ok(m.every((c) => c.tier === 'A' && c.level === 'inline'));
});

test('under normalSyntax: *x* italic, **x** strong, no /italic/ or ==highlight==', () => {
	const cfg = { normalSyntax: true };
	assert.deepEqual(kinds('A *e* and **s** and _e_ and /no/ and ==no== here.\n', cfg),
		['italic', 'strong', 'italic']);
});

test('strike (~ and ~~), sub/sup (dialect), code, escape', () => {
	const m = model('A ~a~ ~~b~~ H_2O x^{10} `c` \\* end.\n');
	assert.deepEqual(m.map((c) => [c.kind, c.text, c.hiddenText]), [
		['strike', '~a~', ['~', '~']],
		['strike', '~~b~~', ['~~', '~~']],
		['sub', '_2', ['_']],
		['sup', '^{10}', ['^{', '}']],
		['code', '`c`', ['`', '`']],
		['escape', '\\*', ['\\']],
	]);
});

test('headings hide their marks and the space; line level', () => {
	const c = one('## Title ##\n', 'heading');
	assert.deepEqual([c.depth, c.hiddenText, c.level, c.extentText], [2, ['## ', ' ##'], 'line', ['## Title ##']]);
});

test('links: text shown, the rest hidden; a bare [x] is not a link', () => {
	const c = one('See [the docs](https://x.org "T") and [bare].\n', 'link');
	assert.deepEqual([c.url, c.hiddenText], ['https://x.org', ['[', '](https://x.org "T")']]);
	assert.deepEqual(one('Go <https://x.org> now.\n', 'autolink').hiddenText, ['<', '>']);
});

test('wikilinks: alias shown, target hidden; same-note heading shows the heading', () => {
	assert.deepEqual(one('[[Target|shown]]\n', 'wikilink').hiddenText, ['[[Target|', ']]']);
	assert.deepEqual(one('[[Target]]\n', 'wikilink').hiddenText, ['[[', ']]']);
	assert.deepEqual(one('[[#Setup]]\n', 'wikilink').hiddenText, ['[[#', ']]']);
});

/** A wikilink's text as live edit shows it: what lies between its hidden pieces. */
const shownOf = (c) => c.hidden.slice(1).map((h, i) => c.text.slice(c.hidden[i].to - c.from, h.from - c.from)).join('');

test('a wikilink\'s |external is hidden as reading view drops it — never shown as text (the owner, 2026-11-23)', () => {
	const c = one('[[Files/paper.pdf|Read the paper|external]]\n', 'wikilink');
	assert.deepEqual(c.hiddenText, ['[[Files/paper.pdf|', '|external]]']);
	assert.equal(shownOf(c), 'Read the paper');
	// The engine's rule (engine/wikilinks.js): every part that is `external`,
	// in any case, wherever it stands; the rest shown as written.
	assert.equal(shownOf(one('[[paper.pdf|External|Read it]]\n', 'wikilink')), 'Read it');
	const mid = one('[[paper.pdf|Read|external|now]]\n', 'wikilink');
	assert.deepEqual(mid.hiddenText, ['[[paper.pdf|', '|external', ']]']);
	assert.equal(shownOf(mid), 'Read|now');
	// Nothing left: the target's name, as reading view's label.
	const bare = one('[[paper.pdf|external]]\n', 'wikilink');
	assert.deepEqual(bare.hiddenText, ['[[', '|external]]']);
	assert.equal(shownOf(bare), 'paper.pdf');
	assert.equal(shownOf(one('[[paper.pdf#Intro|external]]\n', 'wikilink')), 'paper.pdf');
	// A caption that only contains the word is a caption.
	assert.deepEqual(one('[[Note|external notes]]\n', 'wikilink').hiddenText, ['[[Note|', ']]']);
	assert.equal(one('[[Note|external notes]]\n', 'wikilink').external, false);
	assert.equal(c.external, true);
	// In a table the pipes are escaped, and the backslash is the table's.
	const cell = one('| a | b |\n| --- | --- |\n| x | [[paper.pdf\\|In a table\\|external]] |\n', 'wikilink');
	assert.equal(shownOf(cell), 'In a table');
	assert.equal(shownOf(one('| a |\n| --- |\n| [[paper.pdf\\|external]] |\n', 'wikilink')), 'paper.pdf');
	assert.equal(shownOf(one('| a |\n| --- |\n| [[paper.pdf\\|external\\|Caption]] |\n', 'wikilink')), 'Caption');
});

test('nothing inside what the engine reads as text is formatted: a link\'s path, a citation\'s keys, a {{var}} (the owner, 2026-11-23)', () => {
	const doc = '[[Course_2026/Week_1 notes.pdf|Notes_2]] and H_2O.\n\n![[Pics/a_1.png]]\n\n\\cite{smith_2020} and {{var_1}}.\n\n@reveal[https://a.com/x_1/]\n';
	// One subscript: the paragraph's own H_2O, outside them all.
	assert.deepEqual(model(doc).filter((c) => c.kind === 'sub').map((c) => c.from), [doc.indexOf('_2O')]);
});

test('images and embeds: tier B image, tier C embed, chip when inline', () => {
	const m = model('![[pic.png|300]]\n\n![[Other#Part]]\n\n![alt](a.png)\n\nText ![[Other]] inline.\n');
	assert.deepEqual(m.map((c) => [c.kind, c.tier, c.level, c.text]), [
		['image', 'B', 'block', '![[pic.png|300]]'],
		['embed', 'C', 'block', '![[Other#Part]]'],
		['image', 'B', 'block', '![alt](a.png)'],
		['embedChip', 'A', 'inline', '![[Other]]'],
	]);
	assert.equal(m[1].heading, 'Part');
});

test('lists and tasks: per-item line constructs with depth', () => {
	const m = model('- a\n  - b\n- [x] done\n1. one\n');
	assert.deepEqual(m.map((c) => [c.kind, c.depth, c.hiddenText, c.extentText]), [
		['bullet', 1, ['- '], ['- a']],
		['bullet', 2, ['- '], ['  - b']],
		['task', 1, ['- '], ['- [x] done']],
		['numbered', 1, [], ['1. one']],
	]);
	assert.equal(m[2].checked, true);
});

test('an item past its first line: each line of its own paragraphs is its text', () => {
	const src = [
		'- a hard break  ', '  after it',
		'- lazy', 'continued',
		'- two paragraphs', '', '  the second', '\t\tand a tab',
		'  - nested  ', '    nested line',
		'1. one  ', '   one more',
		'- [ ] task  ', '  task line',
		'> - quoted  ', '>   quoted line',
		'- fenced', '', '  ```', '  code', '  ```',
	].join('\n') + '\n';
	const m = model(src);
	const cut = (r) => src.slice(r.from, r.to);
	assert.deepEqual(m.filter((c) => c.kind === 'listText').map((c) => [c.text, c.depth, cut(c.indent), cut(c.listMark)]), [
		['  after it', 1, '  ', '-'],
		['continued', 1, '', '-'],
		['  the second', 1, '  ', '-'],
		['\t\tand a tab', 1, '\t\t', '-'],
		['    nested line', 2, '    ', '-'],
		['   one more', 1, '   ', '1.'],
		['  task line', 1, '  ', '-'],
		// After the `>` and the one space the quote conceals with it.
		['>   quoted line', 1, '  ', '-'],
	]);
	// The blank line and the fence are not text lines; the number's width
	// covers the number and its space — and a numbered item's text lines carry
	// it too, so they hang by it (columns.js#numberWidth); no other item's do.
	assert.equal(cut(m.find((c) => c.kind === 'numbered').numberMark), '1. ');
	assert.deepEqual(m.filter((c) => c.kind === 'listText').map((c) => c.numberMark && cut(c.numberMark)),
		[undefined, undefined, undefined, undefined, undefined, '1. ', undefined, undefined]);
});

test('quotes: one construct per line, depth from the markers', () => {
	const m = model('> a\n> > b\n').filter((c) => c.kind === 'quote');
	assert.deepEqual(m.map((c) => [c.text, c.depth, c.hiddenText]), [
		['> a', 1, ['> ']],
		['> > b', 2, ['> > ']],
	]);
});

test('a quote inside a list item knows the item\'s marker and the indentation before its `>`', () => {
	const doc = '* item:\n    > quoted\n    > more\n\n1. numbered:\n   > in it\n\n* outer\n  * inner:\n    > nested\n\n> top\n';
	const m = model(doc).filter((c) => c.kind === 'quote');
	assert.deepEqual(m.map((c) => [c.text.trim(), c.listMark ? doc.slice(c.listMark.from, c.listMark.to) : null,
		c.indent ? doc.slice(c.indent.from, c.indent.to) : null, c.hiddenText]), [
		['> quoted', '*', '    ', ['> ']],
		['> more', '*', '    ', ['> ']],
		['> in it', '1.', '   ', ['> ']],
		['> nested', '*', '    ', ['> ']],
		['> top', null, null, ['> ']],
	]);
	// The nested quote is the INNER item's: its marker two columns in.
	const nested = m.find((c) => c.text.includes('nested'));
	assert.equal(nested.listMark.from, doc.indexOf('* inner'));
	// A numbered item's quote carries its number, which it hangs by; a
	// bullet's, a task's in a numbered list and a quote outside a list none.
	assert.deepEqual(m.map((c) => c.numberMark && doc.slice(c.numberMark.from, c.numberMark.to)), [undefined, undefined, '1. ', undefined, undefined]);
	const more = '10)  ten:\n     > in ten\n\n1. [ ] a task:\n   > in the task\n';
	assert.deepEqual(model(more).filter((c) => c.kind === 'quote').map((c) => c.numberMark && more.slice(c.numberMark.from, c.numberMark.to)),
		['10)  ', undefined]);
});

test('title-page lines: @title, @<title>, ::title alone on their lines; not mid-sentence, not :title', () => {
	const doc = '@title[A two-line\n  title]\n@author+[An Author]\n@<date>[Today]\n::subtitle[Sub]\n'
		+ '\nBy @author[Someone] here.\n\n:title[a title element]\n\n@begin[not a title]\n';
	const m = model(doc).filter((c) => c.kind === 'directiveAt' || c.kind === 'directiveInline');
	assert.deepEqual(m.map((c) => [c.text.split('[')[0], c.titlePage]), [
		['@title', 'title'], ['@author+', 'author'], ['@<date>', 'date'], ['::subtitle', 'subtitle'],
		['@author', null], [':title', null], ['@begin', null],
	]);
});

test('callouts: type through the aliases, fold, title; body lines carry the type', () => {
	const m = model('> [!TLDR]- Short *version*\n> body\n');
	const c = m.find((x) => x.kind === 'callout');
	assert.deepEqual([c.type, c.rawType, c.fold, c.hiddenText, doc(c.title)], ['abstract', 'TLDR', '-', ['[!TLDR]- '], 'Short *version*']);
	assert.deepEqual(m.filter((x) => x.kind === 'quote').map((x) => x.callout), ['abstract', 'abstract']);
	function doc(r) { return '> [!TLDR]- Short *version*\n> body\n'.slice(r.from, r.to); }
});

test('an unknown callout type is a callout, as the engine renders it (a note)', () => {
	// jmarkdown a7de8c6 draws `[!nonsense]` as a note titled as written;
	// live edit's model follows (the type lower-cased, the name as written).
	const c = model('> [!Nonsense] Title\n').find((x) => x.kind === 'callout');
	assert.equal(c?.type, 'nonsense');
	assert.equal(c?.rawType, 'Nonsense');
});

test('alignment beats blockquote', () => {
	const m = model('>> centred <<\n\n>> right\n');
	assert.deepEqual(m.map((c) => [c.kind, c.align, c.hiddenText]), [
		['align', 'center', ['>> ', ' <<']],
		['align', 'right', ['>> ']],
	]);
});

test('blocks: table, hr, frontmatter, TOC, display math', () => {
	const m = model('---\ntitle: X\n---\n\n| a |\n|---|\n| 1 |\n\n***\n\n{{TOC}}\n\n$$\nE = mc^2\n$$\n');
	assert.deepEqual(m.map((c) => [c.kind, c.tier, c.level]), [
		['frontmatter', 'A', 'block'],
		['table', 'B', 'block'],
		['hr', 'A', 'block'],
		['toc', 'A', 'block'],
		['math', 'A', 'block'],
	]);
});

test('frontmatter is opaque: its lines make no constructs', () => {
	assert.deepEqual(kinds('---\ntitle: *not strong*\n---\n'), ['frontmatter']);
});

test('inline math vs display math on its own line vs display mid-line', () => {
	const m = model('A $x$ and $$y$$ here.\n\n\\[\nz\n\\]\n');
	assert.deepEqual(m.map((c) => [c.kind, c.level, c.display]), [
		['math', 'inline', false],
		['math', 'inline', true],
		['math', 'block', true],
	]);
});

test('rich fences are tier C; plain code fences reveal on their fence lines only', () => {
	const m = model('```mermaid\ngraph\n```\n\n```ad-note\nx\n```\n\n```js\nlet a;\n```\n\n```chart\ny\n```\n');
	assert.deepEqual(m.map((c) => [c.kind, c.tier, c.name ?? c.lang]), [
		['richBlock', 'C', 'mermaid'],
		['richBlock', 'C', 'ad-note'],
		['codeFence', 'A', 'js'],
		['codeFence', 'A', 'chart'],
	]);
	assert.deepEqual(m[2].extentText, ['```js', '```']);
	// A plugin-claimed fence is rich when the caller says so.
	assert.equal(kinds('```chart\ny\n```\n', { richFences: ['chart'] })[0], 'richBlock');
});

test('directives: rich ones are frames; generic ones reveal on opener/closer only', () => {
	const m = model(':::mermaid\ngraph\n:::\n\n:::theorem[P]\nBody *x*\n:::\n');
	assert.deepEqual(m.map((c) => [c.kind, c.tier]), [['richBlock', 'C'], ['directive', 'A'], ['strong', 'A']]);
	assert.deepEqual(m[1].extentText, [':::theorem[P]', ':::']);
});

test('@begin(game|Mathematica|markdown-demo) are frames, as their ::: twins; @begin(comment|HTML) carry their twins\' flags', () => {
	const m = model('@begin(game)\n | A\n@end(game)\n\n@begin(Mathematica){output="svg"}\nx\n@end(Mathematica)\n\n@begin(markdown-demo)\n*x*\n@end(markdown-demo)\n');
	assert.deepEqual(m.map((c) => [c.kind, c.tier, c.name]), [
		['richBlock', 'C', 'game'], ['richBlock', 'C', 'Mathematica'], ['richBlock', 'C', 'markdown-demo'],
	]);
	const comment = one('@begin(comment)\nnote\n@end(comment)\n', 'environment');
	const html = one('@begin(HTML)\nweb\n@end(HTML)\n', 'environment');
	const colon = one(':::comment\nnote\n:::\n', 'directive');
	assert.deepEqual([comment.comment, html.htmlOnly, colon.comment], [true, true, true]);
	assert.equal(one('@begin(<name>)\nx\n@end(name)\n', 'environment').name, 'name', 'the sigil is not the name');
});

test(':::TeX and @begin(TeX) bodies are opaque; math environments are display math', () => {
	assert.deepEqual(kinds(':::TeX\n\\textbf{*x*}\n:::\n'), ['directive']);
	assert.deepEqual(kinds('@begin(TeX)\n*x*\n@end(TeX)\n'), ['environment']);
	const m = one('@begin(align)\na &= b\n@end(align)\n', 'math');
	assert.deepEqual([m.env, m.level, m.display], ['align', 'block', true]);
});

test('@reveal and HTML with custom elements are frames; plain HTML stays source', () => {
	assert.deepEqual(model('@reveal[Deck/]\n\n<my-widget></my-widget>\n\n<div>plain</div>\n')
		.map((c) => [c.kind, c.tier]), [['richBlock', 'C'], ['richBlock', 'C'], ['html', 'A']]);
});

test('footnotes, citations, tags, block ids, terms, mustaches', () => {
	const m = model('A[fn: note] \\citep{k1,k2} #tag {{name}} end. ^id-1\n\nTerm:: definition\n');
	assert.deepEqual(m.map((c) => c.kind), ['footnote', 'cite', 'tag', 'mustache', 'blockId', 'term']);
	assert.deepEqual(m[1].keys, ['k1', 'k2']);
	assert.equal(m[4].id.length > 0, true);
});

test('a multi-line footnote is concealed whole, like a one-line one; an unclosed one is no construct', () => {
	const note = one('A[fn: one\n\ntwo] b\n', 'footnote');
	assert.deepEqual(note.hiddenText, ['[fn: one\n\ntwo]']);
	assert.equal(note.multiline, true);
	assert.equal(note.level, 'inline', 'a caret anywhere in any paragraph reveals it all');
	assert.deepEqual(kinds('A[fn: typing'), []);
});

test('footnotes are numbered once, in document order, one-line and multi-line alike', () => {
	const notes = model('A[fn: one] b[^long: two\n\n- a list\n\nthree] c[fn: four].\n').filter((c) => c.kind === 'footnote');
	assert.deepEqual(notes.map((c) => c.number), [1, 2, 3]);
	assert.deepEqual(notes.map((c) => c.multiline), [false, true, false]);
	// What the body holds is still modelled (it renders when revealed).
	assert.ok(model('A[^long: two\n\n- a list\n\nthree] c.\n').some((c) => c.kind === 'bullet'));
});

test('ids are unique even for identical constructs, and stable across unrelated edits', () => {
	const a = model('*x* and *x*\n\nTail.\n').filter((c) => c.kind === 'strong');
	assert.notEqual(a[0].id, a[1].id);
	const b = model('*x* and *x*\n\nTail changed.\n').filter((c) => c.kind === 'strong');
	assert.deepEqual(b.map((c) => c.id), a.map((c) => c.id));
});

test('memoised per document version', () => {
	const state = EditorState.create({ doc: '*x*\n', extensions: [noteMarkdown()] });
	assert.equal(liveModel(state), liveModel(state));
	assert.notEqual(liveModel(state), liveModel(state, { normalSyntax: true }));
});

test('nested emphasis: italic around strong, and strong around italic', () => {
	assert.deepEqual(model('Boldface and /*italics*/.\n').map((c) => [c.kind, c.text]),
		[['italic', '/*italics*/'], ['strong', '*italics*']]);
	assert.deepEqual(model('a */italics/* b\n').map((c) => [c.kind, c.text]),
		[['strong', '*/italics/*'], ['italic', '/italics/']]);
});

// Bare URLs are links in reading view since jmarkdown 3134543 (GFM's url
// tokenizer, reachable once the `:` directive stopped cutting at `http:`),
// so live edit draws them as links too — and no slash in one is italic.
test('bare URLs: links, with the href reading view gives them', () => {
	const urls = (doc) => model(doc).filter((c) => c.kind === 'url').map((c) => [c.text, c.url]);
	assert.deepEqual(urls('see https://a.com/b/c?q=1&r=2#frag for this\n'),
		[['https://a.com/b/c?q=1&r=2#frag', 'https://a.com/b/c?q=1&r=2#frag']]);
	assert.deepEqual(urls('at the end https://a.com/x/y.\n'), [['https://a.com/x/y', 'https://a.com/x/y']]);
	assert.deepEqual(urls('www.example.com/a/b/ here\n'), [['www.example.com/a/b/', 'http://www.example.com/a/b/']]);
	assert.deepEqual(urls('mail me@example.com ok\n'), [['me@example.com', 'mailto:me@example.com']]);
	assert.deepEqual(urls('ftp://files.example.org/pub/x/ ok, and ftp://f.org/a.\n'),
		[['ftp://files.example.org/pub/x/', 'ftp://files.example.org/pub/x/'], ['ftp://f.org/a', 'ftp://f.org/a']]);
	assert.deepEqual(urls('xftp://no.org and `ftp://code.org`\n'), []);
	assert.deepEqual(kinds('see http://a/b/c/ for this\n').filter((k) => k === 'italic'), []);
});

test('bare URLs: not inside a link, an autolink, code, or a literal directive', () => {
	const urls = (doc) => model(doc).filter((c) => c.kind === 'url').map((c) => c.text);
	assert.deepEqual(urls('[https://a.com/x](https://a.com/x) and <https://b.com>\n'), []);
	assert.deepEqual(urls('`https://a.com/x` code\n'), []);
	assert.deepEqual(urls('@reveal[https://a.com/deck/]\n'), []);
	assert.deepEqual(urls('@image[https://a.com/p.png]{width=50%} and https://c.com\n'), ['https://c.com']);
});
