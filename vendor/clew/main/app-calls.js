// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What an app may ask Clew to do, decided HERE in main (docs/dev/
// frame-bridge.md §8, §9): the app page's bridge host relays each port
// request as `{ key, notePath, method, params }`, and every method names the
// capability it needs, checked against the DEVICE's grants at call time —
// a revoked grant answers `denied` on the next call. Tier 1: the read side
// (phase 3) and the write side (phase 4). A write to a note is AUTHORIZED
// here and PERFORMED by the host through the editor pool (§10) — the
// result `{ perform, path }` tells it what — so undo, the dirty dot,
// auto-save, the conflict banner and history apply to an app's edit exactly
// as to the user's; `notes.create` (never overwriting) happens here.
//
// Paths: text types only, never hidden (dotfiles, .clew, .obsidian, the
// vault's own hidden list), and — in a vault this device has NOT trusted —
// clamped to the vault root by REALPATH (§6, R1): Clew follows a vault's
// symlinks, and a vault someone sends can carry one pointing at the home
// directory. An app's own files live in `<app>/data/`, clamped there.
import fs from 'node:fs';
import path from 'node:path';
import { parseProperties } from '../shared/frontmatter.js';
import { writeFileAtomic } from './fs-utils.js';
import { DATA_DIR } from './app-frames.js';

export const TEXT_EXT = ['.md', '.jmd', '.canvas', '.base', '.json', '.txt', '.csv', '.bib'];
const NOTE_TYPES = /\.(md|jmd|canvas|base)$/i;
export const FILE_LIMIT = 25 * 1024 * 1024;
export const APP_LIMIT = 250 * 1024 * 1024;
const READ_LIMIT = 10 * 1024 * 1024;

/** An error the app is told about by code (§8). */
export function appError(code, message) {
	const err = new Error(message);
	err.code = code;
	return err;
}

const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

/** A vault text file an app may read: its absolute path, or an error. */
export function vaultTextFile(ctx, rel) {
	const clean = String(rel ?? '').replace(/^\/+/, '');
	if (!clean || clean.split('/').includes('..') || clean.includes('\0')) throw appError('bad-params', `not a vault path: ${JSON.stringify(rel)}`);
	if (!TEXT_EXT.some((ext) => clean.toLowerCase().endsWith(ext))) throw appError('denied', `not a text file an app may read: ${clean}`);
	if (ctx.excludes.isHidden(clean)) throw appError('not-found', `no such file: ${clean}`);
	const abs = path.join(ctx.root, clean);
	if (ctx.restricted) {
		let real;
		let realRoot;
		try { real = fs.realpathSync(abs); realRoot = fs.realpathSync(ctx.root); } catch { throw appError('not-found', `no such file: ${clean}`); }
		if (!inside(real, realRoot)) throw appError('not-found', `no such file: ${clean}`);
	}
	return abs;
}

/** A NEW vault text file's path: as vaultTextFile, but the realpath clamp
 *  (restricted vaults) is taken on its nearest existing folder. */
export function newVaultFile(ctx, rel) {
	const clean = String(rel ?? '').replace(/^\/+/, '');
	if (!clean || clean.split('/').includes('..') || clean.includes('\0')) throw appError('bad-params', `not a vault path: ${JSON.stringify(rel)}`);
	if (!TEXT_EXT.some((ext) => clean.toLowerCase().endsWith(ext))) throw appError('denied', `not a text file: ${clean}`);
	if (ctx.excludes.isHidden(clean)) throw appError('denied', `a hidden path: ${clean}`);
	const abs = path.join(ctx.root, clean);
	if (ctx.restricted) {
		let probe = path.dirname(abs);
		while (!fs.existsSync(probe) && inside(probe, ctx.root) && probe !== ctx.root) probe = path.dirname(probe);
		let real;
		let realRoot;
		try { real = fs.realpathSync(probe); realRoot = fs.realpathSync(ctx.root); } catch { throw appError('denied', `outside the vault: ${clean}`); }
		if (!inside(real, realRoot)) throw appError('denied', `outside the vault: ${clean}`);
	}
	return abs;
}

/** A path inside the app's data folder: its absolute path, or an error. */
export function appDataPath(ctx, rel, { allowRoot = false } = {}) {
	const clean = String(rel ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
	if (!clean && !allowRoot) throw appError('bad-params', 'a path inside the app\'s data folder is needed');
	const segments = clean ? clean.split('/') : [];
	if (segments.some((s) => s === '..' || s === '' || s.includes('\0'))) throw appError('bad-params', `not a data path: ${JSON.stringify(rel)}`);
	if (segments.some((s) => s.startsWith('.'))) throw appError('denied', `names starting with "." are not allowed: ${clean}`);
	if (NOTE_TYPES.test(clean)) throw appError('denied', `notes are not app data (that is notes.create): ${clean}`);
	const dataDir = path.join(ctx.app.abs, DATA_DIR);
	const abs = path.join(dataDir, ...segments);
	if (!inside(abs, dataDir)) throw appError('bad-params', `not a data path: ${clean}`);
	// A link in the data folder must not reach out of it.
	let realData = null;
	try { realData = fs.realpathSync(dataDir); } catch { /* not created yet */ }
	if (realData) {
		let probe = abs;
		while (!fs.existsSync(probe) && probe !== dataDir) probe = path.dirname(probe);
		let real;
		try { real = fs.realpathSync(probe); } catch { real = realData; }
		if (!inside(real, realData)) throw appError('denied', `outside the app's data folder: ${clean}`);
	}
	return abs;
}

function folderSize(dir) {
	let total = 0;
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
	for (const entry of entries) {
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) total += folderSize(abs);
		else if (entry.isFile()) { try { total += fs.statSync(abs).size; } catch { /* gone */ } }
	}
	return total;
}

/**
 * Is a vault path one this app may even LEARN of? Never a hidden one; in a
 * restricted vault, only one whose realpath is inside the vault — the
 * index follows symlinks, so without this a list, a search snippet or a
 * backlink would name (or quote) a file the vault merely links to.
 */
function visible(ctx, rel) {
	if (ctx.excludes.isHidden(rel)) return false;
	if (!ctx.restricted) return true;
	ctx.realRoot ??= (() => { try { return fs.realpathSync(ctx.root); } catch { return ctx.root; } })();
	try { return inside(fs.realpathSync(path.join(ctx.root, rel)), ctx.realRoot); } catch { return false; }
}

const readText = (abs) => {
	let stat;
	try { stat = fs.statSync(abs); } catch { throw appError('not-found', 'no such file'); }
	if (!stat.isFile()) throw appError('not-found', 'no such file');
	if (stat.size > READ_LIMIT) throw appError('too-large', 'larger than an app may read at once');
	return fs.readFileSync(abs, 'utf8');
};

// ---- app.secrets: small strings kept on this DEVICE only (§9c) -----------
// The host hands `ctx.secrets` already scoped to the calling app (vault
// identity × manifest id, from the port): main/app-secrets.js on the desktop,
// the Keychain on Clew-iOS — so its methods may answer with a promise. The
// limits live here, shared; a value is never put in an error message.
const SECRET_NAME = /^[A-Za-z0-9._-]{1,64}$/;
export const SECRET_LIMIT = 8 * 1024;   // bytes of UTF-8
export const SECRETS_PER_APP = 32;

function secretName(p) {
	const name = p?.name;
	if (typeof name !== 'string' || !SECRET_NAME.test(name)) throw appError('bad-params', 'a secret\'s name is 1–64 of A–Z a–z 0–9 . _ -');
	return name;
}

function secretStore(ctx) {
	if (!ctx.secrets) throw appError('unavailable', 'secrets are not kept on this device');
	return ctx.secrets;
}

/**
 * The methods, each with the capability it needs. `ctx`: { root, restricted,
 * excludes, notePath, app, granted (Set), indexer, search, kv, clipboard,
 * secrets }. A `run` may return a promise (secrets on Clew-iOS).
 */
export const METHODS = {
	// ---- note.read / notes.read ------------------------------------------------
	'notes.read': {
		cap: (ctx, p) => (ctx.granted.has('notes.read') || (ctx.granted.has('note.read') && (p?.path ?? ctx.notePath) === ctx.notePath)),
		capName: 'note.read',
		run: (ctx, p) => readText(vaultTextFile(ctx, p?.path ?? ctx.notePath)),
	},
	'properties.get': {
		cap: (ctx, p) => (ctx.granted.has('notes.read') || (ctx.granted.has('note.read') && (p?.path ?? ctx.notePath) === ctx.notePath)),
		capName: 'note.read',
		run: (ctx, p) => {
			const parsed = parseProperties(readText(vaultTextFile(ctx, p?.path ?? ctx.notePath)));
			return Object.fromEntries((parsed?.entries ?? []).map((e) => [e.key, e.value]));
		},
	},
	// ---- query ------------------------------------------------------------
	'notes.list': { cap: 'query', run: (ctx) => [...ctx.indexer.notes.keys()].filter((p) => visible(ctx, p)).sort() },
	'search': { cap: 'query', run: (ctx, p) => ctx.search.search(String(p?.query ?? '')).filter((hit) => visible(ctx, hit.path)) },
	'index.get': {
		cap: 'query',
		run: (ctx, p) => {
			const rel = String(p?.path ?? '');
			const meta = visible(ctx, rel) ? ctx.indexer.notes.get(rel) : null;
			return meta ? structuredClone(meta) : null;
		},
	},
	'index.backlinks': {
		cap: 'query',
		run: (ctx, p) => {
			const target = String(p?.path ?? ctx.notePath ?? '');
			const out = [];
			if (!visible(ctx, target)) return out;
			for (const [from, meta] of ctx.indexer.notes) {
				if ((meta.links ?? []).some((l) => l.resolved === target) && visible(ctx, from)) out.push(from);
			}
			return out.sort();
		},
	},
	// ---- app.kv: the app's own namespace in clewdata.json ------------------
	'kv.get': { cap: 'app.kv', run: (ctx, p) => ctx.kv.get(kvKey(ctx, p?.key)) ?? null },
	'kv.set': {
		cap: 'app.kv',
		run: (ctx, p) => {
			const size = JSON.stringify(p?.value ?? null).length;
			if (size > 256 * 1024) throw appError('too-large', 'a kv value is limited to 256 KB; use app.files for more');
			return ctx.kv.set(kvKey(ctx, p?.key), p?.value);
		},
	},
	'kv.delete': { cap: 'app.kv', run: (ctx, p) => ctx.kv.delete(kvKey(ctx, p?.key)) },
	'kv.list': {
		cap: 'app.kv',
		run: (ctx, p) => {
			const base = `apps/${ctx.app.manifest.id}/`;
			const all = ctx.kv.list(base + String(p?.prefix ?? ''));
			return Object.fromEntries(Object.entries(all).map(([k, v]) => [k.slice(base.length), v]));
		},
	},
	// ---- app.files: the app's own data folder ------------------------------
	'files.list': {
		cap: 'app.files',
		run: (ctx, p) => {
			const dir = appDataPath(ctx, p?.path ?? '', { allowRoot: true });
			let entries;
			try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
			return entries.filter((e) => !e.name.startsWith('.')).map((e) => {
				let size = null;
				if (e.isFile()) { try { size = fs.statSync(path.join(dir, e.name)).size; } catch { /* gone */ } }
				return { name: e.name, kind: e.isDirectory() ? 'folder' : 'file', size };
			}).sort((a, b) => a.name.localeCompare(b.name));
		},
	},
	'files.read': {
		cap: 'app.files',
		run: (ctx, p) => {
			const abs = appDataPath(ctx, p?.path);
			let stat;
			try { stat = fs.statSync(abs); } catch { throw appError('not-found', `no such file: ${p?.path}`); }
			if (!stat.isFile()) throw appError('not-found', `not a file: ${p?.path}`);
			if (stat.size > FILE_LIMIT) throw appError('too-large', 'larger than 25 MB');
			const bytes = fs.readFileSync(abs);
			return p?.as === 'bytes' ? new Uint8Array(bytes) : bytes.toString('utf8');
		},
	},
	'files.write': {
		cap: 'app.files',
		run: (ctx, p) => {
			const abs = appDataPath(ctx, p?.path);
			const data = typeof p?.data === 'string' ? Buffer.from(p.data, 'utf8')
				: p?.data instanceof Uint8Array ? Buffer.from(p.data)
					: p?.data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(p.data))
						: null;
			if (!data) throw appError('bad-params', 'data must be text or bytes');
			if (data.length > FILE_LIMIT) throw appError('too-large', 'a file is limited to 25 MB');
			const dataDir = path.join(ctx.app.abs, DATA_DIR);
			let existing = 0;
			try { existing = fs.statSync(abs).size; } catch { /* new */ }
			if (folderSize(dataDir) - existing + data.length > APP_LIMIT) throw appError('too-large', 'an app\'s data is limited to 250 MB');
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			writeFileAtomic(abs, data);
			return { path: String(p.path), size: data.length };
		},
	},
	'files.delete': {
		cap: 'app.files',
		run: (ctx, p) => {
			const abs = appDataPath(ctx, p?.path);
			let stat;
			try { stat = fs.statSync(abs); } catch { throw appError('not-found', `no such file: ${p?.path}`); }
			if (stat.isDirectory()) fs.rmdirSync(abs);   // empty folders only
			else fs.unlinkSync(abs);
			return true;
		},
	},
	'files.mkdir': {
		cap: 'app.files',
		run: (ctx, p) => {
			fs.mkdirSync(appDataPath(ctx, p?.path), { recursive: true });
			return true;
		},
	},
};

/** The note an app's write names, authorized: its vault path, or an error. */
function writableNote(ctx, rel, { mustExist = true } = {}) {
	const abs = vaultTextFile(ctx, rel);
	if (mustExist && !fs.existsSync(abs)) throw appError('not-found', `no such note: ${rel}`);
	return String(rel).replace(/^\/+/, '');
}

/** The write capability for a path: `note.write` covers the embedding note. */
const mayWrite = (ctx, p) => ctx.granted.has('notes.write')
	|| (ctx.granted.has('note.write') && (p?.path ?? ctx.notePath) === ctx.notePath);

Object.assign(METHODS, {
	// ---- note.write / notes.write — performed by the host, through the pool --
	'notes.write': {
		cap: mayWrite, capName: 'note.write',
		run: (ctx, p) => {
			if (typeof p?.content !== 'string') throw appError('bad-params', 'notes.write needs content (text)');
			if (p.content.length > 1024 * 1024) throw appError('too-large', 'a write is limited to 1 MB');
			return { perform: 'write', path: writableNote(ctx, p.path ?? ctx.notePath) };
		},
	},
	'notes.append': {
		cap: mayWrite, capName: 'note.write',
		run: (ctx, p) => {
			if (typeof p?.text !== 'string') throw appError('bad-params', 'notes.append needs text');
			return { perform: 'append', path: writableNote(ctx, p.path ?? ctx.notePath) };
		},
	},
	'properties.set': {
		cap: mayWrite, capName: 'note.write',
		run: (ctx, p) => {
			if (typeof p?.key !== 'string' || !p.key.trim()) throw appError('bad-params', 'properties.set needs a key');
			const rel = writableNote(ctx, p.path ?? ctx.notePath);
			if (!/\.(md|jmd)$/i.test(rel)) throw appError('denied', 'properties belong to notes');
			return { perform: 'properties', path: rel };
		},
	},
	// ---- notes.create — never overwrites -------------------------------------
	'notes.create': {
		cap: 'notes.create',
		run: (ctx, p) => {
			const rel = String(p?.path ?? '').replace(/^\/+/, '');
			if (!/\.(md|jmd)$/i.test(rel)) throw appError('bad-params', 'a new note is a .md or .jmd path');
			const abs = newVaultFile(ctx, rel);
			const content = typeof p?.content === 'string' ? p.content : '';
			if (content.length > 1024 * 1024) throw appError('too-large', 'a note is limited to 1 MB here');
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			try {
				fs.writeFileSync(abs, content, { flag: 'wx' });
			} catch (err) {
				if (err.code === 'EEXIST') throw appError('conflict', `${rel} already exists — notes.create never overwrites`);
				throw err;
			}
			return { created: rel };
		},
	},
	// ---- editor.insert / find / clipboard — the host's, once allowed ----------
	'editor.insert': {
		cap: 'editor.insert',
		run: (ctx, p) => {
			if (typeof p?.text !== 'string') throw appError('bad-params', 'editor.insert needs text');
			if (p.text.length > 256 * 1024) throw appError('too-large', 'an insert is limited to 256 KB');
			return { perform: 'insert', path: ctx.notePath };
		},
	},
	'find.show': {
		cap: 'find',
		run: (ctx, p) => ({ perform: 'find', path: ctx.notePath, query: String(p?.query ?? '').slice(0, 1000) }),
	},
	'clipboard.copy': {
		cap: 'clipboard',
		run: (ctx, p) => {
			if (typeof p?.text !== 'string') throw appError('bad-params', 'clipboard.copy needs text');
			if (p.text.length > 1024 * 1024) throw appError('too-large', 'a copy is limited to 1 MB');
			ctx.clipboard.writeText(p.text);
			return true;
		},
	},
	'clipboard.paste': { cap: 'clipboard', run: (ctx) => ctx.clipboard.readText() },
	// ---- app.secrets --------------------------------------------------------
	'secrets.get': {
		cap: 'app.secrets',
		run: async (ctx, p) => (await secretStore(ctx).get(secretName(p))) ?? null,
	},
	'secrets.set': {
		cap: 'app.secrets',
		run: async (ctx, p) => {
			const name = secretName(p);
			if (typeof p?.value !== 'string') throw appError('bad-params', 'a secret is a string');
			if (new TextEncoder().encode(p.value).length > SECRET_LIMIT) throw appError('too-large', 'a secret is limited to 8 KB');
			const store = secretStore(ctx);
			const names = await store.names();
			if (!names.includes(name) && names.length >= SECRETS_PER_APP) throw appError('too-many', `an app keeps at most ${SECRETS_PER_APP} secrets`);
			await store.set(name, p.value);
			return true;
		},
	},
	'secrets.delete': {
		cap: 'app.secrets',
		run: async (ctx, p) => Boolean(await secretStore(ctx).delete(secretName(p))),
	},
});

function kvKey(ctx, key) {
	if (typeof key !== 'string' || !key || key.length > 200) throw appError('bad-params', 'a kv key is a non-empty string of at most 200 characters');
	return `apps/${ctx.app.manifest.id}/${key}`;
}

/**
 * Run one request. Resolves to `{ ok: true, result }` or `{ ok: false,
 * error: { code, message } }` — never rejects. Always a promise: a method may
 * answer asynchronously (secrets in the Keychain, on Clew-iOS).
 */
export async function callApp(ctx, method, params) {
	const spec = Object.hasOwn(METHODS, method) ? METHODS[method] : null;
	if (!spec) return { ok: false, error: { code: 'unknown-method', message: `no method ${method}` } };
	const allowed = typeof spec.cap === 'function' ? spec.cap(ctx, params) : ctx.granted.has(spec.cap);
	if (!allowed) {
		const name = typeof spec.cap === 'string' ? spec.cap : spec.capName;
		return { ok: false, error: { code: 'denied', message: `${method} needs "${name}", which this app has not been granted here` } };
	}
	try {
		return { ok: true, result: await spec.run(ctx, params ?? {}) };
	} catch (err) {
		return { ok: false, error: { code: err.code && typeof err.code === 'string' && !/^E[A-Z]+$/.test(err.code) ? err.code : 'internal', message: String(err.message ?? err) } };
	}
}
