// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Diary actions: open-or-create a day (per-day file OR a section of the
// single log, per the vault-independent diaryMode setting), and generate
// composed day/interval/whole views. Views are ephemeral notes under
// .clew/ — invisible to the explorer and index, dropped from the workspace
// on restart, rendered by the full engine like any note.
import { workspaceStore } from '../state/workspace-store.js';
import { vaultStore } from '../state/vault-store.js';
import { settingsStore } from '../state/settings-store.js';
import { editorPool } from '../editor/pool.js';
import { jumpToLine } from './actions.js';
import { scrollSyncBus } from '../preview/scroll-sync.js';
import { ipc, CH } from '../ipc.js';
import {
	formatDiaryDate, parseDiaryDate, dayKey, parseLogSections, upsertLogSection,
	extractLogRange, composeDiaryView, dayKeysInRange, substituteTemplate,
} from '../../shared/diary.js';

export const VIEW_PATH = '.clew/Diary View.md';

export function diaryConfig() {
	return {
		mode: settingsStore.get('diaryMode') === 'log' ? 'log' : 'files',
		folder: settingsStore.get('dailyNoteFolder') ?? 'Daily',
		format: settingsStore.get('dailyNoteFormat') ?? 'YYYY-MM-DD',
		template: settingsStore.get('dailyNoteTemplate'),
		logFile: settingsStore.get('diaryLogFile') || 'Diary.md',
	};
}

function fileForDay(date, cfg) {
	const name = formatDiaryDate(date, cfg.format);
	return cfg.folder ? `${cfg.folder}/${name}.md` : `${name}.md`;
}

async function templateSeed(cfg, title) {
	if (!cfg.template) return '';
	const templatePath = vaultStore.resolveNoteName(cfg.template);
	if (!templatePath) return '';
	const raw = await ipc.invoke(CH.NOTE_READ, { path: templatePath }).catch(() => '');
	return substituteTemplate(raw, { title });
}

/** The live editor entry for a path, if any tab holds one. */
function liveEntryFor(path) {
	for (const group of workspaceStore.allGroups()) {
		for (const tab of group.tabs) {
			if (tab.kind !== 'note' || tab.path !== path) continue;
			const entry = editorPool.get(tab.id);
			if (entry?.view) return entry;
		}
	}
	return null;
}

/** Land a note tab on a 1-based line in either mode. */
function revealLine(tab, path, line) {
	if (tab.view.mode === 'reading') {
		workspaceStore.updateTabView(tab.id, { cursorLine: line });
		setTimeout(() => {
			scrollSyncBus.emit('scroll', { path, line, from: 'nav' });
		}, 60);
	} else {
		jumpToLine(tab.id, line);
	}
}

/** Open (creating as needed) the diary entry for a date. */
export async function openDiaryDay(date) {
	const cfg = diaryConfig();
	const title = formatDiaryDate(date, cfg.format);

	if (cfg.mode === 'files') {
		const rel = fileForDay(date, cfg);
		if (vaultStore.pathExists(rel)) {
			workspaceStore.openNote(rel);
			return;
		}
		try {
			const created = await ipc.invoke(CH.NOTE_CREATE, { path: rel });
			const seed = await templateSeed(cfg, title);
			if (seed) await ipc.invoke(CH.NOTE_WRITE, { path: created, content: seed });
			workspaceStore.openNote(created);
		} catch (err) {
			console.error('Diary day failed:', err);
		}
		return;
	}

	// Log mode: ensure the day's section exists (newest first), then land on it.
	const rel = cfg.logFile;
	const current = await ipc.invoke(CH.NOTE_READ, { path: rel }).catch(() => '') ?? '';
	const seed = await templateSeed(cfg, title);
	const { text: next, line } = upsertLogSection(current, date, cfg.format, seed);
	if (next !== current) {
		// Insertions are contiguous: apply through a live editor when one is
		// open (undoable, no conflict banner), else write to disk.
		const entry = liveEntryFor(rel);
		if (entry && entry.view.state.doc.toString() === current) {
			let at = 0;
			while (at < current.length && current[at] === next[at]) at++;
			entry.view.dispatch({
				changes: { from: at, insert: next.slice(at, at + (next.length - current.length)) },
			});
			const tabId = workspaceStore.allGroups().flatMap((g) => g.tabs)
				.find((t) => t.kind === 'note' && t.path === rel)?.id;
			if (tabId) editorPool.flush(tabId);
		} else {
			await ipc.invoke(CH.NOTE_WRITE, { path: rel, content: next });
		}
	}
	const tab = workspaceStore.openNote(rel);
	revealLine(tab, rel, line);
}

/** Which days of a month have entries (for the calendar's dots). */
export async function diaryDaysWithEntries(year, month) {
	const cfg = diaryConfig();
	const keys = new Set();
	if (cfg.mode === 'files') {
		const days = new Date(year, month + 1, 0).getDate();
		for (let d = 1; d <= days; d++) {
			const date = new Date(year, month, d);
			if (vaultStore.pathExists(fileForDay(date, cfg))) keys.add(dayKey(date));
		}
		return keys;
	}
	const text = await ipc.invoke(CH.NOTE_READ, { path: cfg.logFile }).catch(() => '') ?? '';
	const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
	for (const section of parseLogSections(text, cfg.format)) {
		if (section.key.startsWith(prefix)) keys.add(section.key);
	}
	return keys;
}

/** Generate and open the composed view for [fromKey, toKey] (day keys). */
export async function openDiaryRange(fromKey, toKey, title = null) {
	const cfg = diaryConfig();
	let entries = [];
	if (cfg.mode === 'log') {
		const text = await ipc.invoke(CH.NOTE_READ, { path: cfg.logFile }).catch(() => '') ?? '';
		entries = extractLogRange(text, cfg.format, fromKey, toKey);
	} else {
		for (const key of dayKeysInRange(fromKey, toKey)) {
			const [y, m, d] = key.split('-').map(Number);
			const date = new Date(y, m - 1, d);
			const rel = fileForDay(date, cfg);
			if (!vaultStore.pathExists(rel)) continue;
			const body = await ipc.invoke(CH.NOTE_READ, { path: rel }).catch(() => null);
			if (body !== null) entries.push({ key, heading: formatDiaryDate(date, cfg.format), body });
		}
	}
	const label = title
		?? (fromKey === toKey ? fromKey : `${fromKey} → ${toKey}`);
	const view = composeDiaryView(`Diary — ${label}`, entries);

	// Close stale view tabs so the fresh file renders from scratch.
	for (const group of workspaceStore.allGroups()) {
		for (const tab of [...group.tabs]) {
			if (tab.path === VIEW_PATH) {
				editorPool.close(tab.id);
				workspaceStore.closeTab(tab.id);
			}
		}
	}
	await ipc.invoke(CH.NOTE_WRITE, { path: VIEW_PATH, content: view });
	const tab = workspaceStore.openNote(VIEW_PATH, { newTab: true });
	workspaceStore.setTabMode(tab.id, 'reading');
	return entries.length;
}

/** The whole diary, newest first. */
export async function openDiaryAll() {
	return openDiaryRange('0000-00-00', '9999-99-99', 'everything');
}

export { formatDiaryDate, parseDiaryDate, dayKey };
