/*
	Attachments recorded in a BibTeX entry — the file(s) a reference points at on
	disk. Consumed by the \citefile command in citations.js; nothing else in the
	pipeline needs the raw .bib, so this module owns reading it.

	Two conventions are understood:

	  • BibDesk's `Bdsk-File-N`, a base64-encoded binary plist holding
	    `relativePath` (a plain string, relative to the .bib) and `bookmark`
	    (macOS bookmark data — the alias that survives the file being moved).
	  • The JabRef / Zotero `file` field: `Description:/path/to/it.pdf:PDF`,
	    semicolon-separated for several, with any part possibly empty.

	**BibDesk numbering is sparse.** It does not renumber when an attachment is
	removed, so an entry's only attachment is routinely `Bdsk-File-2` with no
	`Bdsk-File-1` (every attachment in the author's own bibliography is like
	this). Attachments are therefore returned as a dense list in ascending field
	order, and \citefile's index selects within THAT — `file=1` is the first
	attachment present, whatever it happens to be numbered.

	Resolution, in order, stopping at the first path that exists:
	  1. `relativePath` against the .bib's own directory — right when the
	     Bibliography key points at the live BibDesk file;
	  2. the bookmark's path components — the absolute path as recorded when the
	     attachment was linked, which is what saves a .bib that has been COPIED
	     away from the folder its relative paths were written against.
	If neither exists the first candidate is still returned (with `exists: false`)
	so the caller can emit the link and warn, rather than silently drop it.
*/

import fs from 'fs';
import path from 'path';
import { bibliographyFiles } from './bibliographies.js';

/* --- binary property lists (bplist00) ---------------------------------------- */

// A minimal reader: enough of the format for BibDesk's two-key dictionary
// (strings, data, integers, arrays, dictionaries). Objects live at offsets given
// by a table at the end; the trailer says how wide the offsets and refs are.
function parseBplist(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < 40) return null;
	if (buf.subarray(0, 8).toString('latin1') !== 'bplist00') return null;

	const trailer = buf.length - 32;
	const offsetSize = buf[trailer + 6];
	const refSize = buf[trailer + 7];
	const numObjects = Number(buf.readBigUInt64BE(trailer + 8));
	const topObject = Number(buf.readBigUInt64BE(trailer + 16));
	const tableOffset = Number(buf.readBigUInt64BE(trailer + 24));

	const readUInt = (pos, size) => {
		let value = 0;
		for (let i = 0; i < size; i++) value = value * 256 + buf[pos + i];
		return value;
	};

	const offsets = [];
	for (let i = 0; i < numObjects; i++) offsets.push(readUInt(tableOffset + i * offsetSize, offsetSize));

	function readObject(index, depth = 0) {
		if (depth > 16 || index >= offsets.length) return null;   // cycle guard
		let pos = offsets[index];
		const marker = buf[pos++];
		const type = marker >> 4;
		const low = marker & 0x0f;

		// A count of 0x0f means the real count follows as an integer object.
		const count = () => {
			if (low !== 0x0f) return low;
			const sizeMarker = buf[pos++];
			const bytes = 1 << (sizeMarker & 0x0f);
			const n = readUInt(pos, bytes);
			pos += bytes;
			return n;
		};

		switch (type) {
			case 0x1: return readUInt(pos, 1 << low);                       // integer
			case 0x4: { const n = count(); return buf.subarray(pos, pos + n); }        // data
			case 0x5: { const n = count(); return buf.subarray(pos, pos + n).toString('latin1'); }   // ASCII
			case 0x6: { const n = count(); return buf.subarray(pos, pos + n * 2).swap16().toString('utf16le'); }   // UTF-16BE
			case 0xa: {                                                     // array
				const n = count();
				const items = [];
				for (let i = 0; i < n; i++) items.push(readObject(readUInt(pos + i * refSize, refSize), depth + 1));
				return items;
			}
			case 0xd: {                                                     // dictionary
				const n = count();
				const dict = {};
				for (let i = 0; i < n; i++) {
					const key = readObject(readUInt(pos + i * refSize, refSize), depth + 1);
					const value = readObject(readUInt(pos + (n + i) * refSize, refSize), depth + 1);
					if (typeof key === 'string') dict[key] = value;
				}
				return dict;
			}
			default: return null;
		}
	}

	try { return readObject(topObject); } catch { return null; }
}

/* --- macOS bookmark data ------------------------------------------------------ */

// The path components of a bookmark, as candidate paths longest-first.
//
// Each component is a record — [4-byte LE length][4-byte LE type 0x0101][UTF-8] —
// but a bookmark records the VOLUME's components after the file's own, and the
// table of contents that separates them is not worth reverse-engineering for a
// fallback. So hand back every prefix and let the caller use the filesystem as
// the oracle: the longest one that exists is the file.
function bookmarkCandidates(buf) {
	if (!Buffer.isBuffer(buf) || buf.subarray(0, 4).toString('latin1') !== 'book') return [];
	const parts = [];
	for (let pos = 0; pos + 8 <= buf.length; pos += 4) {
		const len = buf.readUInt32LE(pos);
		const type = buf.readUInt32LE(pos + 4);
		if (type !== 0x0101 || len === 0 || len > 255 || pos + 8 + len > buf.length) continue;
		const text = buf.subarray(pos + 8, pos + 8 + len).toString('utf8');
		if (text.includes('\0') || text === '/') continue;
		parts.push(text);
	}
	const candidates = [];
	for (let n = parts.length; n > 0; n--) candidates.push('/' + parts.slice(0, n).join('/'));
	return candidates;
}

/* --- reading the .bib --------------------------------------------------------- */

// key → the entry's raw BibTeX text. Entries run from their @type{key, line to
// the next one, which keeps a blank line inside an entry from splitting it.
function indexEntries(source) {
	const entries = new Map();
	const starts = [...source.matchAll(/@[A-Za-z]+\s*\{\s*([^,\s{}]+)\s*,/g)];
	starts.forEach((match, i) => {
		const from = match.index;
		const to = i + 1 < starts.length ? starts[i + 1].index : source.length;
		entries.set(match[1].trim(), source.slice(from, to));
	});
	return entries;
}

// Parsed .bib files, keyed by absolute path and invalidated on mtime — one
// process may build several documents (library use, watch mode's worker).
const bibCache = new Map();

function loadBib(bibPath) {
	let stamp;
	try { stamp = fs.statSync(bibPath).mtimeMs; } catch { return { bibPath, entries: new Map(), missing: true }; }

	const cached = bibCache.get(bibPath);
	if (cached && cached.stamp === stamp) return cached;

	const loaded = {
		bibPath,
		stamp,
		entries: indexEntries(fs.readFileSync(bibPath, 'utf8'))
	};
	bibCache.set(bibPath, loaded);
	return loaded;
}

/* --- attachments -------------------------------------------------------------- */

// Resolve one BibDesk field value (base64 plist) to a path, preferring one that
// exists. Returns null only when the value doesn't decode at all.
function resolveBdskFile(value, bibDir) {
	const plist = parseBplist(Buffer.from(value.replace(/\s+/g, ''), 'base64'));
	if (!plist) return null;

	const candidates = [];
	if (typeof plist.relativePath === 'string' && plist.relativePath) {
		candidates.push(path.resolve(bibDir, plist.relativePath));
	}
	candidates.push(...bookmarkCandidates(plist.bookmark));
	if (candidates.length === 0) return null;

	const found = candidates.find(candidate => fs.existsSync(candidate));
	return { path: found || candidates[0], exists: Boolean(found) };
}

// The JabRef / Zotero `file` field: `Description:path:Type`, `;`-separated for
// several. Any part may be empty (`:/path/to.pdf:PDF`), and a lone value with no
// colons is the path itself.
function resolveFileField(value, bibDir) {
	const out = [];
	for (const item of value.split(';')) {
		const text = item.trim();
		if (!text) continue;
		const parts = text.split(/(?<!\\):/).map(p => p.replace(/\\:/g, ':'));
		// With three parts the middle is the path; otherwise take the longest
		// part that looks like one (a bare `{/path/to.pdf}` has just one).
		const filePath = parts.length >= 3
			? parts[1].trim()
			: parts.map(p => p.trim()).filter(Boolean).sort((a, b) => b.length - a.length)[0];
		if (!filePath) continue;
		const resolved = path.resolve(bibDir, filePath);
		out.push({ path: resolved, exists: fs.existsSync(resolved) });
	}
	return out;
}

/*
	Every attachment of one citation key, as a dense list in field order:

	    [{ path: '/abs/path.pdf', exists: true }, …]

	Returns [] when the entry has no attachments, and null when the lookup itself
	failed — no Bibliography configured, the file missing, or the key not in it —
	so the caller can tell "nothing attached" from "couldn't look".
*/
export function attachmentsFor(key) {
	// Every bibliography file, strongest first — the note's, then the
	// configured (bibliographies.js) — and the first that has the key is the
	// entry's, as it is for the citation itself. Its attachments resolve
	// against ITS folder.
	const files = bibliographyFiles().filter((file) => file.path).reverse();
	if (files.length === 0) return { error: 'no-bibliography', attachments: [] };
	const loaded = files.map((file) => loadBib(file.path));
	const bib = loaded.find((candidate) => !candidate.missing && candidate.entries.has(key));
	if (!bib) {
		const missing = loaded.find((candidate) => candidate.missing);
		return missing
			? { error: 'bibliography-missing', attachments: [], bibPath: missing.bibPath }
			: { error: 'unknown-key', attachments: [] };
	}

	const entry = bib.entries.get(key);
	const bibDir = path.dirname(bib.bibPath);
	const attachments = [];

	// Bdsk-File-N, in ascending N — sparse numbering collapses to a dense list.
	const bdsk = [...entry.matchAll(/bdsk-file-(\d+)\s*=\s*\{([^}]*)\}/gi)]
		.map(m => ({ n: Number(m[1]), value: m[2] }))
		.sort((a, b) => a.n - b.n);
	for (const { value } of bdsk) {
		const resolved = resolveBdskFile(value, bibDir);
		if (resolved) attachments.push(resolved);
	}

	// The `file` field, if the entry uses that convention instead.
	const fileField = /(?:^|[,\s])file\s*=\s*\{([^}]*)\}/i.exec(entry);
	if (fileField) attachments.push(...resolveFileField(fileField[1], bibDir));

	return { error: null, attachments };
}

// Exported for the fixtures/tests and for anything that needs the raw decode.
export { parseBplist, bookmarkCandidates, indexEntries };
