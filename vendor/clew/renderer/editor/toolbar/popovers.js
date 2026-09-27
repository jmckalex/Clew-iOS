// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What the toolbar's dropdowns hold (plan §6.6). Every choice runs a
// registry COMMAND (with args where it takes them), so nothing here edits the
// document itself. The Insert and Block popovers are the Format menu's own
// groups (shared/format-spec.js), so the bar and the menu cannot drift.
import { runCommand, effectiveKeymap } from '../../commands/registry.js';
import { prettifyChord } from '../../commands/builtin.js';
import { FORMAT_MENU } from '../../../shared/format-spec.js';
import { CALLOUT_TYPES, calloutIcon } from '../../../engine/callouts.js';
import { fenceLanguage } from '../langs/fence-languages.js';
import { menuItem, menuSeparator, menuHeading, openPopover } from './popover.js';
import { TABLE_ITEMS, TABLE_MENU_EXTRA } from './toolbar-spec.js';
import { icon } from '../../lib/icons.js';

const chordFor = (id) => {
	for (const [chord, mapped] of effectiveKeymap()) if (mapped === id) return prettifyChord(chord);
	return '';
};
const run = (close, id, args) => () => { close(); runCommand(id, args); };

function list(children) {
	const el = document.createElement('div');
	el.className = 'popover-list';
	el.append(...children);
	return el;
}

function formatGroup(label) {
	return FORMAT_MENU.find((g) => g.label === label)?.items ?? [];
}

function fromSpec(items, close) {
	return items.map((item) => (item.separator ? menuSeparator()
		: menuItem(item.label, run(close, item.id), { chord: chordFor(item.id) })));
}

const BUILDERS = {
	heading(close, state) {
		const rows = [
			['paragraph', 'Paragraph', 'format:heading-clear'],
			...[1, 2, 3, 4, 5, 6].map((n) => [`h${n}`, `Heading ${n}`, `format:heading-${n}`]),
			null,
			['quote', 'Quote', 'format:blockquote'],
			['callout', 'Callout', 'format:callout'],
			['bullet', 'Bullet list', 'format:bullet-list'],
			['numbered', 'Numbered list', 'format:numbered-list'],
			['task', 'Task list', 'format:task-list'],
			null,
			['code', 'Code block', 'format:code-fence'],
			['math', 'Math block', 'format:math-block'],
		];
		return list(rows.map((r) => (r === null ? menuSeparator()
			: menuItem(r[1], run(close, r[2]), { checked: state.blockType === r[0], chord: chordFor(r[2]) }))));
	},

	link(close) {
		const form = document.createElement('form');
		form.className = 'popover-form';
		const url = Object.assign(document.createElement('input'), { placeholder: 'https://… or a note path', spellcheck: false });
		const text = Object.assign(document.createElement('input'), { placeholder: 'Link text (optional)', spellcheck: false });
		url.className = text.className = 'popover-input';
		url.dataset.field = 'url';
		text.dataset.field = 'text';
		const submit = Object.assign(document.createElement('button'), { type: 'submit', textContent: 'Insert' });
		submit.className = 'popover-submit';
		form.append(url, text, submit);
		form.addEventListener('submit', (e) => {
			e.preventDefault();
			close();
			if (!url.value.trim() && text.value.trim()) runCommand('edit:insert-wikilink');
			else runCommand('format:insert-link', { url: url.value.trim(), text: text.value || undefined });
		});
		return form;
	},

	table(close) {
		const wrap = document.createElement('div');
		wrap.className = 'popover-table';
		const caption = document.createElement('div');
		caption.className = 'popover-caption';
		caption.textContent = 'Table';
		const grid = document.createElement('div');
		grid.className = 'popover-grid';
		const cells = [];
		const light = (rows, cols) => {
			caption.textContent = `${rows} × ${cols}`;
			for (const c of cells) c.classList.toggle('is-lit', c.row <= rows && c.col <= cols);
		};
		for (let row = 1; row <= 8; row += 1) {
			for (let col = 1; col <= 8; col += 1) {
				const cell = document.createElement('button');
				cell.className = 'popover-grid-cell';
				cell.row = row;
				cell.col = col;
				cell.dataset.size = `${row}x${col}`;
				cell.setAttribute('aria-label', `${row} rows × ${col} columns`);
				cell.addEventListener('pointerenter', () => light(row, col));
				cell.addEventListener('focus', () => light(row, col));
				cell.addEventListener('pointerdown', (e) => e.preventDefault());
				cell.addEventListener('click', run(close, 'format:table', { rows: row, cols: col }));
				cells.push(cell);
				grid.append(cell);
			}
		}
		wrap.append(caption, grid);
		return wrap;
	},

	callout(close) {
		const fold = document.createElement('select');
		fold.className = 'popover-select';
		for (const [value, label] of [['', 'Not foldable'], ['+', 'Foldable, open'], ['-', 'Foldable, collapsed']]) {
			fold.append(Object.assign(document.createElement('option'), { value, textContent: label }));
		}
		const rows = Object.entries(CALLOUT_TYPES).map(([type, { label }]) => {
			const icon = document.createElement('span');
			icon.className = `popover-icon le-callout-${type} le-callout-marker`;
			icon.innerHTML = calloutIcon(type);
			return menuItem(label, () => { close(); runCommand('format:callout', { type, fold: fold.value }); }, { icon });
		});
		return list([fold, ...rows]);
	},

	code(close) {
		const COMMON = ['js', 'ts', 'python', 'bash', 'json', 'yaml', 'html', 'css', 'sql', 'latex', 'tikz', 'tex', 'metapost', 'mermaid', 'query', 'dataview', 'leaflet'];
		const known = new Set(COMMON);
		for (const lang of fenceLanguage.names ?? []) known.add(lang);
		const search = Object.assign(document.createElement('input'), { placeholder: 'Language…', spellcheck: false });
		search.className = 'popover-input';
		const box = document.createElement('div');
		box.className = 'popover-list popover-scroll';
		const draw = () => {
			const q = search.value.trim().toLowerCase();
			const names = [...known].filter((n) => n.includes(q));
			if (q && !known.has(q)) names.unshift(q);
			box.replaceChildren(menuItem('(no language)', run(close, 'format:code-fence-lang', { lang: '' })),
				...names.map((lang) => menuItem(lang, run(close, 'format:code-fence-lang', { lang }))));
		};
		search.addEventListener('input', draw);
		search.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); close(); runCommand('format:code-fence-lang', { lang: search.value.trim() }); }
		});
		draw();
		const wrap = document.createElement('div');
		wrap.className = 'popover-form';
		wrap.append(search, box);
		return wrap;
	},

	math(close) {
		return list([
			menuItem('Inline — $x$', run(close, 'edit:format-math'), { chord: chordFor('edit:format-math') }),
			menuItem('Display — $$…$$', run(close, 'format:math-block')),
			menuSeparator(),
			menuHeading('Environment'),
			...['equation', 'align', 'gather', 'multline', 'equation*', 'align*']
				.map((name) => menuItem(name, run(close, 'format:math-env', { name }))),
		]);
	},

	diagram(close) {
		const show = document.createElement('select');
		show.className = 'popover-select';
		for (const [value, label] of [['', 'Show the figure'], ['code', 'Show the code'], ['both', 'Show both']]) {
			show.append(Object.assign(document.createElement('option'), { value, textContent: label }));
		}
		const kinds = [['mermaid', 'Mermaid'], ['tikz', 'TikZ'], ['latex', 'LaTeX snippet'], ['tex', 'Plain TeX'], ['metapost', 'MetaPost']];
		return list([show, ...kinds.map(([kind, label]) =>
			menuItem(label, () => { close(); runCommand('format:figure', { kind, show: show.value }); }))]);
	},

	insert(close) {
		return list([
			...fromSpec(formatGroup('Insert'), close),
			menuSeparator(),
			menuItem('Copy link to block', run(close, 'editor:copy-block-ref'), { chord: chordFor('editor:copy-block-ref') }),
			menuItem('Horizontal rule', run(close, 'format:horizontal-rule')),
			menuItem('Description list', run(close, 'format:description-list')),
		]);
	},

	block(close) {
		return list([
			...fromSpec(formatGroup('Block'), close),
			menuSeparator(),
			menuHeading('Alignment'),
			...fromSpec(formatGroup('Alignment'), close),
		]);
	},
};

/** Build a popover's content. */
export function buildPopover(kind, close, state) {
	return BUILDERS[kind]?.(close, state) ?? list([menuHeading(`No ${kind} popover`)]);
}

/**
 * The right-click menu on a table cell, at the pointer: the toolbar's
 * table tools plus moving rows and columns.
 */
export function openTableMenu(x, y) {
	const anchor = document.createElement('div');
	anchor.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:1px;height:1px`;
	document.body.append(anchor);
	openPopover({
		anchor,
		className: 'table-menu',
		focusFirst: false,
		onClose: () => anchor.remove(),
		build: (close) => list([
			...TABLE_ITEMS.filter((item) => item.command !== 'editor:table-source' && item.command !== 'editor:format-table')
				.map((item) => menuItem(item.label, run(close, item.command), { icon: icon(item.icon), chord: chordFor(item.command) })),
			menuSeparator(),
			...TABLE_MENU_EXTRA.map((item) => menuItem(item.label, run(close, item.command), { chord: chordFor(item.command) })),
			menuSeparator(),
			menuItem('Format table', run(close, 'editor:format-table'), { chord: chordFor('editor:format-table') }),
			menuItem('Edit table as source', run(close, 'editor:table-source')),
		]),
	});
}
