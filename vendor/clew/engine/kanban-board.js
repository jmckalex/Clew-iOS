// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Obsidian's Kanban PLUGIN stores a whole board as an ordinary note:
//
//   ---
//   kanban-plugin: basic        (newer versions write `board`)
//   ---
//   ## Lane title
//   - [ ] a card
//   - [x] a finished card
//   ## Done
//   **Complete**                (marks the lane as the completed lane)
//   ***                         (everything below the divider is archived)
//   ## Archive
//   %% kanban:settings … %%     (the plugin's own JSON; opaque to everyone else)
//
// Implemented from that ON-DISK FORMAT — the plugin's code is not consulted —
// and rendered read-only in reading mode, one column per lane, on the same
// CSS Clew's own ```kanban fence uses. The single write path is the card
// checkbox, which carries its true source line and flows through the
// data-source-line toggle every rendered checkbox already uses, so ticking a
// card edits exactly the `- [ ]` it came from and the file stays a file
// Obsidian's plugin will happily reopen.
//
// In source mode a board is just markdown, which is the point of the format.
import fs from 'node:fs';
import { currentFilePath } from './vault-model.js';

const CARD_RE = /^[-*+] \[( |x|X)\] (.*)$/;

/** Does this note's text declare itself a Kanban-plugin board? */
export function isKanbanBoard(text) {
	const fm = /^---\n([\s\S]*?)\n---/.exec(text);
	return Boolean(fm && /^kanban-plugin:\s*\S/m.test(fm[1]));
}

/**
 * The board a note holds: lanes in order, each with its 1-based heading line
 * and its cards' 1-based lines (what the checkbox toggle needs). Lanes after
 * a `***` divider are the plugin's archive and are marked so the renderer
 * can leave them out, as the plugin does. The `%% kanban:settings` block and
 * everything after it belong to the plugin alone.
 */
export function parseBoard(text) {
	const lines = text.split('\n');
	const lanes = [];
	let lane = null;
	let archived = false;
	let start = 0;
	if (lines[0] === '---') {
		const close = lines.indexOf('---', 1);
		if (close !== -1) start = close + 1;
	}
	for (let i = start; i < lines.length; i++) {
		const line = lines[i];
		if (/^%%\s*kanban:settings/.test(line)) break;
		if (/^\*\*\*\s*$/.test(line)) { archived = true; continue; }
		const heading = /^##\s+(.+?)\s*$/.exec(line);
		if (heading) {
			lane = { title: heading[1], line: i + 1, complete: false, archived, cards: [] };
			lanes.push(lane);
			continue;
		}
		if (!lane) continue;
		if (/^\*\*Complete\*\*\s*$/.test(line)) { lane.complete = true; continue; }
		const card = CARD_RE.exec(line.trim());
		if (card && CARD_RE.test(line)) {
			lane.cards.push({ text: card[2].trim(), done: card[1] !== ' ', line: i + 1 });
		}
	}
	return { lanes };
}

const escapeHtml = (s) => String(s)
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Card text with `[[wikilinks]]` as internal links; everything else literal. */
export function cardHtml(text) {
	return String(text).split(/(\[\[[^\]]+\]\])/).map((part) => {
		const wiki = /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/.exec(part);
		if (!wiki) return escapeHtml(part);
		const target = wiki[1].trim();
		return `<a class="internal-link" href="#" data-href="${escapeHtml(target)}">`
			+ `${escapeHtml((wiki[2] ?? target).trim())}</a>`;
	}).join('');
}

export function renderBoard(board) {
	const parts = ['<div class="clew-kanban clew-kanban-note">'];
	for (const lane of board.lanes) {
		if (lane.archived) continue;
		parts.push(`<div class="kanban-col" data-source-line="${lane.line}">`);
		parts.push(`<div class="kanban-col-title">${escapeHtml(lane.title)}`
			+ ` <span class="kanban-count">${lane.cards.length}</span></div>`);
		for (const card of lane.cards) {
			parts.push(`<div class="kanban-card" data-source-line="${card.line}">`
				+ `<input type="checkbox" disabled${card.done ? ' checked' : ''}> `
				+ `${cardHtml(card.text)}</div>`);
		}
		parts.push('</div>');
	}
	parts.push('</div>');
	return parts.join('\n') + '\n';
}

// One note per one-shot worker build; still, cache by path in case a board
// is embedded into another note later.
const cache = new Map();
function boardFor() {
	const file = currentFilePath();
	if (!file) return null;
	if (!cache.has(file)) {
		let board = null;
		try {
			const text = fs.readFileSync(file, 'utf8');
			if (isKanbanBoard(text)) board = parseBoard(text);
		} catch { /* unreadable — not a board */ }
		cache.set(file, board);
	}
	return cache.get(file);
}

/**
 * The extension: for a note whose frontmatter declares `kanban-plugin`, the
 * FIRST block token claims the entire body and renders the board — the
 * board IS the document, so nothing else should render around it. For every
 * other note, start() declines and the tokenizer never runs.
 */
export const kanbanBoard = {
	name: 'kanbanBoard',
	level: 'block',
	start(src) { return boardFor() && src.trim() ? 0 : undefined; },
	tokenizer(src) {
		if (!boardFor() || !src.trim()) return undefined;
		return { type: 'kanbanBoard', raw: src, text: src };
	},
	renderer() {
		if (global.isLatex) return '';
		return renderBoard(boardFor());
	},
};
