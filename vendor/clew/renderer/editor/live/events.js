// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Clicks on concealed constructs (docs/dev/live-edit.md §5.2, and a decision in force, docs/dev/live-edit.md §12): a
// concealed link FOLLOWS on click — Obsidian's behaviour — and ⌥-click puts
// the cursor in it instead, which reveals it for editing. ⌘/Ctrl-click opens
// a note link in a new tab. A tag opens the search panel on that tag; a
// block-id badge copies a link to its block; a `:ref[…]` jumps to its
// `:label[…]`. Every rendered stand-in (math, a footnote number, a citation
// chip) reveals its source when clicked.
//
// The targets are read from `data-le-*` attributes the inline layer put on
// the marks and widgets, never re-parsed from the text here.
import { EditorView } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import * as actions from '../../commands/actions.js';
import { openExternal } from '../../lib/external-links.js';
import { runCommand } from '../../commands/registry.js';
import { setCalloutFold, calloutFolded } from './block-field.js';
import { liveStateField } from './reveal-field.js';
import { activateCell } from './table-cell-editor.js';
import { openTableMenu } from '../toolbar/popovers.js';
import { numberDocument } from './numbering.js';
import { workspaceStore } from '../../state/workspace-store.js';

const TARGETS = '[data-le-cite],[data-le-cell],[data-le-task],[data-le-fold],[data-le-copy],[data-le-goto],[data-le-command],[data-le-href],[data-le-target],[data-le-tag],[data-le-ref],[data-le-blockid],.le-reveal-on-click';

/** Put the cursor at `pos` (revealing whatever is there) and focus. */
function placeCursor(view, pos) {
	view.dispatch({ selection: { anchor: pos } });
	view.focus();
}

// High precedence: source mode's own ⌘-click handler (wikilink-click.js)
// would otherwise claim a ⌘-click first and open the link in place.
export const liveEvents = Prec.high(EditorView.domEventHandlers({
	mousedown(event, view) {
		if (event.button !== 0) return false;
		const el = event.target.closest?.(TARGETS);
		if (!el || !view.contentDOM.contains(el)) return false;
		const revealOnly = el.classList.contains('le-reveal-on-click');
		if (el.dataset.leCell !== undefined) {
			event.preventDefault();
			const wrap = el.closest('.le-table-wrap');
			if (wrap.dataset.editable === 'true' && !event.altKey) {
				// Edit this cell in place (§5.5c): the table stays drawn.
				editCell(view, el);
				return true;
			}
			// ⌥-click, or a table edited as source: the cursor to that cell's
			// text, which reveals the table (the widget sits at its first line).
			placeCursor(view, view.posAtDOM(wrap) + Number(el.dataset.leCell));
			return true;
		}
		// ⌥-click edits: CodeMirror places the cursor, the construct reveals.
		if (event.altKey && !revealOnly) return false;
		event.preventDefault();

		if (el.dataset.leTask) {
			// The checkbox replaces `[ ]` / `[x]`: flip that one character.
			const pos = view.posAtDOM(el);
			const marker = view.state.doc.sliceString(pos, pos + 3);
			if (/^\[[ xX]\]$/.test(marker)) {
				view.dispatch({
					changes: { from: pos + 1, to: pos + 2, insert: marker[1] === ' ' ? 'x' : ' ' },
					userEvent: 'input.task',
				});
			}
			return true;
		}
		if (el.dataset.leFold) {
			const callout = view.state.field(liveStateField).model.find((c) => c.id === el.dataset.leFold);
			if (callout) {
				view.dispatch({ effects: setCalloutFold.of({ id: callout.id, folded: !calloutFolded(view.state, callout) }) });
			}
			return true;
		}
		if (el.dataset.leCopy) {
			const pos = view.posAtDOM(el);
			const fence = view.state.field(liveStateField).model
				.find((c) => c.kind === 'codeFence' && pos >= c.openLine.from && pos <= c.openLine.to);
			if (fence) navigator.clipboard.writeText(view.state.doc.sliceString(fence.body.from, fence.body.to)).catch(() => {});
			return true;
		}
		if (el.dataset.leGoto) {
			const pos = Math.min(Number(el.dataset.leGoto), view.state.doc.length);
			view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start' }) });
			view.focus();
			return true;
		}
		if (el.dataset.leCommand) {
			runCommand(el.dataset.leCommand);
			return true;
		}
		if (el.dataset.leBlockid) {
			placeCursor(view, view.posAtDOM(el));
			runCommand('editor:copy-block-ref');
			return true;
		}
		if (el.dataset.leHref) {
			const url = el.dataset.leHref;
			if (/^[a-z][a-z0-9+.-]*:/i.test(url)) openExternal(url);
			else actions.openWikilink(decodeURI(url).replace(/\.(md|jmd)$/i, ''), { newTab: event.metaKey || event.ctrlKey });
			return true;
		}
		if (el.dataset.leExternal) {
			actions.openFileExternally(el.dataset.leExternal);
			return true;
		}
		if (el.dataset.leTarget !== undefined) {
			actions.openWikilink(el.dataset.leTarget, { newTab: event.metaKey || event.ctrlKey });
			return true;
		}
		if (el.dataset.leTag) {
			document.querySelector('clew-app')?.openSearch?.(`tag:#${el.dataset.leTag}`);
			return true;
		}
		if (el.dataset.leCite) {
			showCitation(el.dataset.leCite.split(',')[0]);
			return true;
		}
		if (el.dataset.leRef) {
			// Jump to what the reference names (numbering.js knows where
			// every label is), leaving a Back entry, as a TOC jump does.
			const target = numberDocument(view.state.doc).labels.get(el.dataset.leRef);
			if (!target) { placeCursor(view, view.posAtDOM(el)); return true; }
			const from = view.state.doc.lineAt(view.state.selection.main.head).number;
			const at = view.state.doc.line(Math.min(target.line, view.state.doc.lines)).from;
			const tab = workspaceStore.activeTab();
			if (tab) workspaceStore.recordAnchorJump(tab.id, from, target.line, { editor: true });
			view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) });
			view.focus();
			return true;
		}
		placeCursor(view, view.posAtDOM(el));
		return true;
	},

	// Right-click on a table cell: the table menu (rows, columns, alignment).
	contextmenu(event, view) {
		const td = event.target.closest?.('.le-table-wrap [data-le-cell]');
		if (!td || !view.contentDOM.contains(td)) return false;
		const wrap = td.closest('.le-table-wrap');
		if (wrap.dataset.editable !== 'true') return false;
		event.preventDefault();
		if (td.dataset.leActive === undefined) editCell(view, td);
		openTableMenu(event.clientX, event.clientY);
		return true;
	},
}));

/** Make a rendered cell the one being edited. */
function editCell(view, td) {
	const wrap = td.closest('.le-table-wrap');
	const doc = view.state.doc;
	const first = doc.lineAt(view.posAtDOM(wrap)).number;
	const rows = wrap.querySelectorAll('tr').length;
	// The table's lines: its rows plus the delimiter line.
	activateCell(view, first, first + rows, Number(td.dataset.leRow), Number(td.dataset.leCol), 'end');
}

/**
 * A citation chip's click (§5.14): the right sidebar on the References
 * panel, in its Library, at the entry — highlighted.
 */
export function showCitation(key) {
	workspaceStore.setSidebar('right', { open: true, activeTool: 'bibliography' });
	requestAnimationFrame(() => document.querySelector('clew-bibliography')?.showEntry?.(key));
}
