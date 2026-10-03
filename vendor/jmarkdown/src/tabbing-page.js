/*
	The page script that lays out tabbing blocks (tabbing.js) in an HTML page
	jmarkdown writes. A stop depends on the RENDERED width of the text before
	it, so only the browser can place the pieces: this measures each one and
	replays LaTeX's algorithm (`layoutTabbing`, tabbing.js's — one
	implementation) to place it. Until it runs, the pieces sit inline with a
	gap: readable, not aligned.

	html-template.js puts it in a page that has a tabbing block, through the
	default template's {{#Tabbing_script}} section; a custom template opts in
	with the same section. Clew's template has none, since Clew lays tabbing
	out with its own preview client.

	`layout` is Clew-app's src/preview-client/tabbing.js (@03bb33a). What
	differs is how a block is found. A page here can change under the script:
	watch mode's morphdom patches the body in place (stripping the layout's
	class and data-laid-key from a block), and the docs site swaps pages in by
	innerHTML. So a MutationObserver sweeps for blocks not laid out for their
	current source, and a ResizeObserver lays a block out again whenever a
	piece changes size: a web font arriving, MathJax typesetting a cell, a
	resize moving a `\`` row.

	The script is shipped as SOURCE TEXT, layoutTabbing's included
	(Function.prototype.toString), so tabbingPage must close over nothing in
	this module.
*/

import { layoutTabbing } from './tabbing.js';

function tabbingPage(layoutTabbing) {
	const pending = new Set();
	let scheduled = false;
	const observer = typeof ResizeObserver === 'function'
		? new ResizeObserver((entries) => {
			for (const entry of entries) {
				const block = entry.target.closest?.('.clew-tabbing');
				if (block) schedule(block);
			}
		})
		: null;

	function schedule(block) {
		pending.add(block);
		if (scheduled) return;
		scheduled = true;
		requestAnimationFrame(() => {
			scheduled = false;
			for (const b of pending) layout(b);
			pending.clear();
		});
	}

	// One block: rows from its markers, widths measured, pieces placed.
	function layout(block) {
		if (!block.isConnected || !block.offsetWidth) return;
		const rowEls = [...block.children].filter((c) => c.classList.contains('tb-row'));
		const rows = rowEls.map((rowEl) => ({
			kill: rowEl.classList.contains('tb-kill'),
			silent: rowEl.classList.contains('tb-silent'),
			items: [...rowEl.children].map((c) => (c.classList.contains('tb-t')
				? { op: 'text', el: c }
				: { op: c.dataset.op ?? '' })),
		}));
		block.classList.add('tb-laid');
		const style = getComputedStyle(block);
		const fontSize = parseFloat(style.fontSize) || 16;
		const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.6;
		// A scaled ancestor scales every rect; widths are wanted in the block's
		// own pixels.
		const scale = block.getBoundingClientRect().width / block.offsetWidth || 1;
		const out = layoutTabbing(rows, (r, i) => rows[r].items[i].el.getBoundingClientRect().width / scale, {
			sep: fontSize * 0.5,              // \tabbingsep = \labelsep = 0.5em
			lineWidth: block.clientWidth,     // \linewidth, for a \` row
		});
		let minLeft = 0;
		out.forEach(({ lefts }, r) => {
			let height = 0;
			for (const [i, x] of lefts) {
				minLeft = Math.min(minLeft, x);
				const span = rows[r].items[i].el;
				span.style.left = `${x}px`;
				height = Math.max(height, span.getBoundingClientRect().height / scale);
			}
			rowEls[r].style.height = rows[r].kill || rows[r].silent ? '0px' : `${Math.max(height, lineHeight)}px`;
		});
		// \' can hang a piece left of stop 0, into the margin, as TeX does. Where
		// there is no margin to hang into, the block steps right by what hangs,
		// so nothing is cut off.
		block.style.marginLeft = '';
		const room = (block.getBoundingClientRect().left - document.documentElement.getBoundingClientRect().left) / scale;
		if (minLeft < 0 && room + minLeft < 0) block.style.marginLeft = `${Math.ceil(-(room + minLeft))}px`;
		block.dataset.laidKey = block.dataset.tabbingKey ?? '';
	}

	// Every block not laid out for its current source. The layout's own
	// writes (the class, data-laid-key) wake the MutationObserver too, but
	// find the block laid out, so the sweep comes to rest.
	function sweep() {
		for (const block of document.querySelectorAll('.clew-tabbing')) {
			if (block.classList.contains('tb-laid') && block.dataset.laidKey === (block.dataset.tabbingKey ?? '')) continue;
			schedule(block);
			if (observer) {
				observer.observe(block);
				for (const piece of block.querySelectorAll('.tb-t')) observer.observe(piece);
			}
		}
	}

	function start() {
		sweep();
		if (typeof MutationObserver === 'function') {
			new MutationObserver(sweep).observe(document.body, {
				childList: true, subtree: true,
				attributes: true, attributeFilter: ['class', 'data-tabbing-key', 'data-laid-key'],
			});
		}
		document.fonts?.ready?.then(() => { for (const b of document.querySelectorAll('.clew-tabbing')) schedule(b); });
		window.addEventListener('resize', () => { for (const b of document.querySelectorAll('.clew-tabbing')) schedule(b); });
	}
	if (document.body) start();
	else document.addEventListener('DOMContentLoaded', start);
}

/** The page script, as source text: tabbingPage started with layoutTabbing. */
export function tabbingPageScript() {
	return `(${tabbingPage.toString()})(${layoutTabbing.toString()});`;
}

/** docs/tabbing-layout.js, as scripts/docs-tabbing-layout.mjs writes it. */
export function docsTabbingLayout() {
	return '// Generated by scripts/docs-tabbing-layout.mjs from src/tabbing-page.js;\n'
		+ '// do not edit. Lays out the docs pages\' tabbing blocks.\n'
		+ tabbingPageScript() + '\n';
}
