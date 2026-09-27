// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The Format menu, declaratively — one source of truth consumed by BOTH the
// native menu template (src/main/menu.js) and the renderer's command
// registrations (src/renderer/commands/format.js), so the menu, the command
// palette, and the hotkey editor can never drift apart. The menu doubles as
// a discovery surface for the whole jmarkdown dialect: labels show the
// syntax they produce.
//
// ids: the handful that predate this menu keep their edit:* ids (users may
// have rebound them); everything new is format:*.

export const FORMAT_MENU = [
	{
		label: 'Text Style',
		items: [
			{ id: 'edit:format-strong', label: 'Strong — *text*' },
			{ id: 'edit:format-intense', label: 'Intense — **text**' },
			{ id: 'edit:format-italic', label: 'Italic — /text/' },
			{ id: 'format:underline', label: 'Underline — __text__' },
			{ id: 'edit:format-highlight', label: 'Highlight — ==text==' },
			{ id: 'edit:format-strike', label: 'Strikethrough — ~text~' },
			{ id: 'format:subscript', label: 'Subscript — _{text}' },
			{ id: 'format:superscript', label: 'Superscript — ^{text}' },
			{ separator: true },
			{ id: 'edit:format-code', label: 'Inline Code — `text`' },
			{ id: 'edit:format-math', label: 'Inline Math — $x$' },
		],
	},
	{
		label: 'Heading',
		items: [
			{ id: 'format:heading-1', label: 'Heading 1' },
			{ id: 'format:heading-2', label: 'Heading 2' },
			{ id: 'format:heading-3', label: 'Heading 3' },
			{ id: 'format:heading-4', label: 'Heading 4' },
			{ id: 'format:heading-5', label: 'Heading 5' },
			{ id: 'format:heading-6', label: 'Heading 6' },
			{ separator: true },
			{ id: 'format:heading-clear', label: 'Clear Heading' },
		],
	},
	{
		label: 'Paragraph',
		items: [
			{ id: 'format:bullet-list', label: 'Bullet List' },
			{ id: 'format:numbered-list', label: 'Numbered List' },
			{ id: 'format:task-list', label: 'Task List — [ ]' },
			{ id: 'format:blockquote', label: 'Blockquote' },
			{ id: 'format:description-list', label: 'Description List — term:: definition' },
			{ separator: true },
			{ id: 'format:horizontal-rule', label: 'Horizontal Rule' },
		],
	},
	{
		label: 'Alignment',
		items: [
			{ id: 'format:align-center', label: 'Center — >> text <<' },
			{ id: 'format:align-right', label: 'Right — >> text' },
			{ separator: true },
			{ id: 'format:align-clear', label: 'Clear Alignment' },
		],
	},
	{
		label: 'Alert',
		items: [
			{ id: 'format:alert-note', label: 'Note' },
			{ id: 'format:alert-tip', label: 'Tip' },
			{ id: 'format:alert-important', label: 'Important' },
			{ id: 'format:alert-warning', label: 'Warning' },
			{ id: 'format:alert-caution', label: 'Caution' },
		],
	},
	{
		label: 'Table',
		items: [
			{ id: 'format:table-2', label: 'Insert Table (2×2)' },
			{ id: 'format:table-3', label: 'Insert Table (3×3)' },
			{ id: 'format:table-4', label: 'Insert Table (4×3)' },
			{ separator: true },
			{ id: 'format:table-row', label: 'Insert Row Below' },
		],
	},
	{
		label: 'Insert',
		items: [
			{ id: 'edit:insert-wikilink', label: 'Wikilink — [[…]]', chord: 'Mod-k' },
			{ id: 'edit:insert-template', label: 'Template…', chord: 'Mod-Alt-t' },
			{ separator: true },
			{ id: 'format:footnote', label: 'Footnote — [fn: …]' },
			{ id: 'format:citation', label: 'Citation — \\cite{…}' },
			{ id: 'format:label', label: 'Label — @label[key]' },
			{ id: 'format:reference', label: 'Reference — @ref[key]' },
			{ id: 'format:cref', label: 'Typed Reference — @cref[key]' },
			{ separator: true },
			{ id: 'format:toc', label: 'Table of Contents — {{TOC}}' },
			{ id: 'format:today', label: "Today's Date — :today" },
		],
	},
	{
		label: 'Block',
		items: [
			{ id: 'format:code-fence', label: 'Code Fence — ```' },
			{ id: 'format:math-block', label: 'Math Block — $$…$$' },
			{ separator: true },
			{ id: 'format:mermaid', label: 'Mermaid Diagram' },
			{ id: 'format:tikz', label: 'TiKZ Diagram' },
			{ id: 'format:mathematica', label: 'Mathematica' },
			{ id: 'format:game', label: 'Game Matrix — :::game' },
			{ id: 'format:markdown-demo', label: 'Markdown Demo — source + output' },
			{ separator: true },
			{ id: 'format:tex-block', label: 'LaTeX Only — :::TeX' },
			{ id: 'format:html-block', label: 'HTML Only — :::HTML' },
			{ separator: true },
			{ id: 'format:abstract', label: 'Abstract' },
			{ id: 'format:title-box', label: 'Title Box' },
			{ id: 'format:comment', label: 'Comment (omitted from output)' },
			{ id: 'format:container', label: 'Generic Container — :::name' },
		],
	},
];

/**
 * The commands that make sense inside a table cell edited in place (live
 * edit): inline formatting and inline inserts — a heading or a list in a
 * cell is not a thing GFM can hold. The rest refuse there with a notice,
 * and the `//` menu leaves them out.
 */
export const CELL_SAFE_COMMANDS = new Set([
	'edit:format-strong', 'edit:format-intense', 'edit:format-italic', 'format:underline',
	'edit:format-highlight', 'edit:format-strike', 'format:subscript', 'format:superscript',
	'edit:format-code', 'edit:format-math', 'edit:insert-wikilink', 'format:insert-link',
	'format:footnote', 'format:citation', 'format:label', 'format:reference', 'format:cref', 'format:Cref', 'format:today',
]);
