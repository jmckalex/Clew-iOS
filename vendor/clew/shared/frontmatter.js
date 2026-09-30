// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Frontmatter properties: parse a leading ---fenced YAML block into typed
// key/value entries and serialize them back. Regex-level only (like
// note-metadata.js — NEVER the engine). Round-trip safety is the contract:
// a block containing anything this subset can't represent (nested maps,
// multi-line strings, comments, anchors) sets `clean: false`, and callers
// must then treat the block as read-only rather than risk destroying data.
//
// Supported values: strings (optionally quoted), numbers, booleans, null
// (empty), and flat lists — inline `[a, b]` or block `- item` lines.

const FM_RE = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;
const KV_RE = /^([A-Za-z0-9_][\w ./-]*?)\s*:\s?(.*)$/;
const LIST_ITEM_RE = /^\s*-\s+(.*)$/;

// A double-quoted YAML string's escapes, in one pass — `\n` is a newline
// (a Meta Bind textArea's value, 2026-09-30), `\\` a backslash.
const DQ_ESCAPES = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

function parseScalar(raw) {
	const text = raw.trim();
	if (/^".*"$/.test(text)) {
		return text.slice(1, -1).replace(/\\([nrt"\\])/g, (_, c) => DQ_ESCAPES[c]);
	}
	if (/^'.*'$/.test(text)) {
		return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
	}
	if (text === 'true') return true;
	if (text === 'false') return false;
	if (text !== '' && /^-?\d+(\.\d+)?$/.test(text)) return Number(text);
	return text;
}

/**
 * Parse the note's frontmatter block into properties.
 * Returns { present, end, entries: [{key, value}], clean }.
 * `end` is the offset of the first body character; `clean: false` means the
 * block holds constructs outside the subset and MUST NOT be rewritten.
 */
export function parseProperties(text) {
	const match = FM_RE.exec(text);
	if (!match) return { present: false, end: 0, entries: [], clean: true };
	const lines = match[1].split('\n');
	const entries = [];
	let clean = true;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;
		const kv = KV_RE.exec(line);
		if (!kv) { clean = false; continue; }
		const key = kv[1].trim();
		const rest = kv[2].trim();
		if (rest.startsWith('#')) { clean = false; continue; } // comment-valued line
		if (rest === '') {
			// Either a null value or the head of a block list.
			const items = [];
			let j = i + 1;
			while (j < lines.length && LIST_ITEM_RE.test(lines[j])) {
				items.push(parseScalar(LIST_ITEM_RE.exec(lines[j])[1]));
				j++;
			}
			if (j > i + 1) {
				entries.push({ key, value: items });
				i = j - 1;
			} else {
				entries.push({ key, value: null });
			}
		} else if (rest.startsWith('[') && rest.endsWith(']')) {
			const inner = rest.slice(1, -1).trim();
			entries.push({ key, value: inner === '' ? [] : inner.split(',').map(parseScalar) });
		} else if (rest.startsWith('{') || rest.startsWith('&') || rest.startsWith('*') || rest === '|' || rest === '>') {
			clean = false; // flow maps, anchors, block scalars: out of subset
		} else {
			entries.push({ key, value: parseScalar(rest) });
		}
	}
	return { present: true, end: match[0].length, entries, clean };
}

function scalarToYaml(value) {
	if (typeof value === 'boolean' || typeof value === 'number') return String(value);
	const text = String(value);
	// Quote anything YAML could misread: leading/trailing space, specials,
	// or a string that would parse back as a different type.
	const needsQuoting = text === ''
		|| /^\s|\s$/.test(text)
		|| /[:#\[\]{}"'`|>&*!%@,]/.test(text)
		|| text === 'true' || text === 'false'
		|| /^-?\d+(\.\d+)?$/.test(text)
		|| text.startsWith('- ')
		// A newline written bare would end the value mid-string and leave a
		// line the parser cannot read, which marks the whole block unclean —
		// read-only to every later edit (a textArea widget did exactly that).
		|| /[\n\r\t]/.test(text);
	if (!needsQuoting) return text;
	return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
		.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

/** Serialize entries back to a frontmatter block (with trailing newline),
 *  or '' when there are no entries (block removed). */
export function serializeProperties(entries) {
	if (entries.length === 0) return '';
	const lines = ['---'];
	for (const { key, value } of entries) {
		if (Array.isArray(value)) {
			if (value.length === 0) {
				lines.push(`${key}: []`);
			} else {
				lines.push(`${key}:`);
				for (const item of value) lines.push(`  - ${scalarToYaml(item)}`);
			}
		} else if (value === null || value === undefined) {
			lines.push(`${key}:`);
		} else {
			lines.push(`${key}: ${scalarToYaml(value)}`);
		}
	}
	lines.push('---', '');
	return lines.join('\n');
}

/** Replace (or insert/remove) the note's frontmatter with `entries`. */
export function applyProperties(text, entries) {
	const { end } = parseProperties(text);
	return serializeProperties(entries) + text.slice(end);
}

/** UI type inference for a property value. */
export function propertyType(value) {
	if (Array.isArray(value)) return 'list';
	if (typeof value === 'boolean') return 'checkbox';
	if (typeof value === 'number') return 'number';
	return 'text';
}
