// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The live-edit construct model: ONE ordered list of everything live edit
// conceals or renders in a document, built from the lezer tree (markdown's
// own constructs, plus the dialect nodes jmd/*-parser.js add) and the
// dialect scanner's `constructs` (jmd/scan-cache.js). Both decoration
// providers — the block field and the inline layer — read this list, so
// they can never disagree about where a construct is.
//
// Each record:
//
//   { id, kind, tier, level, from, to, lineFrom, lineTo,
//     hidden: [{from,to}],      delimiter ranges a concealed view hides
//     extents: [{from,to}],     what a selection must touch to REVEAL it
//     lineExtents: [{from,to}], the same, widened to whole lines
//     ...kind-specific }
//
// `tier`: 'A' decorations, 'B' renderer-built widgets (tables, images),
// 'C' engine-rendered frames. `level`: 'inline' | 'line' | 'block' — how
// much a construct reveals (plan §4.5). `lineFrom`/`lineTo` are OFFSETS:
// the start of its first line and the end of its last.
//
// The extents are where the plan's reveal rules live, so reveal.js stays a
// range test: an inline construct reveals when touched; a heading, list
// marker, quote marker or callout head when its LINE is touched; a block
// (display math, table, frame, frontmatter, hr, TOC) anywhere in it; and a
// directive or environment only on its opener or closer line — its body is
// ordinary markdown, and typing in it must keep the frame around it.
//
// Where the tree and the scanner both know a construct (math, footnotes)
// the SCANNER's record is used: it carries the delimiters and parts, and
// the grammar claims exactly the scanner's segments (math-parser.js,
// footnote-parser.js), so the positions are the same by construction.
//
// Pure: no DOM, no view. Memoised per document version.
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import { scanFor } from '../jmd/scan-cache.js';
import { LITERAL_DIRECTIVES } from '../jmd/jmarkdown-scan.js';
import { MATH_ENVIRONMENT_NAMES } from '../jmd/math-segments.js';
import { resolveType, calloutGeneration } from '#jmarkdown/callout-table.js';
import { IMAGE_EXT } from '../../../shared/file-types.js';
import { headerlessTables } from '../tables.js';
import {
	isRichFence, RICH_DIRECTIVES, RICH_ENVIRONMENTS, RICH_HTML,
} from './rich-fences.js';

/** @typedef {{from: number, to: number}} Range */

const MATH_ENVS = new Set(MATH_ENVIRONMENT_NAMES);
const isMathEnv = (name) => MATH_ENVS.has(name.replace(/\*$/, ''));

/** The engine's callout opener (jmarkdown's callouts.js), after the `>`s. */
const CALLOUT_HEAD = /^[ \t]*\[!([A-Za-z][\w-]*)\][ \t]*([+-]?)[ \t]*(.*)$/;
/** The engine's alignment rules (syntax-enhancements.js). */
const ALIGN_CENTER = /^>> .*<<\s*$/;
const ALIGN_RIGHT = /^>>/;
/** A description-list term: `Term:: definition` (the engine's form). */
const TERM = /^([^\s:>|#-][^:\n]*?)::(?:\s|$)/;

/** @type {WeakMap<object, {key: string, tree: object, list: object[]}>} */
const cache = new WeakMap();

/**
 * The constructs of this document version.
 *
 * @param {import('@codemirror/state').EditorState} state
 * @param {{ normalSyntax?: boolean, richFences?: string[] }} [config]
 * @returns {object[]}
 */
export function liveModel(state, config = {}) {
	const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
	// The callout table is part of the key: a type defined in Settings
	// (the engine's callout-table.js#applyCustomCallouts) changes what `[!x]` is.
	const key = `${config.normalSyntax === true}|${(config.richFences ?? []).join(',')}|${calloutGeneration()}`;
	const hit = cache.get(state.doc);
	if (hit && hit.tree === tree && hit.key === key) return hit.list;
	const list = build(state.doc, tree, config);
	cache.set(state.doc, { key, tree, list });
	return list;
}

function build(doc, tree, config) {
	const normal = config.normalSyntax === true;
	const richFences = config.richFences ?? [];
	const out = [];
	const text = (a, b) => doc.sliceString(a, b);
	const lineOf = (pos) => doc.lineAt(pos);

	/** Push a construct; `extents` default from its level. */
	const add = (kind, tier, level, from, to, extra = {}) => {
		const lineFrom = lineOf(from).from;
		const lineTo = lineOf(Math.max(from, to)).to;
		const c = { kind, tier, level, from, to, lineFrom, lineTo, hidden: [], ...extra };
		if (!c.extents) {
			c.extents = level === 'inline'
				? [{ from, to }]
				: [{ from: lineFrom, to: lineTo }];
		}
		c.lineExtents = c.extents.map((e) => ({ from: lineOf(e.from).from, to: lineOf(e.to).to }));
		out.push(c);
		return c;
	};
	const lineRange = (pos) => { const l = lineOf(pos); return { from: l.from, to: l.to }; };
	/** Alone on its line(s): nothing but whitespace around it. */
	const alone = (from, to) =>
		text(lineOf(from).from, from).trim() === '' && text(to, lineOf(to).to).trim() === '';

	// ---- the scanner's constructs: blocks first (they make opaque ranges) --
	const scan = scanFor(doc);
	/** Ranges whose inside is not markdown for live edit's purposes. */
	const opaque = [];
	const inOpaque = (pos) => opaque.some((r) => pos >= r.from && pos < r.to);

	for (const s of scan.constructs) {
		switch (s.kind) {
			case 'metaHeader':
				add('frontmatter', 'A', 'block', s.start, s.end, { body: s.body, closed: Boolean(s.close) });
				opaque.push({ from: s.start, to: s.end });
				break;
			case 'directiveBlock': {
				const name = s.name ? text(s.name.start, s.name.end) : '';
				const open = lineRange(s.start);
				const close = s.close ? lineRange(s.close.start) : null;
				if (RICH_DIRECTIVES.has(name)) {
					add('richBlock', 'C', 'block', s.start, s.end, { source: 'directive', name });
					opaque.push({ from: s.start, to: s.end });
				} else {
					add('directive', 'A', 'line', s.start, s.end, {
						name, colons: s.colons, body: s.body, content: s.content, attrs: s.attrs,
						openLine: open, closeLine: close,
						texOnly: name === 'TeX', htmlOnly: name === 'HTML', comment: name === 'comment',
						extents: close ? [open, close] : [open],
					});
					// Raw TeX / raw HTML bodies are not markdown.
					if (name === 'TeX' || name === 'HTML') opaque.push({ from: s.body.start, to: s.body.end });
				}
				break;
			}
			case 'environment': {
				const name = text(s.name.start, s.name.end);
				const open = lineRange(s.start);
				const close = s.close ? lineRange(s.close.start) : null;
				if (RICH_ENVIRONMENTS.has(name)) {
					add('richBlock', 'C', 'block', s.start, s.end, { source: 'environment', name });
					opaque.push({ from: s.start, to: s.end });
				} else if (isMathEnv(name)) {
					add('math', 'A', 'block', s.start, s.end, {
						display: true, env: name, body: s.body, environment: true,
						hidden: [{ from: s.start, to: s.end }],
					});
					opaque.push({ from: s.start, to: s.end });
				} else {
					add('environment', 'A', 'line', s.start, s.end, {
						name, body: s.body, content: s.content, attrs: s.attrs,
						openLine: open, closeLine: close, texOnly: name === 'TeX',
						extents: close ? [open, close] : [open],
					});
					if (name === 'TeX') opaque.push({ from: s.start, to: s.end });
				}
				break;
			}
			case 'htmlBlock':
			case 'scriptBlock':
			case 'styleBlock': {
				const rich = s.kind === 'htmlBlock' && RICH_HTML.test(text(s.start, s.end));
				add(rich ? 'richBlock' : 'html', rich ? 'C' : 'A', 'block', s.start, s.end,
					{ source: s.kind });
				opaque.push({ from: s.start, to: s.end });
				break;
			}
			default:
		}
	}

	// ---- the tree ----------------------------------------------------------
	const quoteLines = new Map(); // line.from → {marks: Range[], depth, callout}
	const bareUrls = [];
	tree.iterate({
		enter(ref) {
			const { name, from, to } = ref;
			if (name === 'Document') return;
			if (inOpaque(from)) return false;
			const node = ref.node;
			switch (name) {
				case 'ATXHeading1': case 'ATXHeading2': case 'ATXHeading3':
				case 'ATXHeading4': case 'ATXHeading5': case 'ATXHeading6': {
					const marks = childrenNamed(node, 'HeaderMark');
					const hidden = [];
					if (marks[0]) hidden.push({ from: marks[0].from, to: skipSpace(doc, marks[0].to, to) });
					if (marks.length > 1) {
						const last = marks[marks.length - 1];
						hidden.push({ from: backSpace(doc, last.from, from), to: last.to });
					}
					add('heading', 'A', 'line', from, to, { depth: Number(name.slice(-1)), hidden });
					return;
				}
				case 'Emphasis':
				case 'StrongEmphasis': {
					const marks = childrenNamed(node, 'EmphasisMark');
					const ch = text(from, from + 1);
					let kind;
					if (normal) kind = name === 'Emphasis' ? 'italic' : 'strong';
					else if (name === 'Emphasis') kind = ch === '*' ? 'strong' : 'italic';
					else kind = ch === '*' ? 'intense' : 'underline';
					add(kind, 'A', 'inline', from, to, { hidden: marks.map(rangeOf) });
					return;
				}
				case 'Strikethrough':
					add('strike', 'A', 'inline', from, to, { hidden: childrenNamed(node, 'StrikethroughMark').map(rangeOf) });
					return;
				case 'Subscript':
					// `~x~`: strikethrough to the engine (marked's GFM `del`),
					// a subscript only under standard markdown.
					add(normal ? 'sub' : 'strike', 'A', 'inline', from, to,
						{ hidden: childrenNamed(node, 'SubscriptMark').map(rangeOf) });
					return;
				case 'Superscript':
					add('sup', 'A', 'inline', from, to, { hidden: childrenNamed(node, 'SuperscriptMark').map(rangeOf) });
					return;
				case 'JmdSubscript':
				case 'JmdSuperscript':
					add(name === 'JmdSubscript' ? 'sub' : 'sup', 'A', 'inline', from, to,
						{ hidden: childrenNamed(node, 'JmdSubSupMark').map(rangeOf) });
					return false;
				case 'JmdBlockId':
					add('blockId', 'A', 'line', from, to, {
						id: text(from + 1, to), hidden: [{ from: backSpace(doc, from, lineOf(from).from), to }],
					});
					return false;
				case 'InlineCode':
					add('code', 'A', 'inline', from, to, { hidden: childrenNamed(node, 'CodeMark').map(rangeOf) });
					return false;
				case 'Escape':
					add('escape', 'A', 'inline', from, to, { hidden: [{ from, to: from + 1 }] });
					return false;
				case 'HardBreak':
					if (text(from, from + 1) === '\\') add('hardBreak', 'A', 'inline', from, to, { hidden: [{ from, to: from + 1 }] });
					return false;
				case 'Autolink': {
					const marks = childrenNamed(node, 'LinkMark');
					const url = childrenNamed(node, 'URL')[0];
					add('autolink', 'A', 'inline', from, to, {
						url: url ? text(url.from, url.to) : '', hidden: marks.map(rangeOf),
					});
					return false;
				}
				case 'URL': {
					// A BARE URL or address (GFM's autolink extension, and
					// jmd/ftp-autolink.js for ftp://). The engine links them
					// too since jmarkdown 3134543. A URL inside a link, image
					// or <autolink> is theirs.
					const parent = node.parent?.name;
					if (parent !== 'Link' && parent !== 'Image' && parent !== 'Autolink' && parent !== 'LinkReference') {
						bareUrls.push({ from, to });
					}
					return false;
				}
				case 'Link':
				case 'Image': {
					const marks = childrenNamed(node, 'LinkMark');
					const url = childrenNamed(node, 'URL')[0];
					// Only an inline link with a destination: a bare `[x]` is a
					// shortcut reference lezer builds whether or not it is defined.
					const paren = marks.find((m) => text(m.from, m.to) === '(');
					if (!url || !paren || marks.length < 2) return;
					const close = marks.find((m) => text(m.from, m.to) === ']');
					if (!close) return;
					const label = { from: marks[0].to, to: close.from };
					if (name === 'Link') {
						add('link', 'A', 'inline', from, to, {
							url: text(url.from, url.to), label,
							hidden: [rangeOf(marks[0]), { from: close.from, to }],
						});
					} else {
						const block = alone(from, to);
						add('image', 'B', block ? 'block' : 'inline', from, to, {
							src: text(url.from, url.to), alt: text(label.from, label.to), markdown: true,
							hidden: [{ from, to }],
						});
						return false;
					}
					return;
				}
				case 'FencedCode': {
					const marks = childrenNamed(node, 'CodeMark');
					const info = childrenNamed(node, 'CodeInfo')[0];
					const infoText = info ? text(info.from, info.to) : '';
					const lang = (/^[^\s{]+/.exec(infoText) ?? [''])[0];
					const closeMark = marks.length > 1 ? marks[marks.length - 1] : null;
					if (isRichFence(lang, richFences)) {
						add('richBlock', 'C', 'block', from, to, { source: 'fence', name: lang, info: infoText });
					} else {
						const open = lineRange(from);
						const close = closeMark ? lineRange(closeMark.from) : null;
						add('codeFence', 'A', 'line', from, to, {
							lang, info: infoText, openLine: open, closeLine: close,
							body: { from: Math.min(open.to + 1, to), to: close ? Math.max(close.from - 1, open.to + 1) : to },
							extents: close ? [open, close] : [open],
						});
					}
					return false;
				}
				case 'HorizontalRule':
					add('hr', 'A', 'block', from, to, { hidden: [{ from, to }] });
					return false;
				case 'Table':
					add('table', 'B', 'block', from, to, { hidden: [{ from, to }] });
					return; // cells hold inline constructs the widget renders
				case 'HTMLBlock':
				case 'CommentBlock':
				case 'ProcessingInstructionBlock':
					return false; // the scanner's html constructs cover these
				case 'Blockquote':
					quote(node, ref);
					return;
				case 'ListItem':
					listItem(node);
					return;
				case 'Paragraph':
					terms(from, to);
					if (!ancestors(node, 'Blockquote')) pipeTables(from, to);
					return;
				default:
			}
		},
	});

	// ---- quotes, callouts and alignment: one line construct per marker line
	function quote(node) {
		const depth = ancestors(node, 'Blockquote') + 1;
		const first = lineOf(node.from);
		// A callout is decided on the blockquote's first line, after this
		// blockquote's own `>`s.
		if (!ALIGN_RIGHT.test(first.text)) {
			const afterMarks = stripQuotes(first.text, depth);
			const m = afterMarks && CALLOUT_HEAD.exec(afterMarks.rest);
			// As the engine's tokenizer reads it: a type known by name or alias,
			// else an UNKNOWN type — drawn as a note (pencil, note's colour),
			// titled with its name (jmarkdown a7de8c6, Obsidian's behaviour).
			const type = m && (resolveType(m[1]) ?? m[1].toLowerCase());
			if (type) {
				const headFrom = first.from + afterMarks.offset + (afterMarks.rest.length - afterMarks.rest.trimStart().length);
				const titleFrom = first.to - m[3].length;
				const last = lineOf(node.to);
				const body = last.number > first.number
					? { from: doc.line(first.number + 1).from, to: last.to } : null;
				add('callout', 'A', 'line', first.from, first.to, {
					type, rawType: m[1], fold: m[2], depth,
					title: m[3].trim() ? { from: titleFrom, to: first.to } : null,
					block: { from: node.from, to: node.to }, body,
					hidden: [{ from: headFrom, to: titleFrom }],
				});
				for (let n = first.number; n <= last.number; n += 1) {
					const entry = quoteLine(doc.line(n).from);
					entry.callout = type;
					// Its box's top and bottom (padding, corners), on each line's
					// own record — a line in view knows without its head in view.
					entry.calloutFirst = n === first.number;
					entry.calloutLast = n === last.number;
				}
			}
		}
		// The outermost blockquote collects every marker, nested ones
		// included — the tree visits the nested nodes too, for callouts.
		if (depth > 1) return;
		for (const mark of descendantsNamed(node, 'QuoteMark')) {
			quoteLine(lineOf(mark.from).from).marks.push(mark);
		}
	}
	function quoteLine(from) {
		let entry = quoteLines.get(from);
		if (!entry) quoteLines.set(from, (entry = { marks: [], callout: null }));
		return entry;
	}

	function listItem(node) {
		const list = node.parent;
		const depth = ancestors(node, 'BulletList') + ancestors(node, 'OrderedList');
		const mark = childrenNamed(node, 'ListMark')[0];
		if (!mark) return;
		const task = childrenNamed(node, 'Task')[0];
		const taskMarker = task ? childrenNamed(task, 'TaskMarker')[0] : null;
		const first = lineRange(node.from);
		if (taskMarker) {
			const checked = /\[[xX]\]/.test(text(taskMarker.from, taskMarker.to));
			add('task', 'A', 'line', mark.from, node.to, {
				depth, checked, marker: rangeOf(taskMarker), listMark: rangeOf(mark),
				hidden: [{ from: mark.from, to: skipSpace(doc, mark.to, first.to) }],
				extents: [first],
			});
		} else if (list?.name === 'OrderedList') {
			add('numbered', 'A', 'line', mark.from, node.to, {
				depth, listMark: rangeOf(mark), number: text(mark.from, mark.to), extents: [first],
			});
		} else {
			add('bullet', 'A', 'line', mark.from, node.to, {
				depth, listMark: rangeOf(mark),
				hidden: [{ from: mark.from, to: skipSpace(doc, mark.to, first.to) }],
				extents: [first],
			});
		}
	}

	function terms(from, to) {
		for (let n = lineOf(from).number; n <= lineOf(to).number; n += 1) {
			const line = doc.line(n);
			const m = TERM.exec(line.text);
			if (m) add('term', 'A', 'line', line.from, line.to, { term: { from: line.from, to: line.from + m[1].length } });
		}
	}

	// The engine's headerless tables (tables.js#headerlessTables): lezer
	// knows only GFM's, so these arrive as paragraph lines. A line the
	// paragraph starts partway along (after a list marker) holds no row.
	function pipeTables(from, to) {
		const first = lineOf(from).number;
		const lines = [];
		for (let n = first; n <= lineOf(to).number; n += 1) {
			const line = doc.line(n);
			lines.push(line.from >= from || text(line.from, from).trim() === '' ? line : null);
		}
		for (const t of headerlessTables(lines.map((l) => l?.text ?? null))) {
			const a = lines[t.first].from;
			const b = lines[t.last].to;
			add('table', 'B', 'block', a, b, { hidden: [{ from: a, to: b }], headerless: t.form });
		}
	}

	// Quote/alignment lines, now that every blockquote has been seen.
	for (const [from, entry] of quoteLines) {
		const line = lineOf(from);
		if (ALIGN_RIGHT.test(line.text) && !inOpaque(from)) {
			const center = ALIGN_CENTER.test(line.text);
			const hidden = [{ from, to: from + (/^>> ?/.exec(line.text)[0].length) }];
			if (center) {
				const tail = /\s*<<\s*$/.exec(line.text);
				hidden.push({ from: line.from + tail.index, to: line.to });
			}
			add('align', 'A', 'line', from, line.to, { align: center ? 'center' : 'right', hidden });
			continue;
		}
		if (entry.marks.length === 0) continue;
		entry.marks.sort((a, b) => a.from - b.from);
		const last = entry.marks[entry.marks.length - 1];
		add('quote', 'A', 'line', from, line.to, {
			depth: entry.marks.length, callout: entry.callout,
			...(entry.callout ? { calloutFirst: entry.calloutFirst, calloutLast: entry.calloutLast } : {}),
			hidden: [{ from: entry.marks[0].from, to: skipSpace(doc, last.to, line.to, 1) }],
		});
	}

	// ---- the scanner's inline constructs -----------------------------------
	for (const s of scan.constructs) {
		if (inOpaque(s.start)) continue;
		const r = (p) => (p ? { from: p.start, to: p.end } : null);
		switch (s.kind) {
			case 'math': {
				const block = s.display && alone(s.start, s.end);
				add('math', 'A', block ? 'block' : 'inline', s.start, s.end, {
					display: s.display, env: s.env, body: r(s.body),
					hidden: [{ from: s.start, to: s.end }],
				});
				break;
			}
			case 'italic':
			case 'highlight':
				// The dialect's own emphasis; the engine registers neither
				// under normalSyntax (vendor/jmarkdown/src/index.js).
				if (normal) break;
				add(s.kind, 'A', 'inline', s.start, s.end, {
					body: r(s.body), hidden: [r(s.open), r(s.close)].filter(Boolean),
				});
				break;
			case 'mustache': {
				const name = text(s.name.start, s.name.end).trim();
				if (name === 'TOC' && alone(s.start, s.end)) {
					add('toc', 'A', 'block', s.start, s.end, { hidden: [{ from: s.start, to: s.end }] });
				} else {
					add('mustache', 'A', 'inline', s.start, s.end, { name, hidden: [{ from: s.start, to: s.end }] });
				}
				break;
			}
			case 'wikilink':
			case 'embed': {
				// Inside a table the pipe must be escaped (`[[Note\|alias]]`, as
				// in Obsidian): the backslash belongs to the table, not the name.
				const target = (s.target ? text(s.target.start, s.target.end) : '').replace(/\\$/, '');
				const parts = {
					target, heading: s.heading ? text(s.heading.start, s.heading.end) : null,
					blockId: s.blockId ? text(s.blockId.start, s.blockId.end) : null,
					alias: r(s.alias), aliasText: s.aliasText,
				};
				if (s.kind === 'wikilink') {
					// Hidden: the brackets, and everything before the alias
					// when there is one (`[[Target|shown]]` shows `shown`);
					// a same-note `[[#Heading]]` shows `Heading`.
					const hidden = s.alias
						? [{ from: s.start, to: s.alias.start }, r(s.close)]
						: [r(s.open), r(s.close)];
					if (!s.alias && !s.target && s.heading) hidden[0] = { from: s.start, to: s.heading.start };
					add('wikilink', 'A', 'inline', s.start, s.end, { ...parts, hidden });
					break;
				}
				const dot = target.lastIndexOf('.');
				const isImage = dot !== -1 && IMAGE_EXT.includes(target.slice(dot).toLowerCase());
				const block = alone(s.start, s.end);
				if (isImage) add('image', 'B', block ? 'block' : 'inline', s.start, s.end, { ...parts, hidden: [{ from: s.start, to: s.end }] });
				else if (block) add('embed', 'C', 'block', s.start, s.end, { ...parts, hidden: [{ from: s.start, to: s.end }] });
				else add('embedChip', 'A', 'inline', s.start, s.end, { ...parts, hidden: [{ from: s.start, to: s.end }] });
				break;
			}
			case 'tag':
				add('tag', 'A', 'inline', s.start, s.end, { name: text(s.name.start, s.name.end) });
				break;
			case 'cite':
				add('cite', 'A', 'inline', s.start, s.end, {
					command: text(s.command.start, s.command.end),
					keys: s.keys.map((k) => text(k.start, k.end)),
					hidden: [{ from: s.start, to: s.end }],
				});
				break;
			case 'footnote':
				if (!s.close) break; // still being typed
				add('footnote', 'A', 'inline', s.start, s.end, {
					label: s.label ? text(s.label.start, s.label.end) : null,
					group: s.group ? text(s.group.start, s.group.end) : null,
					body: r(s.body), multiline: s.multiline,
					// Concealed whole, one line or many (§5.2 as corrected):
					// a multi-line note's badge comes from the block field,
					// which may replace across line breaks.
					hidden: [{ from: s.start, to: s.end }],
				});
				break;
			case 'directiveInline':
			case 'directiveAt': {
				const name = s.name ? text(s.name.start, s.name.end) : '';
				if (s.kind === 'directiveAt' && name === 'reveal') {
					add('richBlock', 'C', 'block', s.start, s.end, { source: 'directiveAt', name });
					break;
				}
				add(s.kind, 'A', 'inline', s.start, s.end, {
					name, content: r(s.content), attrs: r(s.attrs), block: s.block,
					hidden: directiveHidden(s),
				});
				break;
			}
			default:
		}
	}

	// Bare URLs, where the engine sees prose: not inside a construct the
	// scanner owns (a wikilink, maths, a citation, a {{var}}) nor in a
	// directive's bracket the engine takes literally (`@reveal[https://…]`).
	const owned = scan.constructs.flatMap((s) => {
		if (s.kind === 'directiveInline' || s.kind === 'directiveAt') {
			const name = s.name ? text(s.name.start, s.name.end) : '';
			return LITERAL_DIRECTIVES.has(name) ? [{ from: s.start, to: s.end }] : [];
		}
		return ['wikilink', 'embed', 'math', 'cite', 'mustache'].includes(s.kind) ? [{ from: s.start, to: s.end }] : [];
	});
	for (const { from, to } of bareUrls) {
		if (owned.some((r) => from >= r.from && to <= r.to)) continue;
		const url = text(from, to);
		const href = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : /^www\./i.test(url) ? `http://${url}` : `mailto:${url}`;
		add('url', 'A', 'inline', from, to, { url: href, hidden: [] });
	}

	out.sort((a, b) => a.from - b.from || b.to - a.to);
	assignIds(out, doc);
	// Footnotes numbered ONCE, in document order as the engine numbers them,
	// so both providers (a one-line note's badge in the inline layer, a
	// multi-line note's in the block field) agree.
	let footnotes = 0;
	for (const c of out) if (c.kind === 'footnote') c.number = ++footnotes;
	return out;
}

/** Hide a directive's sigil+name, brackets and attribute group; keep content. */
function directiveHidden(s) {
	if (!s.content) return [{ from: s.start, to: s.end }];
	const hidden = [{ from: s.start, to: s.content.start }];
	hidden.push({ from: s.content.end, to: s.end });
	return hidden.filter((h) => h.to > h.from);
}

/** Stable ids: hash of kind+text, with an occurrence count for duplicates. */
function assignIds(list, doc) {
	const seen = new Map();
	for (const c of list) {
		const h = fnv1a(`${c.kind}\u0000${doc.sliceString(c.from, c.to)}`);
		const n = seen.get(h) ?? 0;
		seen.set(h, n + 1);
		c.id = `${h}:${n}`;
	}
}

function fnv1a(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i += 1) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

/* ── tree helpers ────────────────────────────────────────────────────── */

const rangeOf = (n) => ({ from: n.from, to: n.to });

function childrenNamed(node, name) {
	const out = [];
	for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === name) out.push(c);
	return out;
}

function descendantsNamed(node, name, out = []) {
	for (let c = node.firstChild; c; c = c.nextSibling) {
		if (c.name === name) out.push(rangeOf(c));
		descendantsNamed(c, name, out);
	}
	return out;
}

function ancestors(node, name) {
	let n = 0;
	for (let p = node.parent; p; p = p.parent) if (p.name === name) n += 1;
	return n;
}

/** The offset past up to `max` spaces/tabs from `pos`, bounded by `limit`. */
function skipSpace(doc, pos, limit, max = Infinity) {
	let p = pos;
	while (p < limit && max > 0 && /[ \t]/.test(doc.sliceString(p, p + 1))) { p += 1; max -= 1; }
	return p;
}

/** The offset before the spaces/tabs preceding `pos`, bounded by `limit`. */
function backSpace(doc, pos, limit) {
	let p = pos;
	while (p > limit && /[ \t]/.test(doc.sliceString(p - 1, p))) p -= 1;
	return p;
}

/**
 * Strip `depth` quote markers (`>` with optional following space, possibly
 * indented) from a line; returns the rest and its offset in the line.
 */
function stripQuotes(line, depth) {
	let i = 0;
	for (let d = 0; d < depth; d += 1) {
		const m = /^[ \t]{0,3}>[ \t]?/.exec(line.slice(i));
		if (!m) return null;
		i += m[0].length;
	}
	return { rest: line.slice(i), offset: i };
}
