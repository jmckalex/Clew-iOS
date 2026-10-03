// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What a vault CONTAINS that would run if this device trusted it — the
// counts and the Details of the trust prompt (docs/dev/frame-bridge.md §4.5):
// its scripts (.clew/scripts/*.js), its own plugins (.clew/plugins), the
// notes holding code, and what its vault-settings.json asks for. A vault
// with none of it never asks (the owner's decision 10): there is nothing to
// trust.
//
// The note scan is a READING of the text, not the engine's verdict: it finds
// the forms that announce themselves — a `<script>`, a ```dataviewjs or
// ```script fence, Mathematica's ⟦…⟧, a `Load …:`/`Extension …:`/`Script:`
// header key — outside code. The engine refuses every construct by name when
// it renders (note-code.js), and those refusals reach the window's
// indicator whatever this scan missed; this only decides whether to ask, and
// what to say. Electron-free, for the tests.
import fs from 'node:fs';
import path from 'node:path';
import { listPlugins } from './plugins.js';

const HEADER_KEY = /^(Load javascript|Load extensions|Load directives|Load environments|Extension [^:]*|Script|Scripts):/i;
const CODE_FENCES = new Set(['dataviewjs', 'script', 'mathematica', 'wolfram']);

/**
 * The kinds of code one note's text holds, by name, in first-seen order.
 * @param {string} text
 * @returns {string[]} e.g. ['script', 'dataviewjs']
 */
export function noteCodeKinds(text) {
	const kinds = new Set();
	const lines = String(text).split('\n');
	let i = 0;
	// A metadata header: leading `Key: value` lines (jmarkdown's own header),
	// or a fenced --- block, whose keys are read the same way.
	const fenced = lines[0]?.trim() === '---';
	if (fenced) i = 1;
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (fenced && line.trim() === '---') { i++; break; }
		if (!fenced && !/^[A-Za-z][\w -]*:/.test(line)) break;
		if (HEADER_KEY.test(line.trim())) kinds.add('header');
	}
	let fence = null;
	for (; i < lines.length; i++) {
		const line = lines[i];
		const open = /^\s{0,3}(`{3,}|~{3,})\s*([\w-]*)/.exec(line);
		if (fence) {
			if (open && open[1][0] === fence[0] && open[1].length >= fence.length && !open[2]) fence = null;
			continue;
		}
		if (open) {
			fence = open[1];
			const info = open[2].toLowerCase();
			if (CODE_FENCES.has(info)) kinds.add(info === 'wolfram' ? 'mathematica' : info);
			continue;
		}
		// Inline code spans hide what they hold.
		const prose = line.replace(/`[^`]*`/g, '');
		if (/<script\b/i.test(prose)) kinds.add('script');
		if (/⟦/.test(prose)) kinds.add('mathematica');
		if (/\bon[a-z]+\s*=\s*["']/i.test(prose) && /<[a-z]/i.test(prose)) kinds.add('inline handler');
	}
	return [...kinds];
}

/**
 * @param {object} options
 * @param {string} options.root the vault root
 * @param {Iterable<string>} options.notePaths vault-relative notes (the index's)
 * @param {{ enable: object }} options.requests readVaultRequests(root)
 * @param {string|null} [options.globalDir] the global plugins folder
 * @param {number} [options.listLimit] how many notes Details names
 * @returns {{ scripts: string[], plugins: {id, name}[], notes: {path, kinds}[],
 *   noteCount: number, requests: object, globalRequests: {id, name}[],
 *   empty: boolean }}
 */
export function codeSummary({ root, notePaths, requests, globalDir = null, listLimit = 50 }) {
	let scripts = [];
	try {
		scripts = fs.readdirSync(path.join(root, '.clew', 'scripts'))
			.filter((f) => f.endsWith('.js')).sort();
	} catch { /* none */ }
	const all = listPlugins(root, globalDir);
	const plugins = all.filter((p) => p.scope === 'vault').map((p) => ({ id: p.id, name: p.name }));
	// A request for a plugin the user installed globally is shown, never run
	// on the vault's say-so (§4.7); one for a plugin that exists nowhere is
	// dropped — there is nothing to enable.
	const requested = new Set(requests?.enable?.plugins ?? []);
	const globalRequests = listPlugins(root, globalDir, { vault: false })
		.filter((p) => requested.has(p.id) && !plugins.some((v) => v.id === p.id))
		.map((p) => ({ id: p.id, name: p.name }));
	const notes = [];
	let noteCount = 0;
	for (const rel of notePaths) {
		if (!/\.(md|jmd)$/i.test(rel)) continue;
		let text;
		try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
		const kinds = noteCodeKinds(text);
		if (kinds.length === 0) continue;
		noteCount++;
		if (notes.length < listLimit) notes.push({ path: rel, kinds });
	}
	notes.sort((a, b) => a.path.localeCompare(b.path));
	const enable = requests?.enable ?? {};
	const asks = {
		noteApi: enable.noteApi === true,
		dataviewJs: enable.dataviewJs === true,
		network: enable.network === true,
	};
	const empty = scripts.length === 0 && plugins.length === 0 && noteCount === 0
		&& !asks.noteApi && !asks.dataviewJs && !asks.network && globalRequests.length === 0;
	return { scripts, plugins, notes, noteCount, requests: asks, globalRequests, empty };
}
