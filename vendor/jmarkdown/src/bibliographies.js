/*
	Which .bib files a document draws on, in order, and what they hold merged.

	A document's bibliography is the CONFIGURED one plus its own:

	  1. `Biblify.bibliography` from the config files — ~/.jmarkdown/config.json,
	     then the project's ./.jmarkdown/config.json, which overrides it (a host
	     writes there: Clew puts the vault's bibliography in the config it
	     generates for its previews);
	  2. the files a HOST names for one build — `--bibliography <file>`
	     (repeatable), or processFile's `bibliography` option — configured ones
	     in every respect, after the config files'. Clew's exports run the
	     user's own config, not its generated one, and pass the vault's
	     bibliography this way. An option rather than an environment variable:
	     it belongs to one build and shows in the call, where a variable left
	     in a shell would add a bibliography to every build unseen;
	  3. then the header's `Bibliography:`.

	Each is a LIST: an array in a config file, or a string of files separated by
	commas or new lines — so `Bibliography: refs.bib, extra.bib`, a YAML list
	(`[refs.bib, extra.bib]`, or one `- file` per line) and continuation lines
	all work. A file later in the order wins a key over an earlier one, so the
	note's entry beats the configured one; where the two entries differ the
	build says so (identical copies, as a minimal .bib cut from the master is,
	say nothing). `Bibliography mode: replace` in the header uses the note's
	files alone — what every header did before 2026-10-03, when its
	`Bibliography` replaced the configured one outright.

	A relative path resolves against where it was written: a note's against
	the note's folder, as it always has; a configured one against the working
	directory, where the project config is read from (it used to resolve
	against each note's folder, so a project's `./refs.bib` was a different
	file for every note in a subfolder — which mattered little while a note's
	own `Bibliography` switched it off, and for every such note once it adds).

	Consumers: biblify-compile.js (compile-time HTML reads every file),
	citations.js (@bibliography in LaTeX), bib-attachments.js (\citefile looks a
	key up note-first) and html-template.js (the runtime Biblify client).

	Two consumers take ONE file, and get a merged one written beside the output
	(writeMergedBibliography): the runtime Biblify client, and bibtex when a key
	is in more than one file — bibtex counts a repeated entry as an error, and
	latexmk then stops, leaving every citation "?". With the keys apart, LaTeX
	lists the files themselves: \bibliography{note,…,configured}.
*/

import fs from 'fs';
import path from 'path';
import { configManager } from './config-manager.js';
import { addWarning, getWarnings } from './warnings.js';

const isUrl = (name) => /^[a-z][a-z0-9+.-]*:\/\//i.test(name);

function warnOnce(message) {
	if (!getWarnings().includes(message)) addWarning(message);
}

/* --- which files --------------------------------------------------------------- */

/**
 * A bibliography value as a list of file names: an array, or a string of names
 * separated by commas or new lines, with YAML's list dressing (`[…]`, `- `,
 * quotes) taken off.
 */
export function parseBibliographyList(value) {
	if (value == null) return [];
	const parts = Array.isArray(value) ? value.flatMap((v) => String(v).split(/[,\n]/)) : String(value).split(/[,\n]/);
	return parts
		.map((part) => part.trim().replace(/^\[|\]$/g, '').trim().replace(/^-\s+/, '').trim().replace(/^(["'])(.*)\1$/, '$2').trim())
		.filter(Boolean);
}

/**
 * The files, in order — lowest precedence first, so a later file wins a key.
 * Each is `{ name, path, origin }`: `name` as written, `path` absolute (null
 * for a URL), `origin` 'config' or 'note'. A file named twice keeps its later
 * place.
 */
export function bibliographyFiles() {
	const configured = [
		...parseBibliographyList(configManager.get('Biblify.bibliography')),
		...parseBibliographyList(configManager.get('Biblify.host bibliography')),
	];
	const note = parseBibliographyList(configManager.get('Biblify.note bibliography'));
	const mode = String(configManager.get('Biblify.bibliography mode') || 'add').trim().toLowerCase();
	if (mode !== 'add' && mode !== 'replace') {
		warnOnce(`bibliography: \`Bibliography mode: ${mode}\` is neither add nor replace — the note's files are added`);
	}
	if (mode === 'replace' && note.length === 0) {
		warnOnce('bibliography: `Bibliography mode: replace` but the note names no `Bibliography` — the configured one is used');
	}
	const named = mode === 'replace' && note.length
		? note.map((name) => ({ name, origin: 'note' }))
		: [...configured.map((name) => ({ name, origin: 'config' })), ...note.map((name) => ({ name, origin: 'note' }))];

	const noteDir = configManager.get('Markdown file directory') || process.cwd();
	const files = named.map(({ name, origin }) => ({
		name,
		origin,
		path: isUrl(name) ? null : path.resolve(origin === 'note' ? noteDir : process.cwd(), name),
	}));
	// A file named twice keeps its later (stronger) place.
	return files.filter((file, i) => !files.slice(i + 1).some((later) => (later.path ?? later.name) === (file.path ?? file.name)));
}

/* --- reading -------------------------------------------------------------------- */

// Read files, keyed by path and invalidated on mtime: one process may build
// several documents (library use, watch mode's worker).
const readCache = new Map();

/**
 * The files with their text: `{ …file, content }`, `content` null (and a
 * warning) for one that cannot be read. A URL is left to the runtime client.
 */
export function readBibliographies(files = bibliographyFiles()) {
	return files.map((file) => {
		if (!file.path) return { ...file, content: null, url: true };
		let stamp;
		try { stamp = fs.statSync(file.path).mtimeMs; } catch {
			warnOnce(`bibliography: cannot read "${file.name}" — no such file, so it is left out`);
			return { ...file, content: null };
		}
		const cached = readCache.get(file.path);
		if (cached && cached.stamp === stamp) return { ...file, content: cached.content };
		try {
			const content = fs.readFileSync(file.path, 'utf8');
			readCache.set(file.path, { stamp, content });
			return { ...file, content };
		} catch (e) {
			warnOnce(`bibliography: cannot read "${file.name}" (${e.message}), so it is left out`);
			return { ...file, content: null };
		}
	});
}

/**
 * Every entry of a .bib as `{ key, start, end }` offsets into it: from the `@`
 * to the brace (or parenthesis) that closes the entry, braces counted.
 * `@string`, `@preamble` and `@comment` are not entries and are left out.
 */
export function bibEntries(source) {
	const out = [];
	const opener = /@([A-Za-z]+)\s*([{(])/g;
	let match;
	while ((match = opener.exec(source))) {
		const type = match[1].toLowerCase();
		const paren = match[2] === '(';
		let depth = paren ? 0 : 1;
		let end = -1;
		for (let i = opener.lastIndex; i < source.length; i++) {
			const c = source[i];
			if (c === '{') depth++;
			else if (c === '}') { depth--; if (!paren && depth === 0) { end = i + 1; break; } }
			else if (c === ')' && paren && depth === 0) { end = i + 1; break; }
		}
		if (end < 0) break;
		if (!['string', 'preamble', 'comment'].includes(type)) {
			const key = source.slice(opener.lastIndex, end).split(',')[0].trim();
			if (key) out.push({ key, start: match.index, end });
		}
		opener.lastIndex = end;
	}
	return out;
}

/* --- merging -------------------------------------------------------------------- */

// A file as a warning names it: as written, or by its own name when written as
// an absolute path (a host's config, say), which would fill a banner.
const shown = (file) => (path.isAbsolute(file.name) ? path.basename(file.name) : file.name);
const where = (file) => `${shown(file)} (${file.origin === 'note' ? "this note's" : 'configured'})`;
const sameEntry = (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/**
 * Report the keys a stronger file takes from a weaker one, where the two
 * entries DIFFER — one warning for each pair of files. `indexed` is
 * `[{ file, entries }]` in order (weakest first), `entries` a Map or object
 * of key → entry text, as each consumer indexes it.
 */
export function warnShadowedEntries(indexed) {
	const get = (entries, key) => (entries instanceof Map ? entries.get(key) : entries[key]);
	const keys = (entries) => (entries instanceof Map ? [...entries.keys()] : Object.keys(entries));
	const pairs = new Map();
	indexed.forEach(({ file, entries }, i) => {
		for (const key of keys(entries)) {
			// The strongest file holding the key wins it.
			const winner = indexed.slice(i + 1).reverse().find((later) => get(later.entries, key) !== undefined);
			if (!winner) continue;
			// Only the file it directly beats, so a key in three files is one report.
			const next = indexed.slice(i + 1).find((later) => get(later.entries, key) !== undefined);
			if (next !== winner) continue;
			if (sameEntry(String(get(entries, key)), String(get(winner.entries, key)))) continue;
			if (!pairs.has(winner)) pairs.set(winner, new Map());
			const losers = pairs.get(winner);
			if (!losers.has(file)) losers.set(file, []);
			losers.get(file).push(key);
		}
	});
	for (const [winner, losers] of pairs) {
		for (const [loser, list] of losers) {
			const keys = list.slice(0, 6).join(', ') + (list.length > 6 ? `, and ${list.length - 6} more` : '');
			const count = list.length === 1 ? 'an entry' : `${list.length} entries`;
			warnOnce(`bibliography: ${where(winner.file)} and ${where(loser)} disagree on ${count}; ${shown(winner.file)}'s used: ${keys}`);
		}
	}
}

/** Keys in more than one readable file, compared as bibtex does (case aside). */
export function repeatedKeys(read = readBibliographies()) {
	const seen = new Map();
	const repeated = new Set();
	for (const file of read) {
		if (file.content == null) continue;
		const inFile = new Set(bibEntries(file.content).map(({ key }) => key.toLowerCase()));
		for (const key of inFile) {
			if (seen.has(key)) repeated.add(key);
			else seen.set(key, file);
		}
	}
	return repeated;
}

/* --- one merged file -------------------------------------------------------------- */

const MARKER = '% Generated by jmarkdown';

/**
 * The readable files as ONE .bib: strongest first, and from each weaker file
 * every entry a stronger one already has taken out — so each key appears once,
 * the winner's, and `@string`s, `@preamble`s and comments all survive.
 */
export function mergedBibliographyText(read = readBibliographies()) {
	const usable = read.filter((file) => file.content != null);
	const taken = new Set();
	const parts = [];
	for (const file of [...usable].reverse()) {
		let text = '';
		let at = 0;
		for (const { key, start, end } of bibEntries(file.content)) {
			const k = key.toLowerCase();
			if (taken.has(k)) {
				text += file.content.slice(at, start);
				at = end;
			} else {
				taken.add(k);
			}
		}
		text += file.content.slice(at);
		// The marker stands apart: Biblify's parser splits a .bib at blank lines
		// and would otherwise hand it to citation-js with the first entry.
		parts.push(`% ---- ${file.name} ----\n\n${text.trim()}\n`);
	}
	return `${MARKER} from ${usable.map((file) => file.name).join(', ')}:\n`
		+ '% every key once, from the last of those files that has it. Rewritten on\n'
		+ '% every build; do not edit.\n\n'
		+ parts.join('\n');
}

/**
 * Write the merged .bib beside the output, as `<output>-bibliography.bib`, and
 * return `{ file, name, path }` (`name` without `.bib`, for \bibliography) — or
 * null, with a warning saying why, when there is no output file (stdout) or a
 * file of that name that jmarkdown did not write is in the way.
 */
export function writeMergedBibliography(read = readBibliographies(), purpose = '') {
	const outFile = configManager.get('Output file');
	if (!outFile) {
		warnOnce(`bibliography: several bibliography files and no output file to write their merge beside${purpose ? ` — ${purpose}` : ''}`);
		return null;
	}
	const target = outFile.replace(/\.[^./\\]+$/, '') + '-bibliography.bib';
	const text = mergedBibliographyText(read);
	let existing = null;
	try { existing = fs.readFileSync(target, 'utf8'); } catch { /* none yet */ }
	if (existing != null && !existing.startsWith(MARKER)) {
		warnOnce(`bibliography: will not overwrite ${path.basename(target)}, which jmarkdown did not write${purpose ? ` — ${purpose}` : ''}`);
		return null;
	}
	if (existing !== text) fs.writeFileSync(target, text);
	const file = path.basename(target);
	return { file, name: file.replace(/\.bib$/, ''), path: target };
}

/**
 * The one file the runtime Biblify client is given (it reads one): the file
 * itself when there is one, else the merge, written beside the page — or, if
 * that cannot be written, the strongest file alone.
 */
export function runtimeBibliography() {
	const files = bibliographyFiles();
	if (files.length <= 1) return files[0]?.name ?? '';
	const read = readBibliographies(files);
	const urls = read.filter((file) => file.url);
	if (urls.length) {
		warnOnce(`bibliography: ${urls.map((file) => `"${file.name}"`).join(', ')} cannot be merged with the other files (a URL) and is left out`);
	}
	const indexed = read.filter((file) => file.content != null)
		.map((file) => ({ file, entries: new Map(bibEntries(file.content).map(({ key, start, end }) => [key, file.content.slice(start, end)])) }));
	warnShadowedEntries(indexed);
	const merged = writeMergedBibliography(read, 'the runtime Biblify client reads one file, so it gets the strongest alone');
	return merged ? merged.file : files[files.length - 1].name;
}
