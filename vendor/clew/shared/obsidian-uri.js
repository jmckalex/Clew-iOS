// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Obsidian's app URI scheme (obsidian://…), planned into Clew equivalents.
//
// Vaults in the wild link to these the way they link to anything else —
// bramses' README recommends a plugin via obsidian://show-plugin — and
// handing such a URL to the OS either bounces (no Obsidian installed) or
// yanks the reader into a different app. Planning is pure and lives here so
// it can be tested; executing the plan is the renderer's few lines.
//
// Plans:
//   { kind: 'open', file }         open?file=… / open?path=… and the
//                                  obsidian://vault/<vault>/<file> shorthand
//   { kind: 'search', query }      search?query=…
//   { kind: 'web', url }           show-plugin?id=… → the plugin's web page
//   { kind: 'unsupported', action} everything else, BY NAME
//   null                           not an obsidian:// URL at all
export function planObsidianUri(url) {
	let parsed;
	try { parsed = new URL(url); } catch { return null; }
	if (parsed.protocol !== 'obsidian:') return null;
	const action = (parsed.hostname || parsed.pathname.replace(/^\/+/, '').split('/')[0]).toLowerCase();
	const params = parsed.searchParams;

	if (action === 'open') {
		const file = params.get('file') ?? params.get('path');
		if (file) return { kind: 'open', file };
		return { kind: 'unsupported', action: 'open (no file)' };
	}
	// obsidian://vault/<vault name>/<file path> — the short form.
	if (action === 'vault') {
		const rest = parsed.pathname.replace(/^\/+/, '').split('/').slice(1).join('/');
		if (rest) return { kind: 'open', file: decodeURIComponent(rest) };
		return { kind: 'unsupported', action: 'vault (no file)' };
	}
	if (action === 'search') {
		return { kind: 'search', query: params.get('query') ?? '' };
	}
	if (action === 'show-plugin') {
		const id = params.get('id');
		if (id) return { kind: 'web', url: `https://obsidian.md/plugins?id=${encodeURIComponent(id)}` };
	}
	return { kind: 'unsupported', action };
}
