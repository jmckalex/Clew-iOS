// Formatting commands: the implementation behind the Format menu
// (src/shared/format-spec.js declares the structure; every item here is a
// registry command, so the palette and the hotkey editor see them all).
// Everything operates on the active tab's live editor via the pool.
import { EditorSelection } from '@codemirror/state';
import { startCompletion } from '@codemirror/autocomplete';
import { registerCommand, buildContext } from './registry.js';
import { editorPool } from '../editor/pool.js';

export const needsEditor = (ctx) =>
	ctx.notePath !== null && ctx.activeTab?.view?.mode !== 'reading';

export function activeEditorView() {
	const ctx = buildContext();
	return editorPool.get(ctx.activeTab?.id)?.view ?? null;
}

// ---- inline helpers --------------------------------------------------------

/** Wrap each selection range in marker pairs, or unwrap when already wrapped
 *  (markers just outside the range, or included in it). */
export function toggleWrap(view, before, after = before) {
	const { state } = view;
	const changes = state.changeByRange((range) => {
		const { from, to } = range;
		const outerBefore = state.sliceDoc(Math.max(0, from - before.length), from);
		const outerAfter = state.sliceDoc(to, Math.min(state.doc.length, to + after.length));
		const inner = state.sliceDoc(from, to);
		if (outerBefore === before && outerAfter === after) {
			return {
				changes: [
					{ from: from - before.length, to: from },
					{ from: to, to: to + after.length },
				],
				range: EditorSelection.range(from - before.length, to - before.length),
			};
		}
		if (inner.length >= before.length + after.length
			&& inner.startsWith(before) && inner.endsWith(after)) {
			return {
				changes: [
					{ from, to: from + before.length },
					{ from: to - after.length, to },
				],
				range: EditorSelection.range(from, to - before.length - after.length),
			};
		}
		return {
			changes: [
				{ from, insert: before },
				{ from: to, insert: after },
			],
			range: EditorSelection.range(from + before.length, to + before.length),
		};
	});
	view.dispatch(changes);
	view.focus();
}

/** Insert before+content+after at the selection; the content (selection or
 *  placeholder) ends up selected so it can be typed over. */
function insertInline(view, before, after, placeholder = '') {
	const range = view.state.selection.main;
	const inner = range.empty ? placeholder : view.state.sliceDoc(range.from, range.to);
	view.dispatch({
		changes: { from: range.from, to: range.to, insert: before + inner + after },
		selection: EditorSelection.range(
			range.from + before.length,
			range.from + before.length + inner.length,
		),
	});
	view.focus();
}

/** Wrap the selection as [[selection]] (cursor before ]]), or insert empty
 *  brackets and pop the wikilink completion. */
export function insertWikilink(view) {
	const range = view.state.selection.main;
	const text = view.state.sliceDoc(range.from, range.to);
	view.dispatch({
		changes: { from: range.from, to: range.to, insert: `[[${text}]]` },
		selection: { anchor: range.from + 2 + text.length },
	});
	view.focus();
	if (!text) startCompletion(view);
}

// ---- line helpers ----------------------------------------------------------

function selectedLines(state) {
	const { from, to } = state.selection.main;
	const first = state.doc.lineAt(from).number;
	const last = state.doc.lineAt(to).number;
	const lines = [];
	for (let n = first; n <= last; n++) lines.push(state.doc.line(n));
	return lines;
}

/** Replace each selected line's text via mapFn; selection covers the result
 *  (end position accounts for the length deltas of every earlier line). */
function changeLines(view, mapFn) {
	const lines = selectedLines(view.state);
	const mapped = lines.map((line, i) => mapFn(line.text, i));
	const changes = lines.map((line, i) => ({ from: line.from, to: line.to, insert: mapped[i] }));
	let delta = 0;
	for (let i = 0; i < lines.length - 1; i++) delta += mapped[i].length - lines[i].text.length;
	view.dispatch({
		changes,
		selection: EditorSelection.range(
			lines[0].from,
			lines.at(-1).from + delta + mapped.at(-1).length,
		),
	});
	view.focus();
}

const BLOCK_PREFIX_RE = /^(\s*)(?:[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d+[.)][ \t]+|>[ \t]+)/;
const stripPrefix = (text) => text.replace(BLOCK_PREFIX_RE, '$1');

/** Toggle a list/quote prefix on the selected lines. */
function toggleLinePrefix(view, kind) {
	const detect = {
		bullet: /^\s*[-*+][ \t]+(?!\[)/,
		task: /^\s*[-*+][ \t]+\[[ xX]\][ \t]/,
		numbered: /^\s*\d+[.)][ \t]/,
		quote: /^\s*>[ \t]/,
	}[kind];
	const lines = selectedLines(view.state).map((l) => l.text);
	const allAlready = lines.every((t) => t.trim() === '' || detect.test(t));
	changeLines(view, (text, i) => {
		if (text.trim() === '') return text;
		const stripped = stripPrefix(text);
		if (allAlready) return stripped;
		const indent = /^\s*/.exec(stripped)[0];
		const body = stripped.slice(indent.length);
		const prefix = kind === 'bullet' ? '- '
			: kind === 'task' ? '- [ ] '
			: kind === 'numbered' ? `${i + 1}. `
			: '> ';
		return indent + prefix + body;
	});
}

function setHeading(view, level) {
	changeLines(view, (text) => {
		const body = text.replace(/^\s*#{1,6}[ \t]+/, '');
		return level === 0 ? body : '#'.repeat(level) + ' ' + body;
	});
}

// Alignment (jmarkdown): ">> text <<" centers, ">> text" right-aligns.
const CENTER_RE = /^>> ?(.*?) ?<<\s*$/;
const RIGHT_RE = /^>> ?(.*)$/;
const stripAlign = (text) => {
	const center = CENTER_RE.exec(text);
	if (center) return center[1];
	const right = RIGHT_RE.exec(text);
	if (right && !/<<\s*$/.test(text)) return right[1];
	return text;
};

function toggleAlign(view, kind) {
	const lines = selectedLines(view.state).map((l) => l.text);
	const detect = kind === 'center'
		? (t) => CENTER_RE.test(t)
		: (t) => RIGHT_RE.test(t) && !/<<\s*$/.test(t);
	const allAlready = lines.every((t) => t.trim() === '' || detect(t));
	changeLines(view, (text) => {
		if (text.trim() === '') return text;
		const body = stripAlign(text);
		if (allAlready || kind === 'clear') return body;
		return kind === 'center' ? `>> ${body} <<` : `>> ${body}`;
	});
}

function wrapAlert(view, type) {
	const range = view.state.selection.main;
	if (range.empty) {
		insertBlock(view, `> [!${type}]\n> Alert text`, 'Alert text');
		return;
	}
	changeLines(view, (text, i) => {
		const line = `> ${stripPrefix(text)}`;
		return i === 0 ? `> [!${type}]\n${line}` : line;
	});
}

// ---- block insertion -------------------------------------------------------

/** Insert a block at the cursor on its own lines (blank-line padded), and
 *  select `placeholder` inside it when given. */
function insertBlock(view, text, placeholder = null) {
	const { state } = view;
	const range = state.selection.main;
	const line = state.doc.lineAt(range.from);
	const before = line.text.trim() === '' ? '' : '\n\n';
	const atEnd = range.to >= state.doc.length;
	const nextLine = !atEnd && state.doc.lineAt(range.to).number < state.doc.lines
		? state.doc.line(state.doc.lineAt(range.to).number + 1).text
		: '';
	const after = nextLine.trim() === '' ? '\n' : '\n\n';
	const insert = before + text + after;
	const base = range.from + before.length;
	const at = placeholder ? text.indexOf(placeholder) : -1;
	view.dispatch({
		changes: { from: range.from, to: range.to, insert },
		selection: at !== -1
			? EditorSelection.range(base + at, base + at + placeholder.length)
			: { anchor: base + text.length },
	});
	view.focus();
}

/** Wrap the selection (or a placeholder) in a container fence. */
function wrapContainer(view, header, footer = ':::', placeholder = 'Content') {
	const range = view.state.selection.main;
	if (range.empty) {
		insertBlock(view, `${header}\n${placeholder}\n${footer}`, placeholder);
		return;
	}
	const selection = view.state.sliceDoc(range.from, range.to);
	insertBlock(view, `${header}\n${selection}\n${footer}`);
}

function insertTable(view, rows, cols) {
	const cells = (fill) => '|' + Array(cols).fill(fill).join('|') + '|';
	const header = '|' + Array.from({ length: cols }, (_, i) => ` Col ${i + 1} `).join('|') + '|';
	const lines = [header, cells('-------'), ...Array(rows).fill(cells('       '))];
	insertBlock(view, lines.join('\n'), ' Col 1 ');
}

/** Insert an empty row below the current table row. */
function insertTableRow(view) {
	const { state } = view;
	const line = state.doc.lineAt(state.selection.main.from);
	const cellCount = (line.text.match(/\|/g) ?? []).length - 1;
	if (!line.text.trim().startsWith('|') || cellCount < 1) return;
	const row = '|' + Array(cellCount).fill('   ').join('|') + '|';
	view.dispatch({
		changes: { from: line.to, insert: '\n' + row },
		selection: { anchor: line.to + 3 },
	});
	view.focus();
}

// ---- the commands ----------------------------------------------------------

export function registerFormatCommands() {
	const run = (fn) => () => {
		const view = activeEditorView();
		if (view) fn(view);
	};
	const commands = [
		// Inline styles (legacy edit:* ids kept for existing rebindings).
		{ id: 'edit:format-strong', name: 'Format: strong (*text*)', fn: (v) => toggleWrap(v, '*') },
		{ id: 'edit:format-intense', name: 'Format: intense (**text**)', fn: (v) => toggleWrap(v, '**') },
		{ id: 'edit:format-italic', name: 'Format: italic (/text/)', fn: (v) => toggleWrap(v, '/') },
		{ id: 'format:underline', name: 'Format: underline (__text__)', fn: (v) => toggleWrap(v, '__') },
		{ id: 'edit:format-highlight', name: 'Format: highlight (==text==)', fn: (v) => toggleWrap(v, '==') },
		{ id: 'edit:format-strike', name: 'Format: strikethrough (~text~)', fn: (v) => toggleWrap(v, '~') },
		{ id: 'format:subscript', name: 'Format: subscript (_{text})', fn: (v) => toggleWrap(v, '_{', '}') },
		{ id: 'format:superscript', name: 'Format: superscript (^{text})', fn: (v) => toggleWrap(v, '^{', '}') },
		{ id: 'edit:format-code', name: 'Format: inline code', fn: (v) => toggleWrap(v, '`') },
		{ id: 'edit:format-math', name: 'Format: inline math ($x$)', fn: (v) => toggleWrap(v, '$') },

		// Headings.
		...[1, 2, 3, 4, 5, 6].map((level) => ({
			id: `format:heading-${level}`, name: `Format: heading ${level}`,
			fn: (v) => setHeading(v, level),
		})),
		{ id: 'format:heading-clear', name: 'Format: clear heading', fn: (v) => setHeading(v, 0) },

		// Paragraph.
		{ id: 'format:bullet-list', name: 'Format: bullet list', fn: (v) => toggleLinePrefix(v, 'bullet') },
		{ id: 'format:numbered-list', name: 'Format: numbered list', fn: (v) => toggleLinePrefix(v, 'numbered') },
		{ id: 'format:task-list', name: 'Format: task list', fn: (v) => toggleLinePrefix(v, 'task') },
		{ id: 'format:blockquote', name: 'Format: blockquote', fn: (v) => toggleLinePrefix(v, 'quote') },
		{ id: 'format:description-list', name: 'Insert description list',
			fn: (v) => insertBlock(v, 'Term\n: Definition of the term.', 'Term') },
		{ id: 'format:horizontal-rule', name: 'Insert horizontal rule', fn: (v) => insertBlock(v, '---') },

		// Alignment.
		{ id: 'format:align-center', name: 'Format: center (>> text <<)', fn: (v) => toggleAlign(v, 'center') },
		{ id: 'format:align-right', name: 'Format: right-align (>> text)', fn: (v) => toggleAlign(v, 'right') },
		{ id: 'format:align-clear', name: 'Format: clear alignment', fn: (v) => toggleAlign(v, 'clear') },

		// Alerts.
		...['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'].map((type) => ({
			id: `format:alert-${type.toLowerCase()}`, name: `Insert ${type.toLowerCase()} alert`,
			fn: (v) => wrapAlert(v, type),
		})),

		// Tables.
		{ id: 'format:table-2', name: 'Insert table (2×2)', fn: (v) => insertTable(v, 2, 2) },
		{ id: 'format:table-3', name: 'Insert table (3×3)', fn: (v) => insertTable(v, 3, 3) },
		{ id: 'format:table-4', name: 'Insert table (4 rows × 3 columns)', fn: (v) => insertTable(v, 4, 3) },
		{ id: 'format:table-row', name: 'Insert table row below', fn: (v) => insertTableRow(v) },

		// Insert.
		{ id: 'edit:insert-wikilink', name: 'Insert wikilink', hotkeys: ['Mod-k'], fn: (v) => insertWikilink(v) },
		{ id: 'format:footnote', name: 'Insert footnote ([fn: …])',
			fn: (v) => insertInline(v, '[fn: ', ']', 'Footnote text') },
		{ id: 'format:citation', name: 'Insert citation (\\cite{…})',
			fn: (v) => { insertInline(v, '\\cite{', '}'); startCompletion(v); } },
		{ id: 'format:label', name: 'Insert label (:label[key])',
			fn: (v) => insertInline(v, ':label[', ']', 'key') },
		{ id: 'format:reference', name: 'Insert reference (:ref[key])',
			fn: (v) => insertInline(v, ':ref[', ']', 'key') },
		{ id: 'format:toc', name: 'Insert table of contents ({{TOC}})', fn: (v) => insertBlock(v, '{{TOC}}') },
		{ id: 'format:today', name: "Insert today's date (:today)", fn: (v) => insertInline(v, ':today', '') },

		// Blocks.
		{ id: 'format:code-fence', name: 'Insert code fence',
			fn: (v) => wrapContainer(v, '```', '```', 'code') },
		{ id: 'format:math-block', name: 'Insert math block ($$…$$)',
			fn: (v) => wrapContainer(v, '$$', '$$', 'e = mc^2') },
		{ id: 'format:mermaid', name: 'Insert mermaid diagram',
			fn: (v) => wrapContainer(v, ':::mermaid', ':::', 'graph LR\n  A --> B') },
		{ id: 'format:tikz', name: 'Insert TiKZ diagram',
			fn: (v) => wrapContainer(v, ':::TiKZ', ':::',
				'\\begin{tikzpicture}\n  \\draw (0,0) -- (1,1);\n\\end{tikzpicture}') },
		{ id: 'format:mathematica', name: 'Insert Mathematica block',
			fn: (v) => wrapContainer(v, ':::Mathematica{output="svg"}', ':::', 'Plot[Sin[x], {x, 0, 2 Pi}]') },
		{ id: 'format:game', name: 'Insert game matrix (:::game)',
			fn: (v) => wrapContainer(v, ':::game', ':::',
				'       | Cooperate | Defect\n-------+-----------+--------\nCooperate | 3, 3   | 0, 5\nDefect    | 5, 0   | 1, 1') },
		{ id: 'format:markdown-demo', name: 'Insert markdown demo block',
			fn: (v) => wrapContainer(v, ':::markdown-demo', ':::', 'This is *some* /text/.') },
		{ id: 'format:tex-block', name: 'Insert LaTeX-only block (:::TeX)',
			fn: (v) => wrapContainer(v, ':::TeX', ':::', '% LaTeX-only content (verbatim)') },
		{ id: 'format:html-block', name: 'Insert HTML-only block (:::HTML)',
			fn: (v) => wrapContainer(v, ':::HTML', ':::', 'Web-only content (markdown processed)') },
		{ id: 'format:abstract', name: 'Insert abstract block',
			fn: (v) => wrapContainer(v, ':::abstract', ':::', 'Abstract text.') },
		{ id: 'format:title-box', name: 'Insert title box',
			fn: (v) => wrapContainer(v, ':::title-box', ':::', 'Title\n***\nBody text.') },
		{ id: 'format:comment', name: 'Insert comment block (omitted from output)',
			fn: (v) => wrapContainer(v, ':::comment', ':::', 'Editorial note.') },
		{ id: 'format:container', name: 'Insert generic container (:::name)',
			fn: (v) => wrapContainer(v, ':::name', ':::', 'Content') },
	];

	for (const { id, name, hotkeys, fn } of commands) {
		registerCommand({ id, name, hotkeys, when: needsEditor, run: run(fn) });
	}
}
