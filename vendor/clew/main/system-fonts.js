// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The machine's own fonts, found by FAMILY name, for a figure whose preamble
// names one (`\setmainfont{Optima}` — shared/figure-fonts.js reads which).
// mp-tikz-wasm's LuaTeX loads only files it is handed (`addFiles`), and from
// 0.4.0 luaotfload's scan-local finds every style of a supplied family by
// name, a whole `.ttc` included (0.3.2's FontIndex fix). So: an index of
// family → files over the system's font folders, built once (only each file's
// table directories and `name` table are read — some collections are 180 MB),
// kept in userData against the folders' mtimes, and the files a family names
// served as they are (protocol.js, `__clew_assets__/systemfonts/`). Never
// shipped, never copied into a vault.
//
// Electron-free (tested under plain node): the folders and the index file are
// passed in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The folders a platform keeps its fonts in, most specific last. */
export function fontDirs(platform = process.platform, env = process.env) {
	const home = env.HOME ?? os.homedir();
	if (platform === 'darwin') {
		return ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts', path.join(home, 'Library', 'Fonts')];
	}
	if (platform === 'win32') {
		const windir = env.WINDIR ?? 'C:\\Windows';
		return [path.join(windir, 'Fonts'), ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts')] : [])];
	}
	return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.local', 'share', 'fonts'), path.join(home, '.fonts')];
}

const FONT_EXT = /\.(ttf|otf|ttc|otc)$/i;
/** A family's files past this many bytes, together, are not handed over. */
export const FAMILY_LIMIT = 64 * 1024 * 1024;

/** Read `length` bytes at `position` of an open file. */
function readAt(fd, position, length) {
	const buf = Buffer.alloc(length);
	const got = fs.readSync(fd, buf, 0, length, position);
	return got === length ? buf : buf.subarray(0, got);
}

/** The family names one name table gives: typographic (16) and legacy (1). */
function namesIn(table) {
	const out = new Set();
	if (table.length < 6) return out;
	const count = table.readUInt16BE(2);
	const strings = table.readUInt16BE(4);
	for (let i = 0; i < count; i++) {
		const at = 6 + 12 * i;
		if (at + 12 > table.length) break;
		const platform = table.readUInt16BE(at), encoding = table.readUInt16BE(at + 2);
		const id = table.readUInt16BE(at + 6), length = table.readUInt16BE(at + 8);
		const start = strings + table.readUInt16BE(at + 10);
		if ((id !== 1 && id !== 16) || start + length > table.length) continue;
		if (platform === 3 && (encoding === 1 || encoding === 10)) {
			out.add(Buffer.from(table.subarray(start, start + length)).swap16().toString('utf16le'));
		} else if (platform === 1 && encoding === 0) {
			out.add(table.toString('latin1', start, start + length));
		}
	}
	return out;
}

/** Every family name a font file (any face of a collection) carries. */
export function familiesOfFile(file) {
	const fd = fs.openSync(file, 'r');
	try {
		const head = readAt(fd, 0, 12);
		if (head.length < 12) return [];
		const offsets = [];
		if (head.toString('latin1', 0, 4) === 'ttcf') {
			const n = Math.min(head.readUInt32BE(8), 256);
			const list = readAt(fd, 12, 4 * n);
			for (let i = 0; i + 4 <= list.length; i += 4) offsets.push(list.readUInt32BE(i));
		} else {
			offsets.push(0);
		}
		const families = new Set();
		for (const offset of offsets) {
			const dir = readAt(fd, offset, 12);
			if (dir.length < 12) continue;
			const tables = Math.min(dir.readUInt16BE(4), 512);
			const records = readAt(fd, offset + 12, 16 * tables);
			for (let i = 0; i + 16 <= records.length; i += 16) {
				if (records.toString('latin1', i, i + 4) !== 'name') continue;
				const at = records.readUInt32BE(i + 8), length = records.readUInt32BE(i + 12);
				if (length > 0 && length < 4 * 1024 * 1024) for (const f of namesIn(readAt(fd, at, length))) families.add(f);
			}
		}
		return [...families].filter(Boolean);
	} finally {
		fs.closeSync(fd);
	}
}

/** Font files under `dir`, recursively (Linux keeps them in subfolders). */
function fontFiles(dir, out = [], depth = 0) {
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
	for (const e of entries) {
		const abs = path.join(dir, e.name);
		if (e.isDirectory() && depth < 4) fontFiles(abs, out, depth + 1);
		else if (e.isFile() && FONT_EXT.test(e.name)) out.push(abs);
	}
	return out;
}

const mtimeOf = (dir) => { try { return fs.statSync(dir).mtimeMs; } catch { return 0; } };

/**
 * family (lowercased) → files, for these folders. `cacheFile` keeps it
 * between launches against the folders' mtimes (a font installed or removed
 * changes its folder's).
 */
export function buildIndex(dirs, cacheFile = null) {
	const stamp = dirs.map((d) => `${d}:${mtimeOf(d)}`).join('|');
	if (cacheFile) {
		try {
			const kept = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
			if (kept?.stamp === stamp && kept.families) return new Map(Object.entries(kept.families));
		} catch { /* none, or stale */ }
	}
	const families = new Map();
	for (const dir of dirs) {
		for (const file of fontFiles(dir)) {
			let names = [];
			try { names = familiesOfFile(file); } catch { continue; }
			for (const name of names) {
				const key = name.toLowerCase();
				if (!families.has(key)) families.set(key, []);
				if (!families.get(key).includes(file)) families.get(key).push(file);
			}
		}
	}
	if (cacheFile) {
		try {
			fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
			fs.writeFileSync(cacheFile, JSON.stringify({ stamp, families: Object.fromEntries(families) }));
		} catch { /* a cache, nothing more */ }
	}
	return families;
}

/**
 * The files to hand over for a family name, as the index has them — none
 * when the family is unknown, or larger together than FAMILY_LIMIT.
 */
export function familyFiles(index, family) {
	const files = (index.get(String(family).toLowerCase()) ?? []).filter((f) => fs.existsSync(f));
	const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
	return bytes > FAMILY_LIMIT ? [] : files;
}
