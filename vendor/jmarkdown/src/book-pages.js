/*
	A book laid out as pages (`htmlLayout: 'split'`, book.js): the one document
	the build makes, cut at its chapters AFTER the post-processor has numbered,
	cross-referenced and resolved it — so every number and every link is the
	whole book's (plan §5: option A plus a split at chapter boundaries).

	  <out>/index.html         the master's own text, with the contents where
	                           the chapters stood
	  <out>/<chapter>.html     one per chapter, named from its file, with
	                           previous / contents / next above and below it
	  <out>/references.html    the master's @bibliography, when it lists anything
	  <out>/index-terms.html   the master's @index, when it has one

	<out> is the output file without its extension (build/Book.html →
	build/Book/). Each page is the whole document's head and the parts of its
	body that are its own: the master's math macros and the closing scripts go
	on every page; a chapter's scoped <style> only on its own. A link to an id
	that landed on another page becomes `page.html#id`. A relative URL means
	what it means beside the master (book.js has rebased the chapters' onto its
	folder), and is rewritten to reach that from the page's folder (G10).
*/

import fs from 'fs';
import path from 'path';
import { cheerio, beautifyHTML } from './post-processor.js';
import { getBook } from './book.js';

const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A URL that is not relative to the page: a scheme, a root, a fragment, data.
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/|#|\?)/i;

// The navigation's look: plain, and out of the way of the page's own CSS.
const NAV_STYLE = `<style data-jmd-book-nav>
.jmd-book-nav { display: flex; justify-content: space-between; gap: 1em; margin: 1.5em 0; font-size: 0.9em; }
.jmd-book-nav .next { margin-left: auto; text-align: right; }
.jmd-book-contents ol { list-style: none; padding-left: 0; }
.jmd-book-contents li { margin: 0.3em 0; }
</style>`;

// A page's file name from a chapter's: URL-safe, and never one already taken.
function pageName(name, taken) {
	const base = path.basename(name, path.extname(name)).replace(/\s+/g, '-').replace(/[^\w.-]/g, '') || 'chapter';
	let file = `${base}.html`;
	for (let n = 2; taken.has(file.toLowerCase()); n++) file = `${base}-${n}.html`;
	taken.add(file.toLowerCase());
	return file;
}

/**
 * Write the pages, and return their paths (index.html first). `html` is the
 * finished single document, before beautifying.
 */
export function writeBookPages(html, outFile) {
	const book = getBook();
	const $ = cheerio.load(html);
	const base = book.masterDir;
	const dir = path.resolve(outFile).replace(/\.[^./\\]+$/, '');
	const bookTitle = $('head > title').text().trim();

	// Which part of the body belongs to which page: the chapters' container's
	// children, each a chapter, the References, the index, shared, or the
	// index page's.
	const sections = $('section.jmd-chapter').toArray();
	const container = sections.length ? $(sections[0]).parent() : $('body');
	const taken = new Set(['index.html', 'references.html', 'index-terms.html']);
	const pages = [{ file: 'index.html', kind: 'index', title: bookTitle }];
	for (const section of sections) {
		const n = Number($(section).attr('data-chapter'));
		const chapter = book.chapters.find((c) => c.index === n);
		const heading = $(section).find('h1').first().text().trim();
		pages.push({ file: pageName(chapter ? chapter.name : `chapter-${n}`, taken), kind: 'chapter', chapter: n, title: heading || chapter?.title || `Chapter ${n}` });
	}
	const references = container.children('section.jmd-book-references').filter((i, el) => $(el).children().length > 0);
	if (references.length) pages.push({ file: 'references.html', kind: 'references', title: references.find('.bibliography-title').first().text().trim() || 'References' });
	const terms = container.children('nav.index');
	if (terms.length) pages.push({ file: 'index-terms.html', kind: 'terms', title: terms.find('.index-title').first().text().trim() || 'Index' });

	const pageOf = (el) => {
		const $el = $(el);
		if ($el.is('section.jmd-chapter')) return pages.find((p) => p.chapter === Number($el.attr('data-chapter'))).file;
		if ($el.is('section.jmd-book-references')) return references.length ? 'references.html' : null;
		if ($el.is('nav.index')) return 'index-terms.html';
		if ($el.is('script, div.math-macros')) return '*';
		return 'index.html';
	};
	const parts = container.children().toArray().map((el, i) => ({ i, page: pageOf(el) }));

	// Where every id is, for the links between pages.
	const where = new Map();
	container.children().each((i, el) => {
		const page = parts[i].page;
		if (!page || page === '*') return;
		$(el).find('[id]').addBack('[id]').each((j, node) => { if (!where.has($(node).attr('id'))) where.set($(node).attr('id'), page); });
	});

	const nav = (k) => {
		const prev = pages[k - 1];
		const next = pages[k + 1];
		let out = '<nav class="jmd-book-nav">';
		if (prev) out += `<a class="prev" rel="prev" href="${prev.file}">← ${escapeText(prev.title)}</a>`;
		if (k > 0) out += '<a class="contents" href="index.html">Contents</a>';
		if (next) out += `<a class="next" rel="next" href="${next.file}">${escapeText(next.title)} →</a>`;
		return `${out}</nav>`;
	};
	const contents = () => `<nav class="jmd-book-contents" aria-label="Contents"><ol>${pages.slice(1)
		.map((p) => `<li><a href="${p.file}">${escapeText(p.title)}</a></li>`).join('')}</ol></nav>`;

	const rebase = (url) => {
		const m = /^([^?#]*)(.*)$/.exec(url.trim());
		if (!m[1] || ABSOLUTE.test(url.trim()) || /^\/\//.test(url.trim())) return url;
		return path.relative(dir, path.resolve(base, m[1])).split(path.sep).join('/') + m[2];
	};

	fs.mkdirSync(dir, { recursive: true });
	const written = [];
	pages.forEach((page, k) => {
		const $p = cheerio.load(html);
		const sectionsHere = $p('section.jmd-chapter').toArray();
		const box = sectionsHere.length ? $p(sectionsHere[0]).parent() : $p('body');

		// Only this page's part of the body, and what every page shares. The
		// contents will stand where the chapters stood.
		let mainNode = null;
		box.children().toArray().forEach((el, i) => {
			const owner = parts[i]?.page;
			if (owner === '*') return;
			if (owner === page.file) { mainNode ??= el; return; }
			if (page.kind === 'index' && el === sectionsHere[0]) $p(el).before('<div data-jmd-contents></div>');
			$p(el).remove();
		});

		// Relative URLs, from the page's folder — before any link of the
		// book's own is added.
		for (const attr of ['src', 'href', 'poster', 'data']) {
			$p(`[${attr}]`).each((i, el) => {
				const value = $p(el).attr(attr);
				if (!(attr === 'href' && value.startsWith('#'))) $p(el).attr(attr, rebase(value));
			});
		}
		$p('style').each((i, el) => {
			const css = $p(el).text();
			const moved = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, q, url) => (ABSOLUTE.test(url) || /^data:/i.test(url) ? whole : `url(${q}${rebase(url)}${q})`));
			if (moved !== css) $p(el).text(moved);
		});

		// A link to an id that landed on another page.
		$p('[href^="#"]').each((i, el) => {
			const id = $p(el).attr('href').slice(1);
			const target = where.get(id);
			if (id && target && target !== page.file) $p(el).attr('href', `${target}#${id}`);
		});

		// The book's own links: the contents, and previous / next.
		$p('div[data-jmd-contents]').replaceWith(contents());
		if (page.kind !== 'index' && mainNode) {
			$p(mainNode).before(nav(k));
			$p(mainNode).after(nav(k));
		} else if (page.kind === 'index' && pages.length > 1) {
			const firstScript = box.children('script').first();
			if (firstScript.length) firstScript.before(nav(k));
			else box.append(nav(k));
		}

		// The head: the page's title, and only its own chapter's styles.
		if (page.kind !== 'index') $p('head > title').text(bookTitle ? `${page.title} — ${bookTitle}` : page.title);
		$p('head style[data-jmd-chapter]').each((i, style) => {
			if (page.kind !== 'chapter' || Number($p(style).attr('data-jmd-chapter')) !== page.chapter) $p(style).remove();
		});
		$p('head').append(NAV_STYLE);

		const file = path.join(dir, page.file);
		fs.writeFileSync(file, beautifyHTML($p.html()));
		written.push(file);
	});
	return written;
}
