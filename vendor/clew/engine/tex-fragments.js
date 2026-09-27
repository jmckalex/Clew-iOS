// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * @file Named TeX fragments: preamble text a figure asks for by name instead
 * of carrying a copy of it.
 *
 *     ```latex clew-fragments='math macros, colours'
 *     \begin{align*} \R \subseteq \C \end{align*}
 *     ```
 *
 * The fragments themselves are written in Settings → TeX fragments, in two
 * scopes: the GLOBAL ones (<userData>/clew-settings.json, yours on this
 * machine, offered in every vault) and THIS VAULT's (.clew/vault-settings
 * .json, which travel with the vault to another machine or another person).
 * A vault fragment SHADOWS a global one of the same name — the plugins
 * arrangement, for the same reason: the vault is the more specific scope,
 * and a vault that carries its own macros must render the same everywhere.
 *
 * This module is the one place that knows what a name matches and which
 * scope wins. src/engine/figures.js reads it in the render worker; the
 * RENDERER imports it too (the settings view marks a shadowed row and warns
 * about a duplicate name), the same arrangement as metapost-words.js — so
 * what the settings UI calls a clash and what the worker calls a shadow
 * cannot drift. Main does no resolving at all: it hands the worker both
 * lists as it stored them (CLEW_TEX_FRAGMENTS) and this file decides.
 *
 * Nothing here is TeX-aware. A fragment is text, inserted verbatim into a
 * figure's preamble by figures.js#applyTexFragments — which is also where a
 * name nobody defined is refused BY NAME rather than typeset without.
 */

/**
 * The key a name matches on. Names are written by hand in two places (a
 * settings row and a fence's attribute), so matching ignores case and the
 * width of the spaces between words: `math macros`, `Math Macros` and
 * `math  macros` are one fragment.
 */
export function fragmentKey(name) {
	return String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The names a `clew-fragments` attribute asks for, in the order asked.
 * Comma-separated, because a name may have spaces in it (`math macros`) and
 * commas are what the owner's own example used.
 */
export function fragmentNames(value) {
	return String(value ?? '').split(',').map((name) => name.trim()).filter(Boolean);
}

/** One scope's stored list, tolerant of anything that is not the shape we write. */
function addScope(table, list, scope) {
	if (!Array.isArray(list)) return;
	for (const entry of list) {
		const key = fragmentKey(entry?.name);
		// An unnamed row is a row the user has not finished writing.
		if (!key) continue;
		table.set(key, { name: String(entry.name).trim(), text: String(entry?.text ?? ''), scope });
	}
}

/**
 * Both scopes → key → { name, text, scope }. Global first, so a vault
 * fragment of the same name overwrites it: the vault wins.
 *
 * A name repeated WITHIN one scope resolves to the last row — the settings
 * view warns about that case rather than the two files disagreeing quietly.
 */
export function resolveFragments({ global = [], vault = [] } = {}) {
	const table = new Map();
	addScope(table, global, 'global');
	addScope(table, vault, 'vault');
	return table;
}

/**
 * The two lists as the render worker was given them. The desktop passes
 * CLEW_TEX_FRAGMENTS as JSON (render-service.js, export-site.js); a host
 * that runs the engine without a process environment (the iOS shim runs it
 * in a JS context) may set `globalThis.CLEW_TEX_FRAGMENTS` instead, as the
 * object or the same JSON — the arrangement CLEW_NOTE_FONTS uses.
 */
export function fragmentSets() {
	try {
		const raw = globalThis.CLEW_TEX_FRAGMENTS ?? globalThis.process?.env?.CLEW_TEX_FRAGMENTS;
		const sets = typeof raw === 'string' ? JSON.parse(raw || 'null') : raw;
		return sets && typeof sets === 'object' ? sets : {};
	} catch { return {}; }
}

/**
 * Look `names` up in a resolved table: the text to insert, in the order the
 * figure asked for, and the names nothing defines.
 *
 * A name asked for twice is inserted once — `\newcommand` is an error the
 * second time, and a fence listing a fragment twice meant it once.
 */
export function collectFragments(names, table) {
	const parts = [];
	const missing = [];
	const seen = new Set();
	for (const name of names) {
		const key = fragmentKey(name);
		const entry = table.get(key);
		if (!entry) { missing.push(name); continue; }
		if (seen.has(key)) continue;
		seen.add(key);
		const text = entry.text.replace(/\s+$/, '');
		if (text.trim()) parts.push(text);
	}
	return { text: parts.join('\n'), missing };
}
