/*
	Tabbing: all of LaTeX's `tabbing` environment, in a notation of its own
	with the LaTeX commands accepted alongside. Two forms, one body:

	  ```tabbing                         @begin(tabbing)
	  Name:     |= Street:    |= Phone   Name: \= Street: \= Phone \\
	  Alice     |> 12 Oak St  |> 555     Alice \> 12 Oak St \> 555 \\
	  ```                                @end(tabbing)

	One source line is one row (`\\` ends one too). A bar plus one character
	is a tab command, the character echoing LaTeX's:

	  |=  \=  set a stop here            |'  \'  the text so far, flush right
	  |>  \>  to the next stop                   before this column
	  |<  \<  (row start) back one stop  |`  \`  the rest, flush right
	  |+  \+  margin in for later rows   |[ |]   \pushtabs \poptabs
	  |-  \-  margin out                 …|kill  \kill: a RULER row, sets stops
	                                             and is not shown

	`\|` is a literal bar; marks are not read inside $…$ or `code`; `\a=`,
	`\a'`, `` \a` `` are the accents LaTeX's own commands took over.

	The layout is LaTeX's, from latex.ltx (lttab.dtx: \@settab, \@rtab,
	\@ltab, \@tabplus, \@tabminus, \@tablab, \@tabrj, \pushtabs, \kill):
	`layoutTabbing` below replays it over measured widths. A stop depends on
	the RENDERED width of the text before it, so the HTML is laid out in the
	browser, by measuring: tabbing-page.js for a page jmarkdown writes, Clew's
	own preview client in Clew. Before that, the pieces sit inline.

	Ported from Clew-app's src/engine/tabbing.js (@03bb33a), so the jmarkdown
	CLI, Clew's exports and Clew's reading view share ONE implementation: the
	HTML is byte-identical to Clew's (hence the `clew-tabbing` class). What
	this port changes, all in the LaTeX (tabbingLatex): an accent goes back to
	\a'{e}, since the parser writes it as a combining mark, which pdfLaTeX
	cannot typeset; and the environment ends with a blank line, as every
	block the engine writes does.

	NO IMPORTS, and it must keep none: Clew's preview client (a browser
	bundle) imports layoutTabbing from this module, and tabbing-page.js turns
	layoutTabbing into page script by its source text. So it does not
	register itself; index.js registers the fence (both marked instances, as
	a configured extension would be) and the environment.
*/

const MARK_OPS = { '=': 'set', '>': 'next', '<': 'back', '+': 'plus', '-': 'minus', "'": 'lab', '`': 'rj', '[': 'push', ']': 'pop' };
const COMMANDS = [
	['\\pushtabs', 'push'], ['\\poptabs', 'pop'], ['\\kill', 'kill'], ['\\\\', 'row'],
	['\\=', 'set'], ['\\>', 'next'], ['\\<', 'back'], ['\\+', 'plus'], ['\\-', 'minus'],
	["\\'", 'lab'], ['\\`', 'rj'],
];
const LATEX_OF = { set: '\\=', next: '\\>', back: '\\<', plus: '\\+', minus: '\\-', lab: "\\'", rj: '\\`', push: '\\pushtabs', pop: '\\poptabs' };
const ACCENTS = { '=': '̄', "'": '́', '`': '̀' };

/**
 * The body as rows: `{ kill, silent, items }`, each item `{ op: 'text', text }`
 * or `{ op }`. `kill` — a ruler row, sets stops and is not shown; `silent` —
 * only push/pop, nothing to show.
 *
 * Whitespace follows LaTeX's: ignored after a command, and a run of spaces is
 * one space — kept before `\=` (the stop lands after it, the way a space
 * typed before \= counts in TeX), dropped before any other command and at a
 * row's end, so source aligned with spaces sets nothing wider than a space.
 *
 * @param {string} body
 */
export function parseTabbing(body) {
	const rows = [];
	let items = [];
	let text = '';
	let kill = false;
	const flush = (nextOp) => {
		let t = text.replace(/\s+/g, ' ').replace(/^ /, '');
		if (nextOp !== 'set') t = t.replace(/ $/, '');
		if (t) items.push({ op: 'text', text: t });
		text = '';
	};
	const endRow = () => {
		flush(null);
		if (items.length || kill) {
			const shows = items.some((it) => it.op !== 'push' && it.op !== 'pop');
			rows.push({ kill, silent: !kill && !shows, items });
		}
		items = [];
		kill = false;
	};
	const op = (name) => {
		if (name === 'row') { endRow(); return; }
		if (name === 'kill') { kill = true; endRow(); return; }
		flush(name);
		items.push({ op: name });
	};
	const s = String(body ?? '');
	let i = 0;
	while (i < s.length) {
		const c = s[i];
		// $…$ and $$…$$: copied whole, marks and all.
		if (c === '$') {
			const fence = s.startsWith('$$', i) ? '$$' : '$';
			const end = s.indexOf(fence, i + fence.length);
			if (end > i) { text += s.slice(i, end + fence.length); i = end + fence.length; continue; }
		}
		// `code`: likewise (a backtick after | or \ is a command, handled below).
		if (c === '`') {
			const run = /^`+/.exec(s.slice(i))[0];
			const end = s.indexOf(run, i + run.length);
			if (end > i) { text += s.slice(i, end + run.length); i = end + run.length; continue; }
		}
		if (c === '\n') { endRow(); i += 1; continue; }
		if (c === '\\') {
			if (s[i + 1] === '|') { text += '|'; i += 2; continue; }
			// \a= \a' \a`: the accent on the next character (or {x}).
			const accent = /^\\a([='`])(?:\{(.)\}|(\S))/u.exec(s.slice(i));
			if (accent) {
				text += (accent[2] ?? accent[3]) + ACCENTS[accent[1]];
				i += accent[0].length;
				continue;
			}
			const hit = COMMANDS.find(([cmd]) => s.startsWith(cmd, i)
				&& !(/^[a-z]/i.test(cmd.slice(1)) && /[a-z]/i.test(s[i + cmd.length] ?? '')));
			if (hit) {
				i += hit[0].length;
				// \\[len]: the optional space after a row is not ours to keep.
				if (hit[1] === 'row' && s[i] === '[') { const close = s.indexOf(']', i); if (close > 0) i = close + 1; }
				op(hit[1]);
				continue;
			}
		}
		if (c === '|') {
			if (/^\|kill[ \t]*(?:\n|$)/.test(s.slice(i))) { kill = true; endRow(); i = s.indexOf('\n', i); if (i < 0) break; i += 1; continue; }
			const name = MARK_OPS[s[i + 1]];
			if (name) { op(name); i += 2; continue; }
		}
		text += c;
		i += 1;
	}
	endRow();
	return rows;
}

/**
 * LaTeX's layout, over measured widths: where each text item of each row
 * goes, in the container's coordinates (stop 0 is its left edge).
 *
 * @param {Array<{kill: boolean, items: Array<{op: string}>}>} rows
 * @param {(row: number, item: number) => number} width - a text item's width
 * @param {{ sep?: number, lineWidth?: number }} [opts] - \tabbingsep, \linewidth
 * @returns {Array<{ lefts: Map<number, number> }>} per row: item index → x
 */
export function layoutTabbing(rows, width, { sep = 8, lineWidth = Infinity } = {}) {
	let stops = [0];
	let high = 0;          // \@hightab: the highest stop defined
	let nextMargin = 0;    // \@nxttabmar
	const pushed = [];
	const out = [];
	rows.forEach((row, r) => {
		const lefts = new Map();
		// \@startline
		if (nextMargin > high) nextMargin = high;
		let margin = nextMargin;
		let cur = margin;
		let lineW = 0;        // \wd\@curline
		let field = [];       // the current field: [{ index, offset }]
		let fieldW = 0;
		let flushRight = false;
		const x0 = () => stops[margin] ?? 0;
		const addField = () => {   // \@addfield: the field joins the line where it stands
			for (const { index, offset } of field) lefts.set(index, x0() + lineW + offset);
			lineW += fieldW;
			field = [];
			fieldW = 0;
		};
		row.items.forEach((item, index) => {
			switch (item.op) {
			case 'text': {
				const w = width(r, index) || 0;
				field.push({ index, offset: fieldW });
				fieldW += w;
				break;
			}
			case 'set':          // \@settab
				addField();
				if (cur === high) high += 1;
				cur += 1;
				stops[cur] = x0() + lineW;
				break;
			case 'next':         // \@rtab: may move LEFT — TeX overprints
				addField();
				if (cur < high) cur += 1;
				lineW = (stops[cur] ?? 0) - x0();
				break;
			case 'back':         // \@ltab, only at the margin
				if (lineW === 0 && margin > 0) { cur -= 1; margin -= 1; }
				break;
			case 'plus': if (nextMargin < high) nextMargin += 1; break;
			case 'minus': if (nextMargin > 0) nextMargin -= 1; break;
			case 'lab':          // \@tablab: the field, ending sep before where it began
				for (const { index: i, offset } of field) lefts.set(i, x0() + lineW - fieldW - sep + offset);
				field = [];
				fieldW = 0;
				break;
			case 'rj':           // \@tabrj: what follows goes flush right
				addField();
				flushRight = true;
				break;
			case 'push': addField(); pushed.push({ stops: stops.slice(), high }); break;
			case 'pop': {
				addField();
				const saved = pushed.pop();
				if (saved) { stops = saved.stops; high = saved.high; if (cur > high) cur = high; }
				break;
			}
			default: break;
			}
		});
		// \@stopline
		if (flushRight && Number.isFinite(lineWidth)) {
			for (const { index, offset } of field) lefts.set(index, lineWidth - fieldW + offset);
		} else {
			addField();
		}
		out.push({ lefts });
	});
	return out;
}

// A short, stable key for a body: the preview keeps a laid-out block whose
// source has not changed across a re-render (preview-client/tabbing.js).
function keyOf(text) {
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

/** Queue each text item's inline markdown on the lexer (the renderers parse it). */
function lexCells(lexer, rows) {
	for (const row of rows) {
		for (const item of row.items) {
			if (item.op !== 'text') continue;
			item.tokens = [];
			lexer.inline(item.text, item.tokens);
		}
	}
}

/** The HTML: rows of pieces, each command a marker the preview's layout reads. */
export function tabbingHtml(rows, inline, key = '') {
	const body = rows.map((row) => {
		const cls = row.kill ? 'tb-row tb-kill' : row.silent ? 'tb-row tb-silent' : 'tb-row';
		const pieces = row.items.map((item) => (item.op === 'text'
			? `<span class="tb-t">${inline(item)}</span>`
			: `<span class="tb-op" data-op="${item.op}"></span>`)).join('');
		return `<div class="${cls}">${pieces}</div>`;
	}).join('');
	return `<div class="clew-tabbing" data-tabbing-key="${key}">${body}</div>\n`;
}

// \a= \a' \a` came out of the parser as combining marks (ACCENTS), which
// the HTML keeps. pdfLaTeX cannot typeset a combining mark, and inside tabbing
// \=, \' and \` are tab commands, so a marked letter goes back to the accent
// commands LaTeX's tabbing provides for exactly this.
const LATEX_ACCENT_OF = { '\u0304': '=', '\u0301': "'", '\u0300': '`' };
function latexAccents(tex) {
	return tex.replace(/(\p{L})([\u0300\u0301\u0304])/gu, (_, letter, mark) => `\\a${LATEX_ACCENT_OF[mark]}{${letter}}`);
}

/** The LaTeX: the environment itself, every mark its command. */
export function tabbingLatex(rows, inline) {
	// A push/pop row is not a line in LaTeX (`\\` after it would print an empty
	// one): its command just precedes the next row. Nor does the last shown
	// row end in `\\`.
	let lastShown = -1;
	rows.forEach((row, r) => { if (!row.silent) lastShown = r; });
	const lines = rows.map((row, r) => {
		const parts = row.items.map((item) => (item.op === 'text' ? latexAccents(inline(item)) : LATEX_OF[item.op]));
		const end = row.kill ? ' \\kill' : row.silent || r >= lastShown ? '' : ' \\\\';
		return parts.join(' ') + end;
	});
	// A blank line after, as every block the engine writes ends: the fence
	// consumed the one in the source, and without it the text that follows
	// would run on as the same paragraph.
	return `\\begin{tabbing}\n${lines.join('\n')}\n\\end{tabbing}\n\n`;
}

// ---- the engine surfaces --------------------------------------------------

// ```tabbing: the language must END at the fence line (```tabbingx is not ours).
const OPEN = /^```tabbing(?=[ \t]*\n)/m;
const WHOLE = /^```tabbing[ \t]*\n([\s\S]*?)\n```[ \t]*(?:\n+|$)/;

export const tabbingFence = {
	name: 'tabbingFence',
	level: 'block',
	start(src) { return src.match(OPEN)?.index; },
	tokenizer(src) {
		const match = WHOLE.exec(src);
		if (!match) return undefined;
		const rows = parseTabbing(match[1]);
		lexCells(this.lexer, rows);
		return { type: 'tabbingFence', raw: match[0], rows, key: keyOf(match[1]) };
	},
	renderer(token) {
		const inline = (item) => this.parser.parseInline(item.tokens ?? []);
		return global.isLatex ? tabbingLatex(token.rows, inline) : tabbingHtml(token.rows, inline, token.key);
	},
};

// @begin(tabbing) … @end(tabbing): the same body, as a named environment
// ('custom' mode keeps it raw and hands it to tokenize() in the lexer).
export const tabbing = {
	mode: 'custom',
	tokenize(body, token) {
		token.tabRows = parseTabbing(body);
		token.tabKey = keyOf(body);
		lexCells(this.lexer, token.tabRows);
	},
	html(ctx) {
		const rows = ctx.token?.tabRows ?? parseTabbing(ctx.rawText ?? '');
		return tabbingHtml(rows, (item) => ctx.parser.parseInline(item.tokens ?? []), ctx.token?.tabKey ?? '');
	},
	latex(ctx) {
		const rows = ctx.token?.tabRows ?? parseTabbing(ctx.rawText ?? '');
		return tabbingLatex(rows, (item) => ctx.parser.parseInline(item.tokens ?? []));
	},
};
