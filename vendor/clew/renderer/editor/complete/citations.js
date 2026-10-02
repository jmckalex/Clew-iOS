// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// \cite{ completion from the vault's .bib files. Triggers inside the braces
// of any \cite-family command (\cite, \citep[…], \fullcite, …), completing
// the segment after the last comma. Entries come from main (mtime-cached);
// the renderer keeps one copy per vault tree state.
import { vaultStore } from '../../state/vault-store.js';
import { fuzzyScore } from '../../lib/fuzzy.js';
import { ipc, CH } from '../../ipc.js';
import { shortCiteLabel } from '../../../shared/bib.js';

const CITE_PREFIX = /\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\]){0,2}\{([^{}]*)$/;

let cache = null;
let cachePromise = null;
const drop = () => { cache = null; cachePromise = null; };
vaultStore.on('tree-changed', drop);
vaultStore.on('vault-changed', drop);
// …and a .bib edited in place, which changes no tree.
ipc.on(CH.EV_FILE_CHANGED, ({ path }) => { if (/\.bib$/i.test(path ?? '')) drop(); });

async function bibEntries() {
	if (cache) return cache;
	cachePromise ??= ipc.invoke(CH.BIB_ENTRIES).catch(() => []);
	cache = await cachePromise;
	cachePromise = null;
	return cache;
}

/** Resolves once the vault's .bib entries are loaded (for a redraw). */
export function citationsReady() {
	return bibEntries().then(() => undefined, () => undefined);
}

/** Whether the entries are in — until then an unknown key is not yet one. */
export function citationsLoaded() {
	return cache !== null;
}

/**
 * A citation key's short label (`Akerlof and Kranton 2000`, `Smith et al.
 * 2001` — shared/bib.js#shortCiteLabel) and title, from the vault's .bib
 * files — synchronous, so live edit's chips can ask while drawing. Null
 * until the entries have loaded (the first ask starts the load; the next
 * redraw picks it up) and for a key no .bib defines. A pill shows it only
 * until the engine's own text is in (editor/live/cite-text.js).
 *
 * @param {string} key
 * @returns {{ label: string, title: string, authors: string, year: string }|null}
 */
export function citationLabel(key) {
	if (!cache) { bibEntries().catch(() => {}); return null; }
	const entry = cache.find((e) => e.key === key);
	if (!entry) return null;
	return { label: shortCiteLabel(entry), title: entry.title ?? '', authors: entry.authors ?? '', year: entry.year ?? '' };
}

/** Every entry in the vault's .bib files (the References panel's Library,
 *  §5.14), from the same cache completion uses. */
export function allBibEntries() {
	return bibEntries();
}

export async function citationCompletions(context) {
	const line = context.state.doc.lineAt(context.pos);
	const before = line.text.slice(0, context.pos - line.from);
	const match = CITE_PREFIX.exec(before);
	if (!match) return null;
	const inBraces = match[1];
	const lastComma = inBraces.lastIndexOf(',');
	const query = inBraces.slice(lastComma + 1).trim();
	const from = context.pos - (inBraces.length - lastComma - 1);

	const entries = await bibEntries();
	if (entries.length === 0) return null;

	const options = [];
	for (const entry of entries) {
		const haystack = `${entry.key} ${entry.authors} ${entry.title}`;
		const score = query ? fuzzyScore(query, haystack) : 0;
		if (score === null) continue;
		const detail = [entry.authors, entry.year && `(${entry.year})`, entry.title]
			.filter(Boolean).join(' ');
		options.push({
			label: entry.key,
			detail: detail.length > 60 ? detail.slice(0, 60) + '…' : detail,
			type: 'constant',
			boost: Math.min(99, Math.max(-99, Math.round((score ?? 0) / 12))),
			apply: entry.key,
		});
	}
	return options.length ? { from, options, validFor: /^[^,{}\s]*$/ } : null;
}
