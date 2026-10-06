// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The bundled demo vault, brought up to date in the user's copy.
//
// A packaged Clew copies Resources/demo-vault to ~/Documents/Clew Demo Vault
// the first time it is opened (main.js#openDemoVault), and nothing touched
// that copy again — so whoever opened the demo once never saw a demo note
// added or improved later (the owner, 2026-10-04: no App Gallery in dev.6,
// then no live ticker). Now each opening, and it says what it did:
//   - ADDS the bundled files the copy was never given;
//   - UPDATES a file the user never changed: its content is still exactly
//     what Clew gave (the hash `.clew/demo-files.json` records) or a version
//     Clew ever shipped (src/main/demo-history.json, every committed version
//     by sha256 — how a copy from before the record, which says nothing, is
//     told from an edited one);
//   - never touches a file the user changed, never brings back one they
//     deleted (a file given before and missing now), and never writes into
//     `.clew/` or any dot path: a vault's plugins and scripts are code.
// A copy with no record (every 0.12.0 copy, dev.6's) is dated by its own
// untouched files: the history says when each version first shipped, and the
// newest among them is the oldest Clew the copy can have come from — a demo
// file shipped by then and missing now was deleted by the user and stays so
// (until 2026-10-05 it came back: Clew-docs' dev.6 copy), one first shipped
// later was never given and is added. A copy with nothing recognisable gets
// everything it lacks.
// A record from 2619e1c (a list, no hashes) counts as given with no hash.
// Electron-free (tests/demo-sync.test.js).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './fs-utils.js';

const MANIFEST = path.join('.clew', 'demo-files.json');

/** Every file under `root`, relative with `/`, no dot names anywhere. */
export function listFiles(root) {
	const out = [];
	const walk = (dir, rel) => {
		let entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			if (e.name.startsWith('.')) continue;
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) walk(path.join(dir, e.name), r);
			else if (e.isFile()) out.push(r);
		}
	};
	walk(root, '');
	return out.sort();
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashes = (root) => new Map(listFiles(root).map((rel) => [rel, sha256(path.join(root, ...rel.split('/')))]));

/** The record in a copy: rel → the hash given (null: given, hash unknown), or null. */
export function readRecord(target) {
	let json;
	try { json = JSON.parse(fs.readFileSync(path.join(target, MANIFEST), 'utf8')); } catch { return null; }
	if (Array.isArray(json?.files)) return new Map(json.files.map((rel) => [rel, null]));
	if (json?.files && typeof json.files === 'object') return new Map(Object.entries(json.files));
	return null;
}

/** When a version of a file first shipped (the history's position), or undefined. */
const shippedAt = (history, rel, hash) => {
	const versions = history[rel];
	return versions && Object.hasOwn(versions, hash) ? versions[hash] : undefined;
};

/**
 * The oldest Clew a copy with no record can have come from: the newest
 * first-shipped position among its files that are a version Clew shipped.
 * Null when none is.
 */
export function shippedSince(current, history) {
	let newest = null;
	for (const [rel, have] of current) {
		const at = shippedAt(history, rel, have);
		if (Number.isInteger(at) && (newest === null || at > newest)) newest = at;
	}
	return newest;
}

/**
 * What to do, and the record after it. Pure.
 *
 * @param {{ bundled: Map<string,string>, current: Map<string,string>,
 *   record: Map<string,string|null>|null,
 *   history?: Record<string, Record<string, number>> }} at
 *   hashes of the bundle's files and the copy's; the copy's record; every
 *   version Clew ever shipped, by file, with when it first shipped
 *   (scripts/gen-demo-history.mjs)
 * @returns {{ add: string[], update: string[], record: Map<string,string|null> }}
 */
export function planDemoSync({ bundled, current, record, history = {} }) {
	const add = [];
	const update = [];
	const next = new Map();
	// No record: what the copy was given is what Clew had shipped by the date
	// its files give it (null: nothing recognisable, so nothing known given).
	const since = record ? null : shippedSince(current, history);
	const firstShipped = (rel) => Math.min(...Object.values(history[rel] ?? {}).filter(Number.isInteger));
	for (const [rel, want] of bundled) {
		const have = current.get(rel);
		const given = record?.get(rel);           // undefined: never given
		if (have === undefined) {
			// Missing: given before means deleted by the user — it stays so.
			// With no record, given is what had shipped by the copy's date.
			if (record?.has(rel)) next.set(rel, given);
			else if (since !== null && firstShipped(rel) <= since) next.set(rel, null);
			else { add.push(rel); next.set(rel, want); }
			continue;
		}
		if (have === want) { next.set(rel, want); continue; }
		const untouched = (given && have === given) || shippedAt(history, rel, have) !== undefined;
		if (untouched) { update.push(rel); next.set(rel, want); }
		else next.set(rel, given ?? null);        // the user's: never touched
	}
	for (const [rel, h] of record ?? []) if (!next.has(rel)) next.set(rel, h);
	return { add, update, record: next };
}

/**
 * Bring `target` (the user's copy) up to date with `source` (the bundle).
 * Returns what it added and what it updated (relative paths).
 */
export function syncDemoVault(source, target, { history = {} } = {}) {
	const plan = planDemoSync({ bundled: hashes(source), current: hashes(target), record: readRecord(target), history });
	const added = [];
	const updated = [];
	const bytes = (rel) => fs.readFileSync(path.join(source, ...rel.split('/')));
	for (const rel of plan.add) {
		const to = path.join(target, ...rel.split('/'));
		if (fs.existsSync(to)) continue;   // a folder or link of that name
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.copyFileSync(path.join(source, ...rel.split('/')), to, fs.constants.COPYFILE_EXCL);
		added.push(rel);
	}
	for (const rel of plan.update) {
		const to = path.join(target, ...rel.split('/'));
		if (!fs.lstatSync(to).isFile()) continue;   // never through a link
		writeFileAtomic(to, bytes(rel));
		updated.push(rel);
	}
	const manifest = path.join(target, MANIFEST);
	const next = JSON.stringify({ version: 2, files: Object.fromEntries([...plan.record].sort(([a], [b]) => a.localeCompare(b))) }, null, '\t');
	let before = null;
	try { before = fs.readFileSync(manifest, 'utf8'); } catch { /* none */ }
	if (before !== next) {
		fs.mkdirSync(path.dirname(manifest), { recursive: true });
		fs.writeFileSync(manifest, next);
	}
	return { added, updated };
}

/** The notice: notes by name first, then a count — added and updated. */
export function demoSyncNotice({ added = [], updated = [] } = {}) {
	// Named as a note ("Features/App Gallery") or an app ("Apps/Ticker"),
	// notes first; anything else only counted.
	const label = (f) => (/\.(md|jmd)$/i.test(f) ? f.replace(/\.(md|jmd)$/i, '') : f.startsWith('Apps/') ? f.split('/').slice(0, 2).join('/') : null);
	const part = (verb, files) => {
		if (!files.length) return null;
		const named = [...new Set(files.map(label).filter(Boolean))].sort((a, b) => a.startsWith('Apps/') - b.startsWith('Apps/'));
		const shown = named.slice(0, 3);
		const rest = files.filter((f) => !shown.includes(label(f))).length;
		if (!shown.length) return `${verb} ${files.length} file${files.length === 1 ? '' : 's'}`;
		return `${verb} ${shown.join(', ')}${rest > 0 ? `, and ${rest} more file${rest === 1 ? '' : 's'}` : ''}`;
	};
	const parts = [part('added', added), part('updated', updated)].filter(Boolean);
	if (!parts.length) return null;
	return `The demo vault is up to date with this version of Clew: ${parts.join('; ')}. Notes you changed were left as they are.`;
}
