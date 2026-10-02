// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Live edit's INLINE concealment (plan §5.2): a ViewPlugin that, for the
// visible ranges only, hides the delimiters of every inline construct the
// selection does not reveal, styles what remains, and swaps the constructs
// that have a rendering (math, footnotes, citations, chips) for widgets.
//
// A ViewPlugin may not change the vertical block structure — no block
// widgets, no replacement across a line break (CodeMirror computes the
// viewport before plugins run). Everything here stays on one line; a
// construct whose replacement WOULD cross a line (a `$…$` broken over two
// lines, say) is simply left as source. Block-level work is block-field.js.
//
// What a revealed construct looks like is not this file's business: it is
// source mode — the overlay's jmd-* faces and the theme's cmt-* classes.
import { ViewPlugin, Decoration } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import { liveStateField } from './reveal-field.js';
import { MathWidget } from './widgets/math.js';
import {
	BulletWidget, TaskWidget, CalloutHeadWidget, FenceHeadWidget, FenceFootWidget,
	EnvHeadWidget, EnvFootWidget,
} from './widgets/lines.js';
import { calloutFolded } from './block-field.js';
import { ImageWidget } from './widgets/image.js';
import { imageSpec } from './images.js';
import { ChipWidget } from './widgets/chip.js';
import { numberDocument, refDisplay, headText, typedRefText } from './numbering.js';
import { vaultStore } from '../../state/vault-store.js';
import { citationLabel, citationsReady, citationsLoaded } from '../complete/citations.js';
import { engineCiteText, engineCiteHtml, wantCiteTexts, onCiteTexts, citeSignature } from './cite-text.js';
import { FullciteWidget } from './widgets/fullcite.js';
import { localCiteText } from './cite-label.js';
import { calloutColor } from '#jmarkdown/callout-table.js';

const HIDE = Decoration.replace({});
const markCache = new Map();
function markOf(cls) {
	let deco = markCache.get(cls);
	if (!deco) markCache.set(cls, (deco = Decoration.mark({ class: cls })));
	return deco;
}

/** Inline constructs whose delimiters hide and whose body gets a class. */
const STYLED = new Set(['strong', 'intense', 'italic', 'underline', 'highlight', 'strike', 'sub', 'sup', 'code']);

/**
 * The decorations for the visible part of the document.
 *
 * @param {import('@codemirror/view').EditorView} view
 * @returns {import('@codemirror/view').DecorationSet}
 */
function build(view) {
	const { state } = view;
	const live = state.field(liveStateField);
	const { config, model } = live;
	const doc = state.doc;
	const out = [];
	const visible = view.visibleRanges;
	const inView = (from, to) => visible.some((r) => from <= r.to && to >= r.from);
	const oneLine = (from, to) => doc.lineAt(from).number === doc.lineAt(to).number;
	const text = (r) => doc.sliceString(r.from, r.to);
	/** Ranges replaced whole: nothing inside them is decorated. */
	const replaced = [];

	// What the engine will number, and what each label resolves to (§5.13).
	const numbering = numberDocument(doc, config.numbered?.size ? { numbered: config.numbered } : undefined);

	// Every citation in the note, in order, for the engine's texts: asked for
	// once per change of the list, whatever is in view (cite-text.js).
	const notePath = config.notePath;
	const cites = model.filter((c) => c.kind === 'cite');
	const citeSig = cites.length ? citeSignature(doc) : '';
	if (cites.length) {
		wantCiteTexts(notePath, citeSig, [...new Set(cites.slice().sort((a, b) => a.from - b.from).map(text))]);
	}

	// A CONCEALED multi-line footnote is replaced whole by the block field's
	// badge: nothing inside it is decorated here (§5.2, the containment rule).
	const concealedNotes = model.filter((c) => c.kind === 'footnote' && c.multiline && !live.revealed.has(c.id));
	const inNote = (from, to) => concealedNotes.some((n) => from >= n.from && to <= n.to && !(from === n.from && to === n.to));

	const hide = (r) => { if (r.to > r.from) out.push(HIDE.range(r.from, r.to)); };
	const mark = (from, to, cls, attributes) => {
		if (to <= from) return;
		out.push((attributes ? Decoration.mark({ class: cls, attributes }) : markOf(cls)).range(from, to));
	};
	const widget = (from, to, w) => {
		out.push(Decoration.replace({ widget: w }).range(from, to));
		replaced.push({ from, to });
	};
	for (const n of concealedNotes) replaced.push({ from: n.from, to: n.to });

	// Line stand-ins first: an inline construct inside a replaced opener
	// line (a directive's `[caption]`) is then skipped, never overlapped.
	lines();

	for (const c of model) {
		if (c.kind === 'image' && c.level === 'inline' && inView(c.from, c.to) && !live.revealed.has(c.id)
			&& oneLine(c.from, c.to) && !replaced.some((r) => c.from >= r.from && c.to <= r.to)) {
			widget(c.from, c.to, new ImageWidget(imageSpec(c, config.notePath, false)));
			continue;
		}
		if (c.tier !== 'A' || (c.level !== 'inline' && c.kind !== 'blockId')) continue;
		if (!inView(c.from, c.to) || live.revealed.has(c.id)) continue;
		if (replaced.some((r) => c.from >= r.from && c.to <= r.to)) continue;
		// Replacements may not cross a line break here.
		if (c.hidden.some((h) => !oneLine(h.from, h.to))) continue;

		if (STYLED.has(c.kind)) {
			c.hidden.forEach(hide);
			mark(c.from, c.to, `le-${c.kind}`);
			continue;
		}
		switch (c.kind) {
			case 'escape':
			case 'hardBreak':
				c.hidden.forEach(hide);
				break;
			case 'math': {
				if (!config.renderMath || !oneLine(c.from, c.to)) break;
				widget(c.from, c.to, new MathWidget(text(c.body), c.display, text(c)));
				break;
			}
			case 'link':
				c.hidden.forEach(hide);
				mark(c.label.from, c.label.to, 'le-link', { 'data-le-href': c.url, title: c.url });
				break;
			case 'autolink':
				c.hidden.forEach(hide);
				mark(c.from + 1, c.to - 1, 'le-link', { 'data-le-href': c.url, title: c.url });
				break;
			case 'url':
				// A bare URL: nothing to conceal, a link as reading view draws it.
				mark(c.from, c.to, 'le-link', { 'data-le-href': c.url, title: c.url });
				break;
			case 'wikilink': {
				c.hidden.forEach(hide);
				const shownFrom = c.hidden[0].to;
				const shownTo = c.hidden[c.hidden.length - 1].from;
				const target = c.target + (c.heading ? `#${c.heading}` : '') + (c.blockId ? `#^${c.blockId}` : '');
				const resolved = !c.target || vaultStore.resolveNoteName(c.target) || vaultStore.resolveFileName(c.target);
				const external = (c.aliasText ?? '').split('|').some((p) => p.trim().toLowerCase() === 'external');
				mark(shownFrom, shownTo, `le-wikilink${resolved ? '' : ' le-unresolved'}`, {
					'data-le-target': target,
					...(external ? { 'data-le-external': c.target } : {}),
					title: resolved ? target : `${target} (not created yet)`,
				});
				break;
			}
			case 'embedChip':
				widget(c.from, c.to, new ChipWidget({
					cls: 'le-embed-chip', text: `⧉ ${c.target || c.heading || ''}`,
					title: text(c), reveal: false, data: { leTarget: c.target + (c.heading ? `#${c.heading}` : '') },
				}));
				break;
			case 'tag':
				mark(c.from, c.to, 'le-tag', { 'data-le-tag': c.name });
				break;
			case 'footnote':
				if (c.multiline) break; // the block field's badge (it spans lines)
				widget(c.from, c.to, new ChipWidget({
					cls: 'le-fn', tag: 'sup', text: String(c.number),
					title: text(c.body).trim(),
				}));
				break;
			case 'cite': {
				// The engine's text for the citation as written (cite-text.js),
				// else the local one (cite-label.js); an unknown key in the
				// danger colour, as a missing reference is.
				const labels = c.keys.map((k) => citationLabel(k));
				const engine = engineCiteText(notePath, citeSig, state.doc.sliceString(c.from, c.to));
				const missing = !engine && citationsLoaded() && labels.some((l) => !l);
				// \fullcite: the whole entry, inline, as reading mode draws it —
				// or, until it is in (or with no bibliography), the .bib's own
				// author, year and title; an unknown key as itself, in red.
				if (c.command === 'fullcite') {
					widget(c.from, c.to, new FullciteWidget({
						html: engineCiteHtml(notePath, citeSig, state.doc.sliceString(c.from, c.to)) ?? null,
						text: engine || labels.map((l, i) => (l ? `${l.label}. ${l.title}`.replace(/\.\s*$/, '') + '.' : c.keys[i])).join(' '),
						missing,
					}));
					break;
				}
				widget(c.from, c.to, new ChipWidget({
					cls: missing ? 'le-cite le-cite-missing' : 'le-cite',
					text: engine || localCiteText(c.command, c.keys, labels),
					title: labels.map((l, i) => (l ? `${l.label}: ${l.title}` : c.keys[i])).join('\n'),
					// A click opens the References panel's Library at the
					// entry (events.js); ⌥-click edits (§5.14).
					reveal: false, data: { leCite: c.keys.join(',') },
				}));
				break;
			}
			case 'mustache':
				widget(c.from, c.to, new ChipWidget({ cls: 'le-var', text: c.name, title: `{{${c.name}}}` }));
				break;
			case 'directiveInline':
			case 'directiveAt':
				directive(c);
				break;
			case 'blockId':
				widget(c.hidden[0].from, c.hidden[0].to, new ChipWidget({
					cls: 'le-block-id', text: '⌗', title: `^${c.id} — click to copy a link to this block`,
					reveal: false, data: { leBlockid: c.id },
				}));
				break;
			default:
		}
	}

	function directive(c) {
		const content = c.content ? text(c.content) : '';
		switch (c.name) {
			case 'today':
				widget(c.from, c.to, new ChipWidget({
					cls: 'le-today', text: new Date().toLocaleDateString(), title: text(c),
				}));
				return;
			case 'label': {
				const target = numbering.labels.get(content);
				const says = target?.status === 'ok' && target.number
					? typedRefText(target.type, target.number, true) : 'no number (a reference prints ??)';
				widget(c.from, c.to, new ChipWidget({ cls: 'le-label', text: `⚓ ${content}`, title: `label ${content} — ${says}` }));
				return;
			}
			case 'TeX':
				c.hidden.forEach(hide);
				mark(c.content?.from ?? c.from, c.content?.to ?? c.from, 'le-tex-only', { title: 'LaTeX only' });
				return;
			case 'HTML':
				c.hidden.forEach(hide);
				return;
			case 'ref':
			case 'cref':
			case 'Cref': {
				if (!c.content) break;
				// The number the engine will print (numbering.js); a click
				// jumps to the label (events.js), ⌥-click edits.
				const shown = refDisplay(numbering, content, c.name);
				widget(c.from, c.to, new ChipWidget({
					cls: `le-ref le-ref-${shown.state}`, text: shown.text, title: shown.tip,
					reveal: false, data: { leRef: content },
				}));
				return;
			}
			default:
		}
		if (c.content) {
			c.hidden.forEach(hide);
			mark(c.content.from, c.content.to, 'le-directive', { title: text(c).replace(content, '…') });
		} else {
			widget(c.from, c.to, new ChipWidget({ cls: 'le-directive-chip', text: c.name || text(c), title: text(c) }));
		}
	}

	return Decoration.set(out, true);

	/**
	 * Line constructs (plan §5.1, §5.4, §5.5): their LINE classes apply in
	 * both states — a heading's size, a list's indent, a quote's border, a
	 * callout's tint — so entering a line never changes its height; only
	 * the marks and stand-ins toggle with the reveal.
	 */
	function lines() {
		const lineClass = (pos, cls, attributes) =>
			out.push(Decoration.line(attributes ? { class: cls, attributes } : { class: cls }).range(doc.lineAt(pos).from));
		const lineRange = (from, to) => ({ from, to });
		for (const c of model) {
			if (c.tier !== 'A' || !inView(c.lineFrom, c.lineTo)) continue;
			if (inNote(c.from, c.to)) continue; // inside a concealed note
			const hidden = !live.revealed.has(c.id);
			switch (c.kind) {
				case 'heading': {
					lineClass(c.from, `le-h le-h${c.depth}`);
					if (hidden) c.hidden.forEach(hide);
					// `Headings: numeric`: the number the engine prefixes.
					const numbered = hidden && numbering.headingsNumeric && numbering.lines.get(doc.lineAt(c.from).number);
					if (numbered && c.hidden[0]) {
						out.push(Decoration.widget({
							widget: new ChipWidget({ cls: 'le-heading-number', text: `${numbered.number}.`, reveal: false }), side: 1,
						}).range(c.hidden[0].to));
					}
					break;
				}
				case 'align':
					lineClass(c.from, `le-align-${c.align}`);
					if (hidden) c.hidden.forEach(hide);
					break;
				case 'quote': {
					// A callout's lines draw one box, as reading view's .callout:
					// its first and last carry the padding and the corners; a bare
					// `>` between paragraphs is a paragraph GAP, not a line.
					// A custom type's colour (Settings → Callouts) rides on the
					// line as --clew-callout-color, as reading view's element carries it.
					const color = c.callout ? calloutColor(c.callout) : null;
					const box = c.callout
						? ` le-callout le-callout-${c.callout}${color ? ' le-callout-custom' : ''}${c.calloutFirst ? ' le-callout-first' : ''}${c.calloutLast ? ' le-callout-last' : ''}`
						: '';
					const blank = /^(?:[ \t]*>)+[ \t]*$/.test(doc.lineAt(c.from).text) ? ' le-quote-blank' : '';
					lineClass(c.from, `le-quote le-quote-${Math.min(c.depth, 4)}${box}${blank}`,
						color ? { style: `--clew-callout-color: ${color}` } : undefined);
					if (hidden) c.hidden.forEach(hide);
					break;
				}
				case 'callout':
					lineClass(c.from, `le-callout-head${calloutFolded(state, c) ? ' le-callout-folded' : ''}`);
					if (hidden) {
						const h = c.hidden[0];
						widget(h.from, h.to, new CalloutHeadWidget(c.type, c.fold, calloutFolded(state, c), Boolean(c.title), c.id, c.rawType));
						if (c.title) mark(c.title.from, c.title.to, 'le-callout-title');
					}
					break;
				case 'bullet':
				case 'numbered':
				case 'task': {
					// Counted from the end of a quote's `>`s: a list in a callout
					// indents from the callout's text, not from the margin.
					const listLine = doc.lineAt(c.listMark.from);
					const quoted = /^(?:[ \t]*>)+[ \t]?/.exec(listLine.text)?.[0].length ?? 0;
					const indent = c.listMark.from - listLine.from - quoted;
					lineClass(c.from, `le-li le-li-${Math.min(c.depth, 4)}${c.kind === 'task' && c.checked ? ' le-done' : ''}`,
						{ style: `--le-indent: ${indent}` });
					if (!hidden) break;
					if (c.kind === 'bullet') widget(c.hidden[0].from, c.hidden[0].to, new BulletWidget(c.depth));
					if (c.kind === 'task') {
						c.hidden.forEach(hide);
						widget(c.marker.from, c.marker.to, new TaskWidget(c.checked));
					}
					break;
				}
				case 'codeFence': {
					const last = c.closeLine ?? lineRange(doc.lineAt(c.to).from, c.to);
					for (let n = doc.lineAt(c.openLine.from).number; n <= doc.lineAt(last.from).number; n += 1) {
						const line = doc.line(n);
						if (!inView(line.from, line.to)) continue;
						const edge = line.from === c.openLine.from ? ' le-fence-open'
							// Concealed, the closer is only the box's rounded foot — not a
							// blank line under the code (reading mode draws none).
							: c.closeLine && line.from === c.closeLine.from ? ` le-fence-close${hidden ? ' le-fence-foot-line' : ''}` : '';
						lineClass(line.from, `le-fence${edge}`);
					}
					if (!hidden) break;
					if (c.openLine.to > c.openLine.from) widget(c.openLine.from, c.openLine.to, new FenceHeadWidget(c.lang));
					if (c.closeLine && c.closeLine.to > c.closeLine.from) widget(c.closeLine.from, c.closeLine.to, new FenceFootWidget());
					break;
				}
				case 'directive':
				case 'environment': {
					const name = c.name || '';
					const kindCls = `le-env le-env-${name.replace(/[^\w-]/g, '')}${c.texOnly ? ' le-tex-only-block' : ''}${c.comment ? ' le-env-comment' : ''}`;
					const bodyFrom = c.body.start ?? c.body.from;
					const bodyTo = c.body.end ?? c.body.to;
					lineClass(c.openLine.from, `${kindCls} le-env-open`);
					if (c.closeLine) lineClass(c.closeLine.from, `${kindCls} le-env-close`);
					if (bodyTo > bodyFrom || doc.lineAt(bodyFrom).from === bodyFrom) {
						for (let n = doc.lineAt(bodyFrom).number; n <= doc.lineAt(bodyTo).number; n += 1) {
							const line = doc.line(n);
							if (line.from >= c.openLine.from && line.from <= c.openLine.to) continue;
							if (c.closeLine && line.from === c.closeLine.from) continue;
							if (inView(line.from, line.to)) lineClass(line.from, kindCls);
						}
					}
					if (!hidden) break;
					const caption = c.content ? doc.sliceString(c.content.start ?? c.content.from, c.content.end ?? c.content.to) : '';
					const attrs = c.attrs ? doc.sliceString(c.attrs.start ?? c.attrs.from, c.attrs.end ?? c.attrs.to) : '';
					const entry = numbering.lines.get(doc.lineAt(c.openLine.from).number);
					widget(c.openLine.from, c.openLine.to, new EnvHeadWidget(name, caption, attrs,
						c.texOnly ? 'LaTeX only' : c.htmlOnly ? 'HTML only' : '', entry ? headText(entry) : ''));
					if (c.closeLine && c.closeLine.to > c.closeLine.from) widget(c.closeLine.from, c.closeLine.to, new EnvFootWidget());
					break;
				}
				case 'term': {
					// `Term:: definition` (the engine's description list): the
					// term bold, the `::` concealed like any markup, the
					// definition after it set apart as reading mode's <dd> is.
					mark(c.term.from, c.term.to, 'le-dt');
					if (!hidden) break;
					const sep = /^::[ \t]*/.exec(doc.sliceString(c.term.to, c.to));
					if (sep) {
						widget(c.term.to, c.term.to + sep[0].length, new ChipWidget({ cls: 'le-dt-sep', text: '—' }));
						mark(c.term.to + sep[0].length, c.to, 'le-dd');
					}
					break;
				}
				default:
			}
		}
	}
}

/** Rebuild without a document change: what a link resolves to, or a
 *  citation's label, changed outside the editor. */
export const liveRefresh = StateEffect.define();

export const inlineLayer = ViewPlugin.fromClass(class {
	constructor(view) {
		this.live = view.state.field(liveStateField);
		this.decorations = build(view);
		const refresh = () => requestAnimationFrame(() => {
			if (view.dom.isConnected) view.dispatch({ effects: liveRefresh.of(null) });
		});
		this.refresh = refresh;
		this.unsubscribe = [
			vaultStore.on('tree-changed', refresh),
			vaultStore.on('index-changed', refresh),
			// The engine's citation texts arrived, or were dropped (cite-text.js).
			onCiteTexts((path) => {
				if (path === null || path === view.state.field(liveStateField, false)?.config.notePath) refresh();
			}),
		];
		// The .bib entries load on the first citationLabel() ask; redraw
		// when they are in (a fixed delay lost the race on a cold start).
		if (this.live.model.some((c) => c.kind === 'cite')) citationsReady().then(refresh);
	}

	update(update) {
		const live = update.state.field(liveStateField);
		const refreshed = update.transactions.some((tr) => tr.effects.some((e) => e.is(liveRefresh)));
		if (update.docChanged || update.viewportChanged || live !== this.live || refreshed) {
			this.live = live;
			this.decorations = build(update.view);
			// The .bib entries were dropped (a .bib edited): redraw once they
			// are back, or the pills read bare keys until the engine's texts.
			if (!citationsLoaded() && !this.awaitingBib && live.model.some((c) => c.kind === 'cite')) {
				this.awaitingBib = true;
				citationsReady().then(() => { this.awaitingBib = false; this.refresh(); });
			}
		}
	}

	destroy() {
		for (const off of this.unsubscribe) off();
	}
}, { decorations: (plugin) => plugin.decorations });
