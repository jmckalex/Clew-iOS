// A PDF embed's height (src/preview/pdf-size.js): the sizes a link sets, the
// one-page sum against EmbedPDF's own "fit page", and the host held there
// over a viewer's lifetime — a fake host and a fake EmbedPDF registry under
// plain Node. The real viewer, in reading mode and in live edit, is measured
// in the simulator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pdfSizeOptions, plainTitle, onePageHeight, estimateHeight, sizePdfHost, fitPdfToPage } from '../src/preview/pdf-size.js';

test('pdfSizeOptions: none by default; height and width from the fragment, Obsidian-style', () => {
	const none = { height: null, width: null };
	assert.deepEqual(pdfSizeOptions('x.pdf'), none);
	assert.deepEqual(pdfSizeOptions(undefined), none);
	assert.deepEqual(pdfSizeOptions('x.pdf#Some heading'), none);
	assert.deepEqual(pdfSizeOptions('x.pdf#height=600'), { height: 600, width: null });
	assert.deepEqual(pdfSizeOptions('x.pdf#height=600px'), { height: 600, width: null });
	assert.deepEqual(pdfSizeOptions('x.pdf# Height = 700 '), { height: 700, width: null }, 'case and spaces');
	assert.deepEqual(pdfSizeOptions('x.pdf#width=480'), { height: null, width: '480px' });
	assert.deepEqual(pdfSizeOptions('x.pdf#width=60%'), { height: null, width: '60%' });
	assert.deepEqual(pdfSizeOptions('Papers/x.pdf#page=3&height=500&width=75%'), { height: 500, width: '75%' }, 'joined by &; page left alone');
});

test('pdfSizeOptions: what is not a size is not one; sizes are held to sense', () => {
	assert.equal(pdfSizeOptions('x.pdf#height=50%').height, null, 'a percentage height would be of the frame: refused');
	assert.equal(pdfSizeOptions('x.pdf#height=abc').height, null);
	assert.equal(pdfSizeOptions('x.pdf#height=600em').height, null);
	assert.equal(pdfSizeOptions('x.pdf#height=10').height, 120, 'too short to use: the least');
	assert.equal(pdfSizeOptions('x.pdf#height=99999').height, 8000);
	assert.equal(pdfSizeOptions('x.pdf#width=20').width, '160px');
	assert.equal(pdfSizeOptions('x.pdf#width=150%').width, '100%');
});

test('plainTitle: the engine\'s "x.pdf § height=600" back to the file\'s name; any other title stays', () => {
	assert.equal(plainTitle('x.pdf#height=600', 'x.pdf § height=600'), 'x.pdf');
	assert.equal(plainTitle('Papers/x.pdf#page=3&height=500&width=75%', 'Papers/x.pdf § page=3&height=500&width=75%'), 'Papers/x.pdf');
	assert.equal(plainTitle('x.pdf#height=600', ' x.pdf § height=600 '), 'x.pdf', 'whitespace round it');
	assert.equal(plainTitle('x.pdf#height=600', 'My paper'), null, 'an alias is the author\'s');
	assert.equal(plainTitle('x.pdf#Methods', 'x.pdf § Methods'), null, 'a fragment that is not sizes');
	assert.equal(plainTitle('x.pdf#height=600&Methods', 'x.pdf § height=600&Methods'), null);
	assert.equal(plainTitle('x.pdf', 'x.pdf'), null, 'no fragment: nothing to do');
	assert.equal(plainTitle(undefined, ''), null);
});

const letter = { width: 612, height: 792 };
const landscape = { width: 792, height: 612 };
const single = (...pages) => pages.map((p) => [{ rotatedSize: p }]);

test('onePageHeight: the gap above, the tallest page at the widest page\'s fit-width scale, the gap to the next', () => {
	const k = 640 / 612;
	assert.equal(onePageHeight({ spreads: single(letter, letter), pageGap: 10, viewportGap: 10, width: 660 }), 10 + 792 * k + 10 * k);
	assert.equal(onePageHeight({ spreads: single(letter), pageGap: 10, viewportGap: 10, width: 660 }), 10 + 792 * k + 10,
		'one page: the viewport\'s gap below it, not a page gap');
	const m = 640 / 792;
	assert.equal(onePageHeight({ spreads: single(letter, landscape), pageGap: 10, viewportGap: 10, width: 660 }), 10 + 792 * m + 10 * m,
		'a landscape page sets the scale, a portrait one the height');
	const spread = [[{ rotatedSize: letter }, { rotatedSize: letter }], [{ rotatedSize: letter }]];
	const s = 640 / (612 * 2 + 8);
	assert.equal(onePageHeight({ spreads: spread, pageGap: 8, viewportGap: 10, width: 660 }), 10 + 792 * s + 8 * s, 'two-page spreads');
	assert.equal(onePageHeight({ spreads: [], viewportGap: 10, width: 660 }), null);
	assert.equal(onePageHeight({ spreads: single(letter), viewportGap: 10, width: 20 }), null);
	assert.equal(onePageHeight({ spreads: single({ width: 0, height: 0 }), width: 660 }), null);
});

test('onePageHeight: in EmbedPDF\'s vertical layout, exactly one page shows, at the top and at the end', () => {
	// The layout as the bundle has it: pages stacked from viewportGap down,
	// pageGap·scale apart, viewportGap after the last; the zoom fit width,
	// (clientWidth − 2·viewportGap) / widest page.
	const gap = 10;
	const pageGap = 10;
	for (const [pages, width] of [[[letter, letter, letter, letter], 660], [[letter, landscape], 980], [[{ width: 420, height: 595 }, { width: 420, height: 595 }], 512]]) {
		const height = Math.floor(onePageHeight({ spreads: single(...pages), pageGap, viewportGap: gap, width }));
		const scale = (width - 2 * gap) / Math.max(...pages.map((p) => p.width));
		const tops = [];
		let y = gap;
		for (const p of pages) { tops.push(y); y += p.height * scale + pageGap * scale; }
		const content = y - pageGap * scale + gap;
		const tallest = Math.max(...pages.map((p) => p.height)) * scale;
		// At the top: page one whole, page two not begun.
		assert.ok(tops[0] + pages[0].height * scale <= height, `${width}px: page one whole`);
		assert.ok(tops[1] >= height, `${width}px: nothing of page two (${tops[1].toFixed(2)} ≥ ${height})`);
		assert.ok(height - gap >= tallest - 1e-9 - pageGap * scale, 'room for the tallest page');
		// At the end: the last page whole.
		const lastTop = tops[tops.length - 1] - (content - height);
		assert.ok(lastTop >= 0, `${width}px: the last page's top in view at the end`);
	}
});

test('estimateHeight: a portrait letter page and a toolbar, before the PDF has said', () => {
	assert.equal(estimateHeight(612), Math.round(612 * 11 / 8.5 + 56));
	assert.equal(estimateHeight(0), estimateHeight(240), 'not yet laid out: still a usable height');
});

/** A `.clew-pdf-inline` host in its engine box, as far as pdf-size.js looks. */
function fakeHost(href, { width = 660 } = {}) {
	const link = { dataset: { href }, textContent: '' };
	const box = { style: { width: '', maxWidth: '' }, querySelector: (sel) => (sel === '.embed-title a[data-href]' ? link : null) };
	const host = {
		failed: false, isConnected: true, clientWidth: width, link, box,
		style: { height: '' },
		get offsetHeight() { return parseFloat(this.style.height) || 0; },
		querySelector: (sel) => (sel === ':scope > .clew-pdf-message' && host.failed ? {} : null),
		closest: (sel) => (sel === '.pdf-embed-box' ? box : null),
	};
	return host;
}

test('sizePdfHost: one page\'s guess by default; the link\'s height and width when it sets them', () => {
	const plain = fakeHost('x.pdf');
	sizePdfHost(plain);
	assert.equal(plain.style.height, `${estimateHeight(660)}px`);
	assert.deepEqual(plain.box.style, { width: '', maxWidth: '' }, 'the box as the engine drew it: the column\'s width');

	const set = fakeHost('x.pdf#height=600&width=480');
	sizePdfHost(set);
	assert.equal(set.style.height, '600px');
	assert.deepEqual(set.box.style, { width: '480px', maxWidth: '100%' }, 'the width on the box, never past the column');
	const percent = fakeHost('x.pdf#width=60%');
	sizePdfHost(percent);
	assert.deepEqual(percent.box.style, { width: '60%', maxWidth: '100%' }, 'a percentage of the column');
	percent.box.style = { width: '', maxWidth: '' };   // a morph: the engine's markup again
	sizePdfHost(percent);
	assert.equal(percent.box.style.width, '60%', 'set again after it');
});

test('sizePdfHost: the title loses the options, and again after a re-render puts them back', () => {
	const host = fakeHost('x.pdf#height=600');
	host.link.textContent = 'x.pdf § height=600';
	sizePdfHost(host);
	assert.equal(host.link.textContent, 'x.pdf');
	host.link.textContent = 'x.pdf § height=600';   // the morph's
	sizePdfHost(host);
	assert.equal(host.link.textContent, 'x.pdf');
	host.failed = true;
	host.link.textContent = 'x.pdf § height=600';
	sizePdfHost(host);
	assert.equal(host.link.textContent, 'x.pdf', 'a failed viewer\'s title too');
});

test('sizePdfHost after a re-render: an edited link changes the sizes; a measured height is kept', () => {
	const host = fakeHost('x.pdf#height=600&width=480');
	sizePdfHost(host);
	host.link.dataset.href = 'x.pdf';
	sizePdfHost(host);
	assert.equal(host.style.height, `${estimateHeight(660)}px`, 'the size taken out: one page again');
	assert.deepEqual(host.box.style, { width: '', maxWidth: '' }, 'and the width');
	host.style.height = '901px';   // as a viewer would have fitted it
	sizePdfHost(host);
	assert.equal(host.style.height, '901px', 'a plain re-render leaves it be');
	host.failed = true;
	sizePdfHost(host);
	assert.equal(host.style.height, '', 'a viewer that failed: as tall as its message');
});

/** EmbedPDF as fitPdfToPage reaches it: a viewport under a toolbar of `chrome` px. */
function fakeViewer(host, { pages, chrome = 50, gap = 10 }) {
	const listeners = new Set();
	const metrics = () => ({ clientWidth: host.clientWidth - 2, clientHeight: host.offsetHeight - chrome });
	const calls = { zoom: [], scrollTo: [] };
	let zoomLevel = 'fit-page';   // EmbedPDF's default, as the viewport mounts
	const plugins = {
		viewport: {
			getMetrics: metrics, getViewportGap: () => gap, scrollTo: (to) => calls.scrollTo.push(to),
			onViewportResize: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
		},
		zoom: { getState: () => ({ zoomLevel }), requestZoom: (level) => { calls.zoom.push(level); zoomLevel = level; } },
		scroll: { getPageGap: () => 10, forDocument: (id) => ({ getSpreadPagesWithRotatedSize: () => (id === 'doc' ? single(...pages) : []) }) },
		'document-manager': { getActiveDocumentId: () => 'doc' },
	};
	let disposed = 0;
	const handle = {
		container: { registry: Promise.resolve({ getPlugin: (id) => ({ provides: () => plugins[id] }) }) },
		dispose() { disposed += 1; },
	};
	// The viewer's own resize report: what EmbedPDF's ResizeObserver sends.
	// Each is answered on the next frame (a timer under Node).
	const resize = async () => {
		for (const cb of [...listeners]) cb({ documentId: 'doc', metrics: metrics() });
		await frame();
	};
	return { handle, resize, listeners, calls, disposed: () => disposed };
}

const frame = () => new Promise((resolve) => setTimeout(resolve, 5));

const fitted = (host, pages, chrome, gap = 10) =>
	chrome + Math.floor(onePageHeight({ spreads: single(...pages), pageGap: 10, viewportGap: gap, width: host.clientWidth - 2 }));

test('fitPdfToPage: fit width, one page tall, at the top of page one; it follows the width', async () => {
	const host = fakeHost('x.pdf');
	sizePdfHost(host);
	const viewer = fakeViewer(host, { pages: [letter, letter, letter] });
	await fitPdfToPage(host, viewer.handle);
	await frame();
	assert.deepEqual(viewer.calls.zoom, ['fit-width'], 'fit width, asked of the mounted viewport');
	assert.equal(host.offsetHeight, fitted(host, [letter, letter, letter], 50), 'one page under the toolbar');
	assert.equal(viewer.calls.scrollTo.length, 0, 'not scrolled before it has settled');
	await viewer.resize();
	assert.equal(host.offsetHeight, fitted(host, [letter, letter, letter], 50), 'its own resize report changes nothing');
	assert.deepEqual(viewer.calls.scrollTo, [{ x: 0, y: 0, behavior: 'instant' }], 'settled: the top of page one');

	host.clientWidth = 420;   // a rotation, a split, the ⟷ toggle
	await viewer.resize();
	assert.equal(host.offsetHeight, fitted(host, [letter, letter, letter], 50));
	await viewer.resize();
	assert.equal(viewer.calls.scrollTo.length, 1, 'scrolled to the top once only — the reader\'s place is theirs');
	assert.deepEqual(viewer.calls.zoom, ['fit-width'], 'and the zoom asked for once only');

	host.link.dataset.href = 'x.pdf#height=500';   // the note sets a height
	sizePdfHost(host);
	assert.equal(host.style.height, '500px');
	host.clientWidth = 700;
	await viewer.resize();
	assert.equal(host.style.height, '500px', 'a set height is the note\'s, whatever the width');

	host.link.dataset.href = 'x.pdf';   // and takes it out again
	sizePdfHost(host);
	await frame();
	assert.equal(host.offsetHeight, fitted(host, [letter, letter, letter], 50), 'fitted at once, the viewer being up');

	viewer.handle.dispose();
	assert.equal(viewer.disposed(), 1, 'the viewer\'s own dispose still runs');
	assert.equal(viewer.listeners.size, 0, 'and the resize listener goes with it');
});

test('fitPdfToPage: a set height still reads at fit width; a zoom that is not the default is left alone', async () => {
	const host = fakeHost('x.pdf#height=400');
	sizePdfHost(host);
	const viewer = fakeViewer(host, { pages: [letter, letter] });
	await fitPdfToPage(host, viewer.handle);
	await frame();
	assert.deepEqual(viewer.calls.zoom, ['fit-width']);
	assert.equal(host.style.height, '400px');

	const other = fakeHost('x.pdf');
	sizePdfHost(other);
	const chosen = fakeViewer(other, { pages: [letter, letter] });
	const registry = await chosen.handle.container.registry;
	registry.getPlugin('zoom').provides().getState = () => ({ zoomLevel: 1.5 });
	await fitPdfToPage(other, chosen.handle);
	await frame();
	await chosen.resize();
	assert.deepEqual(chosen.calls.zoom, [], 'a zoom of 150% stays');
});

test('fitPdfToPage: one resize answered per frame, however many reports come', async () => {
	const host = fakeHost('x.pdf');
	sizePdfHost(host);
	const viewer = fakeViewer(host, { pages: [letter] });
	const registry = await viewer.handle.container.registry;
	const vp = registry.getPlugin('viewport').provides();
	let reads = 0;
	const getMetrics = vp.getMetrics;
	vp.getMetrics = () => { reads += 1; return getMetrics(); };
	await fitPdfToPage(host, viewer.handle);
	for (const cb of [...viewer.listeners]) { cb({}); cb({}); cb({}); }
	await frame();
	assert.equal(reads, 1, 'four asks before the frame: one measure');
});

test('fitPdfToPage: a viewer whose chrome grows with it is corrected a few times, never forever', async () => {
	const host = fakeHost('x.pdf');
	sizePdfHost(host);
	const viewer = fakeViewer(host, { pages: [letter] });
	// A sidebar stacked under the page, a third of the viewer's height: every
	// correction grows it too, so the viewport is never quite one page.
	const metrics = () => ({ clientWidth: host.clientWidth - 2, clientHeight: Math.round(host.offsetHeight * 2 / 3) - 50 });
	const registry = await viewer.handle.container.registry;
	registry.getPlugin('viewport').provides().getMetrics = metrics;
	await fitPdfToPage(host, viewer.handle);
	await frame();
	const heights = [host.offsetHeight];
	for (let i = 0; i < 20; i++) {
		await viewer.resize();
		heights.push(host.offsetHeight);
	}
	assert.equal(new Set(heights).size, 4, `four corrections, then it stops: ${heights.join(', ')}`);
});

test('fitPdfToPage: no viewer, no registry, no document — nothing happens and nothing throws', async () => {
	const host = fakeHost('x.pdf');
	sizePdfHost(host);
	const before = host.style.height;
	await fitPdfToPage(host, null);
	await fitPdfToPage(host, { container: null });
	await fitPdfToPage(host, { container: { registry: Promise.reject(new Error('gone')) } });
	const viewer = fakeViewer(host, { pages: [] });
	await fitPdfToPage(host, viewer.handle);
	await frame();
	assert.equal(host.style.height, before);
});
