// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The editor toolbar, described once (plan §6.2): groups of items, each item
// a COMMAND id — so the palette, the hotkey editor, the menus and a plugin
// all see every action the bar offers, and the tooltip shows the effective
// chord. The element (clew-editor-toolbar.js) renders this; the layout
// (toolbar-layout.js) decides which groups fit; the state
// (toolbar-state.js) decides what is pressed.
//
// Labels say what the DIALECT produces — `*text*` is strong here — and
// relabel under the vault's normalSyntax, where the same commands write
// standard markdown.

export const BLOCK_LABELS = {
	paragraph: 'Paragraph', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3',
	h4: 'Heading 4', h5: 'Heading 5', h6: 'Heading 6', quote: 'Quote', callout: 'Callout',
	bullet: 'Bullet list', numbered: 'Numbered list', task: 'Task list', code: 'Code',
	table: 'Table', math: 'Math', html: 'HTML', frontmatter: 'Properties',
};

export const blockLabel = (s) => (s.blockType === 'env' ? `Env: ${s.envName ?? '…'}` : BLOCK_LABELS[s.blockType] ?? 'Paragraph');

/**
 * The table's own tools (docs/dev/live-edit.md §5.5c): the toolbar's Table
 * group while the cursor or a cell being edited is in a table, and the
 * right-click menu on a cell — one list, so the two offer the same things.
 */
export const TABLE_ITEMS = [
	{ kind: 'button', icon: 'row-above', label: 'Insert row above', command: 'format:table-row-above' },
	{ kind: 'button', icon: 'row-below', label: 'Insert row below', command: 'format:table-row' },
	{ kind: 'button', icon: 'row-delete', label: 'Delete row', command: 'format:table-delete-row' },
	{ kind: 'button', icon: 'col-left', label: 'Insert column left', command: 'format:table-col-left' },
	{ kind: 'button', icon: 'col-right', label: 'Insert column right', command: 'format:table-col-right' },
	{ kind: 'button', icon: 'col-delete', label: 'Delete column', command: 'format:table-delete-col' },
	{ kind: 'button', icon: 'align-left', label: 'Align column left', command: 'format:table-align-left' },
	{ kind: 'button', icon: 'align-center', label: 'Align column centre', command: 'format:table-align-center' },
	{ kind: 'button', icon: 'align-right', label: 'Align column right', command: 'format:table-align-right' },
	{ kind: 'button', icon: 'format', label: 'Format table', command: 'editor:format-table' },
	{ kind: 'button', icon: 'code', label: 'Edit table as source', command: 'editor:table-source', when: (s) => s.inCell },
];

/** The table menu's extra rows (the toolbar keeps these in its overflow). */
export const TABLE_MENU_EXTRA = [
	{ label: 'Move row up', command: 'format:table-move-row-up' },
	{ label: 'Move row down', command: 'format:table-move-row-down' },
	{ label: 'Move column left', command: 'format:table-move-col-left' },
	{ label: 'Move column right', command: 'format:table-move-col-right' },
	{ label: 'Column alignment: default', command: 'format:table-align-none' },
];

/** Items: { kind: 'button'|'toggle'|'dropdown'|'segmented', … }. */
export const TOOLBAR_GROUPS = [
	{ id: 'history', label: 'History', priority: 10, items: [
		{ kind: 'button', icon: 'undo', label: 'Undo', command: 'edit:undo', enabled: (s) => s.canUndo },
		{ kind: 'button', icon: 'redo', label: 'Redo', command: 'edit:redo', enabled: (s) => s.canRedo },
	] },
	{ id: 'block', label: 'Block style', priority: 90, items: [
		{ kind: 'dropdown', id: 'block-style', popover: 'heading', text: blockLabel, label: 'Block style', width: 128 },
	] },
	{ id: 'inline', label: 'Text style', priority: 100, items: [
		{ kind: 'toggle', icon: 'bold', command: 'edit:format-strong', active: (s) => s.inline.has('strong'),
			label: (s) => (s.normalSyntax ? 'Bold — **text**' : 'Strong — *text*') },
		{ kind: 'toggle', icon: 'intense', command: 'edit:format-intense', active: (s) => s.inline.has('intense'),
			label: 'Intense — **text**', when: (s) => !s.normalSyntax },
		{ kind: 'toggle', icon: 'italic', command: 'edit:format-italic', active: (s) => s.inline.has('italic'),
			label: (s) => (s.normalSyntax ? 'Italic — *text*' : 'Italic — /text/') },
		{ kind: 'toggle', icon: 'underline', command: 'format:underline', active: (s) => s.inline.has('underline'),
			label: 'Underline — __text__', when: (s) => !s.normalSyntax },
		{ kind: 'toggle', icon: 'highlighter', command: 'edit:format-highlight', active: (s) => s.inline.has('highlight'),
			label: 'Highlight — ==text==', when: (s) => !s.normalSyntax },
		{ kind: 'toggle', icon: 'strikethrough', command: 'edit:format-strike', active: (s) => s.inline.has('strike'),
			label: 'Strikethrough — ~text~' },
		{ kind: 'toggle', icon: 'subscript', command: 'format:subscript', active: (s) => s.inline.has('sub'),
			label: 'Subscript — _{text}' },
		{ kind: 'toggle', icon: 'superscript', command: 'format:superscript', active: (s) => s.inline.has('sup'),
			label: 'Superscript — ^{text}' },
		{ kind: 'toggle', icon: 'code', command: 'edit:format-code', active: (s) => s.inline.has('code'),
			label: 'Inline code — `text`' },
		{ kind: 'toggle', icon: 'sigma', command: 'edit:format-math', active: (s) => s.inline.has('math'),
			label: 'Inline math — $x$' },
	] },
	{ id: 'list', label: 'Lists', priority: 80, items: [
		{ kind: 'toggle', icon: 'list-ul', label: 'Bullet list', command: 'format:bullet-list', active: (s) => s.blockType === 'bullet' },
		{ kind: 'toggle', icon: 'list-ol', label: 'Numbered list', command: 'format:numbered-list', active: (s) => s.blockType === 'numbered' },
		{ kind: 'toggle', icon: 'list-check', label: 'Task list', command: 'format:task-list', active: (s) => s.blockType === 'task' },
		{ kind: 'button', icon: 'outdent', label: 'Outdent', command: 'format:outdent', enabled: (s) => s.inList },
		{ kind: 'button', icon: 'indent', label: 'Indent', command: 'format:indent', enabled: (s) => s.inList },
	] },
	{ id: 'insert', label: 'Insert', priority: 70, items: [
		{ kind: 'dropdown', icon: 'link', label: 'Link…', popover: 'link', active: (s) => s.inline.has('link') },
		{ kind: 'button', icon: 'wikilink', label: 'Wikilink — [[…]]', command: 'edit:insert-wikilink', active: (s) => s.inline.has('wikilink') },
		{ kind: 'button', icon: 'image', label: 'Attachment…', command: 'format:insert-attachment' },
		{ kind: 'dropdown', icon: 'table', label: 'Table…', popover: 'table', active: (s) => s.blockType === 'table' },
		{ kind: 'dropdown', icon: 'callout', label: 'Callout…', popover: 'callout', active: (s) => s.blockType === 'callout' },
		{ kind: 'dropdown', icon: 'fence', label: 'Code block…', popover: 'code', active: (s) => s.blockType === 'code' },
		{ kind: 'dropdown', icon: 'sigma', label: 'Math…', popover: 'math' },
		{ kind: 'dropdown', icon: 'diagram', label: 'Diagram…', popover: 'diagram' },
		{ kind: 'dropdown', icon: 'plus', label: 'Insert…', popover: 'insert' },
		{ kind: 'dropdown', icon: 'box', label: 'Block…', popover: 'block' },
	] },
	{ id: 'table-tools', label: 'Table', priority: 60, when: (s) => s.inTable, items: [
		...TABLE_ITEMS,
	] },
	{ id: 'mode', label: 'Mode', priority: Infinity, align: 'end', items: [
		{ kind: 'segmented', id: 'view-mode', label: 'View mode', options: [
			{ value: 'source', icon: 'code', label: 'Source', command: 'workspace:mode-source' },
			{ value: 'live', icon: 'pencil', label: 'Live edit', command: 'workspace:mode-live' },
			{ value: 'reading', icon: 'book', label: 'Reading', command: 'workspace:mode-reading' },
		], value: (s) => s.mode },
	] },
];

/** Groups the selection bubble shows (plan §6.7). */
export const BUBBLE_GROUPS = ['inline'];
export const BUBBLE_EXTRA = [
	{ kind: 'dropdown', icon: 'link', label: 'Link…', popover: 'link' },
	{ kind: 'button', icon: 'wikilink', label: 'Wikilink — [[…]]', command: 'edit:insert-wikilink' },
];

/** The groups in the user's order (settings `editorToolbarGroups`); the
 *  mode switch is always present and always last. */
export function orderedGroups(setting, extraItems = []) {
	const byId = new Map(TOOLBAR_GROUPS.map((g) => [g.id, g]));
	const ids = Array.isArray(setting) ? setting.filter((id) => byId.has(id) && id !== 'mode') : TOOLBAR_GROUPS.map((g) => g.id).filter((id) => id !== 'mode');
	const groups = ids.map((id) => byId.get(id));
	groups.push(byId.get('mode'));
	// Plugin buttons join their named group (default: insert).
	if (extraItems.length === 0) return groups;
	return groups.map((g) => {
		const extra = extraItems.filter((b) => (b.group ?? 'insert') === g.id);
		return extra.length ? { ...g, items: [...g.items, ...extra] } : g;
	});
}

export const labelOf = (item, s) => (typeof item.label === 'function' ? item.label(s) : item.label);
