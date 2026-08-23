// Lightweight markdown rendering for canvas text cards — the jmarkdown
// inline dialect (*strong*, **intense**, /italic/, ==highlight==, ~strike~,
// `code`, $math$) plus headings, lists, task boxes, quotes, rules, and
// fences. Pure text → HTML string, fully escaped; NOT the engine (cards are
// snippets, not documents — full rendering would need per-card file
// backing). Links render as <a data-…> handled by the card's click handler.

const escapeHtml = (text) => text
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Placeholder protection for spans that must not be formatted further.
const OPEN = '\uE000';
const CLOSE = '\uE001';

function renderInline(raw) {
	const slots = [];
	const stash = (html) => {
		slots.push(html);
		return `${OPEN}${slots.length - 1}${CLOSE}`;
	};

	let text = escapeHtml(raw);

	// Protected spans first: inline code, then inline math.
	text = text.replace(/`([^`\n]+)`/g, (_, code) => stash(`<code>${code}</code>`));
	text = text.replace(/\$([^$\n]+)\$/g, (_, math) => stash(`<code class="card-math">${math}</code>`));

	// Wikilinks (with optional heading/alias) and markdown links.
	text = text.replace(/!?\[\[([^\[\]|\n]+?)(?:\|([^\[\]\n]+))?\]\]/g, (_, target, alias) =>
		stash(`<a class="card-wikilink" data-href="${target.trim()}">${(alias ?? target).trim()}</a>`));
	text = text.replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, (_, label, url) =>
		stash(`<a class="card-extlink" data-url="${url}">${label}</a>`));

	// jmarkdown inline forms. ** before *; /italic/ needs word boundaries so
	// paths and URLs survive.
	text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong class="card-intense">$1</strong>');
	text = text.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
	text = text.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
	text = text.replace(/~(\S(?:[^~\n]*\S)?)~/g, '<del>$1</del>');
	text = text.replace(/(^|[\s(])\/([^/\n]+?)\/(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');

	return text.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g'), (_, i) => slots[+i]);
}

/** Render a card's text to safe HTML. */
export function renderCardHtml(text) {
	const lines = (text ?? '').split('\n');
	const out = [];
	let inFence = false;
	let fenceLines = [];

	for (const line of lines) {
		if (/^```/.test(line.trim())) {
			if (inFence) {
				out.push(`<pre class="card-code">${escapeHtml(fenceLines.join('\n'))}</pre>`);
				fenceLines = [];
			}
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			fenceLines.push(line);
			continue;
		}

		const heading = /^(#{1,6})[ \t]+(.*)$/.exec(line);
		if (heading) {
			const level = Math.min(heading[1].length, 4);
			out.push(`<div class="card-h card-h${level}">${renderInline(heading[2])}</div>`);
			continue;
		}
		if (/^(\s*)(-{3,}|\*{3,})\s*$/.test(line)) {
			out.push('<div class="card-hr"></div>');
			continue;
		}
		const task = /^\s*[-*+][ \t]+\[( |x|X)\][ \t]+(.*)$/.exec(line);
		if (task) {
			const done = task[1] !== ' ';
			out.push(`<div class="card-li card-task${done ? ' is-done' : ''}">`
				+ `<span class="card-box">${done ? '☑' : '☐'}</span>`
				+ `<span>${renderInline(task[2])}</span></div>`);
			continue;
		}
		const bullet = /^\s*[-*+][ \t]+(.*)$/.exec(line);
		if (bullet) {
			out.push(`<div class="card-li"><span class="card-bullet">•</span><span>${renderInline(bullet[1])}</span></div>`);
			continue;
		}
		const numbered = /^\s*(\d+)[.)][ \t]+(.*)$/.exec(line);
		if (numbered) {
			out.push(`<div class="card-li"><span class="card-bullet">${numbered[1]}.</span><span>${renderInline(numbered[2])}</span></div>`);
			continue;
		}
		const quote = /^\s*>[ \t]?(.*)$/.exec(line);
		if (quote) {
			out.push(`<div class="card-quote">${renderInline(quote[1])}</div>`);
			continue;
		}
		if (line.trim() === '') {
			out.push('<div class="card-gap"></div>');
			continue;
		}
		out.push(`<div class="card-p">${renderInline(line)}</div>`);
	}
	if (inFence && fenceLines.length) {
		out.push(`<pre class="card-code">${escapeHtml(fenceLines.join('\n'))}</pre>`);
	}
	return out.join('');
}
