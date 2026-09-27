// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The note's own typeface, as font FILES a TeX run can load.
//
// A figure written with `font=note` (src/engine/figures.js) is typeset in
// the face the note is read in — Avenir Next on a Mac, the head of the
// --clew-editor-font stack in styles/themes. mp-tikz-wasm's LuaTeX can load
// any OTF/TTF through fontspec, but only from a file it is handed
// (`mpTikzWasm.addFiles`, preview-client/figures.js): luaotfload's name
// database indexes the bundled fonts alone, so a system face has to arrive
// as bytes and be named by its file name, `\setmainfont{X.ttf}[Path=./]`.
//
// Two facts shape this module. First, macOS ships Avenir Next as a
// TrueType COLLECTION (one .ttc, twelve faces), and a collection is broken
// under the library's `fonts="woff2"` output: dvisvgm keys an embedded face
// by file path, the face index is not part of the key, so four faces named
// from one .ttc collapse into one @font-face and bold and italic draw
// garbled glyphs (glyph ids differ between members). One file per face is
// the workaround, so the four faces are EXTRACTED here — a TTC is a header
// of offsets to per-face table directories over shared table data, and a
// standalone TrueType file is one such directory with its tables copied
// behind it. Second, the faces cannot be bundled (Avenir Next is Apple's,
// Segoe UI Microsoft's), which is why they are read from the machine's own
// font folder at launch into userData, never shipped.
//
// Like main/plugins.js and main/figure-bake.js this module must stay
// importable WITHOUT electron — its extractor is unit-tested under plain
// node — so the directory and the platform are passed in.
import fs from 'node:fs';
import path from 'node:path';

/** The four faces a `\setmainfont` names; the keys are also the file stems. */
export const FACES = ['Regular', 'Bold', 'Italic', 'BoldItalic'];

/** What index.json is called; the preview and the render worker both read it. */
export const INDEX = 'index.json';

/**
 * The note face per platform, in the order the CSS stack resolves it
 * (styles/themes/dark.css: Avenir Next, Avenir, Segoe UI, Cantarell). A
 * `collection` is split by face name; `files` are copied as they are.
 * Cantarell's variable-font build (Cantarell-VF.otf, what current GNOME
 * ships) is deliberately not listed — luaotfload wants a static instance.
 */
export const CANDIDATES = [
	{
		family: 'Avenir Next', platform: 'darwin',
		collection: '/System/Library/Fonts/Avenir Next.ttc',
		subfamilies: { Regular: 'Regular', Bold: 'Bold', Italic: 'Italic', BoldItalic: 'Bold Italic' },
	},
	{
		family: 'Segoe UI', platform: 'win32',
		dirs: (env) => [path.join(env.WINDIR ?? env.SystemRoot ?? 'C:\\Windows', 'Fonts')],
		files: { Regular: 'segoeui.ttf', Bold: 'segoeuib.ttf', Italic: 'segoeuii.ttf', BoldItalic: 'segoeuiz.ttf' },
	},
	{
		family: 'Cantarell', platform: 'linux',
		dirs: () => ['/usr/share/fonts/cantarell', '/usr/share/fonts/opentype/cantarell',
			'/usr/share/fonts/truetype/cantarell', '/usr/share/fonts/abattis-cantarell-fonts'],
		files: { Regular: 'Cantarell-Regular.otf', Bold: 'Cantarell-Bold.otf' },
	},
];

// ---- sfnt / TrueType Collection reading -----------------------------------

const u16 = (buf, at) => buf.readUInt16BE(at);
const u32 = (buf, at) => buf.readUInt32BE(at);
const tag4 = (buf, at) => buf.toString('latin1', at, at + 4);

/** Byte offsets of every face's table directory: one for a plain font, N for a 'ttcf' collection. */
export function faceOffsets(buf) {
	if (tag4(buf, 0) !== 'ttcf') return [0];
	const count = u32(buf, 8);
	return Array.from({ length: count }, (_, i) => u32(buf, 12 + 4 * i));
}

/** A face's table directory: its sfnt version and table records, as the file has them. */
export function tableDirectory(buf, offset) {
	const numTables = u16(buf, offset + 4);
	const records = [];
	for (let i = 0; i < numTables; i++) {
		const at = offset + 12 + 16 * i;
		records.push({ tag: tag4(buf, at), checksum: u32(buf, at + 4), offset: u32(buf, at + 8), length: u32(buf, at + 12) });
	}
	return { sfntVersion: u32(buf, offset), records };
}

/**
 * The family and subfamily a face calls itself, from its `name` table —
 * the typographic pair (ids 16/17) when present, since the legacy pair
 * (1/2) folds weights into the family ("Avenir Next Demi Bold" / "Regular")
 * to suit four-style menus, and the plain pair otherwise. Windows Unicode
 * strings first, Macintosh Roman as the fallback.
 */
export function faceNames(buf, offset) {
	const name = tableDirectory(buf, offset).records.find((r) => r.tag === 'name');
	if (!name) return { family: '', subfamily: '' };
	const base = name.offset;
	const count = u16(buf, base + 2);
	const strings = base + u16(buf, base + 4);
	const found = {};
	for (let i = 0; i < count; i++) {
		const at = base + 6 + 12 * i;
		const platform = u16(buf, at), encoding = u16(buf, at + 2), language = u16(buf, at + 4);
		const id = u16(buf, at + 6), length = u16(buf, at + 8), start = strings + u16(buf, at + 10);
		if (![1, 2, 16, 17].includes(id) || start + length > buf.length) continue;
		let text = null, rank = 0;
		if (platform === 3 && (encoding === 1 || encoding === 10)) {
			// UTF-16BE; Buffer only decodes little-endian, hence the swap.
			text = Buffer.from(buf.subarray(start, start + length)).swap16().toString('utf16le');
			rank = language === 0x409 ? 3 : 2;
		} else if (platform === 1 && encoding === 0) {
			text = buf.toString('latin1', start, start + length);
			rank = 1;
		}
		if (text !== null && rank > (found[id]?.rank ?? 0)) found[id] = { text, rank };
	}
	const pick = (typographic, legacy) => found[typographic]?.text ?? found[legacy]?.text ?? '';
	return { family: pick(16, 1), subfamily: pick(17, 2) };
}

/**
 * One face of a collection as a standalone font file: a fresh table
 * directory, the face's tables copied behind it (4-byte aligned, as the
 * format requires), and `head.checkSumAdjustment` recomputed so the file
 * sums to the magic 0xB1B0AFBA a strict reader checks. Per-table checksums
 * are carried over unchanged — the bytes they cover are the same bytes —
 * except `head`'s, which the spec defines over the table with its
 * adjustment field zeroed and which a collection's directory therefore
 * carries for a different adjustment than this file's: recomputed (the
 * Clew-iOS port, building the same faces from CoreText tables, came out
 * byte-identical everywhere but that one directory word).
 */
export function extractFace(buf, offset) {
	const { sfntVersion, records } = tableDirectory(buf, offset);
	const headerSize = 12 + 16 * records.length;
	const align = (n) => (n + 3) & ~3;
	let total = headerSize;
	const placed = records.map((r) => {
		const at = total;
		total = align(total + r.length);
		return { ...r, at };
	});
	const out = Buffer.alloc(total);
	out.writeUInt32BE(sfntVersion, 0);
	out.writeUInt16BE(records.length, 4);
	// searchRange / entrySelector / rangeShift, per the sfnt header spec.
	let power = 1, selector = 0;
	while (power * 2 <= records.length) { power *= 2; selector += 1; }
	out.writeUInt16BE(power * 16, 6);
	out.writeUInt16BE(selector, 8);
	out.writeUInt16BE(records.length * 16 - power * 16, 10);
	placed.forEach((r, i) => {
		const at = 12 + 16 * i;
		out.write(r.tag, at, 4, 'latin1');
		out.writeUInt32BE(r.checksum, at + 4);
		out.writeUInt32BE(r.at, at + 8);
		out.writeUInt32BE(r.length, at + 12);
		buf.copy(out, r.at, r.offset, r.offset + r.length);
	});
	const head = placed.find((r) => r.tag === 'head');
	if (head) {
		out.writeUInt32BE(0, head.at + 8);
		// The head record's own checksum, over the table with the adjustment zeroed.
		out.writeUInt32BE(tableChecksum(out, head.at, head.length), 12 + 16 * placed.indexOf(head) + 4);
		let sum = 0;
		for (let i = 0; i < out.length; i += 4) sum = (sum + out.readUInt32BE(i)) >>> 0;
		out.writeUInt32BE((0xB1B0AFBA - sum) >>> 0, head.at + 8);
	}
	return out;
}

/** A table's checksum as the directory records it: the sum of its 32-bit words, zero-padded to a multiple of four. */
export function tableChecksum(buf, at, length) {
	let sum = 0;
	for (let i = 0; i < length; i += 4) {
		let word = 0;
		for (let b = 0; b < 4; b++) word = (word << 8) | (i + b < length ? buf[at + i + b] : 0);
		sum = (sum + (word >>> 0)) >>> 0;
	}
	return sum;
}

/** '.otf' for a CFF-flavoured face ('OTTO'), '.ttf' for TrueType outlines. */
export function faceExtension(buf, offset = 0) {
	return u32(buf, offset) === 0x4F54544F ? '.otf' : '.ttf';
}

/** Whole-file checksum, for tests and for anyone checking an extracted face. */
export function fileChecksum(buf) {
	let sum = 0;
	for (let i = 0; i + 4 <= buf.length; i += 4) sum = (sum + buf.readUInt32BE(i)) >>> 0;
	return sum;
}

// ---- preparing userData/note-fonts ----------------------------------------

/** The index as written, or null when nothing has been prepared. */
export function readNoteFonts(dir) {
	try { return JSON.parse(fs.readFileSync(path.join(dir, INDEX), 'utf8')); } catch { return null; }
}

/** The faces as `{ 'NoteFont-Regular.ttf': Uint8Array, … }` — the shape `addFiles` takes. */
export function noteFontFiles(dir) {
	const index = readNoteFonts(dir);
	const files = {};
	for (const name of Object.values(index?.faces ?? {})) {
		try { files[name] = new Uint8Array(fs.readFileSync(path.join(dir, name))); } catch { /* listed but gone */ }
	}
	return files;
}

/**
 * Find the platform's note face and lay its files out in `dir`, one per
 * face, named NoteFont-<Face>.<ext> beside an index.json naming them:
 *
 *   { family, source, mtimeMs, faces: { Regular: 'NoteFont-Regular.ttf', … } }
 *
 * Synchronous and cheap (a 4 MB collection, four writes), so it runs at
 * app start before any render worker spawns. A second run over the same
 * source file (same path, same mtime) is a no-op; a macOS upgrade that
 * replaces the collection re-extracts. A platform with no listed face
 * writes an index with no faces, which the wrapper reads as "fontspec's
 * own defaults" and the manual explains.
 */
export function prepareNoteFonts(dir, { platform = process.platform, env = process.env } = {}) {
	fs.mkdirSync(dir, { recursive: true });
	for (const candidate of CANDIDATES) {
		if (candidate.platform !== platform) continue;
		const prepared = candidate.collection
			? fromCollection(dir, candidate)
			: fromFiles(dir, candidate, env);
		if (prepared) return prepared;
	}
	return writeIndex(dir, { family: null, source: null, mtimeMs: 0, faces: {} });
}

function current(dir, source) {
	const index = readNoteFonts(dir);
	if (!index || index.source !== source) return null;
	let mtimeMs;
	try { mtimeMs = fs.statSync(source).mtimeMs; } catch { return null; }
	if (index.mtimeMs !== mtimeMs) return null;
	for (const name of Object.values(index.faces)) {
		if (!fs.existsSync(path.join(dir, name))) return null;
	}
	return index;
}

function writeIndex(dir, index) {
	for (const entry of fs.readdirSync(dir)) {
		if (entry.startsWith('NoteFont-') && !Object.values(index.faces).includes(entry)) {
			fs.rmSync(path.join(dir, entry), { force: true });
		}
	}
	fs.writeFileSync(path.join(dir, INDEX), JSON.stringify(index, null, '\t'));
	return index;
}

function fromCollection(dir, { family, collection, subfamilies }) {
	if (!fs.existsSync(collection)) return null;
	const kept = current(dir, collection);
	if (kept) return kept;
	const buf = fs.readFileSync(collection);
	const wanted = new Map(Object.entries(subfamilies).map(([face, sub]) => [sub.toLowerCase(), face]));
	const faces = {};
	for (const offset of faceOffsets(buf)) {
		const names = faceNames(buf, offset);
		if (names.family !== family) continue;
		const face = wanted.get(names.subfamily.toLowerCase());
		if (!face || faces[face]) continue;
		const name = `NoteFont-${face}${faceExtension(buf, offset)}`;
		fs.writeFileSync(path.join(dir, name), extractFace(buf, offset));
		faces[face] = name;
	}
	if (!faces.Regular) return null;
	return writeIndex(dir, { family, source: collection, mtimeMs: fs.statSync(collection).mtimeMs, faces });
}

function fromFiles(dir, { family, dirs, files }, env) {
	const found = dirs(env).find((d) => fs.existsSync(path.join(d, files.Regular)));
	if (!found) return null;
	const source = path.join(found, files.Regular);
	const kept = current(dir, source);
	if (kept) return kept;
	const faces = {};
	for (const [face, file] of Object.entries(files)) {
		const from = path.join(found, file);
		if (!fs.existsSync(from)) continue;
		const name = `NoteFont-${face}${path.extname(file).toLowerCase()}`;
		fs.copyFileSync(from, path.join(dir, name));
		faces[face] = name;
	}
	return writeIndex(dir, { family, source, mtimeMs: fs.statSync(source).mtimeMs, faces });
}
