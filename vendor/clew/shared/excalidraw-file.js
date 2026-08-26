// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Reading and writing the files Obsidian's Excalidraw plugin creates.
//
// This module is the whole compatibility contract, and it has one rule: a file
// we save must still open in Obsidian, with everything we did not understand
// exactly where we found it. The plugin promises its users that anything they
// put between the frontmatter and the Excalidraw sections is preserved, and a
// vault shared between Clew and Obsidian only works if we keep that promise
// too. So we never rebuild these files — we splice the drawing back into the
// original text and leave every other byte alone.
//
// THREE SHAPES exist in the wild:
//
//   .excalidraw            plain JSON, the legacy format, still written when
//                          the plugin's "auto-export" option is on.
//   .excalidraw.md         Obsidian's own: frontmatter, optional user content,
//                          "## Text Elements", then "## Drawing" holding
//                          ```compressed-json (the default since 1.6) or
//                          ```json, closed by ``` and a %% comment marker.
//
// The compressed form is LZString.compressToBase64 with the base64 broken into
// 256-character lines separated by blank lines — the plugin does that so the
// file stays diffable and Obsidian's editor stays responsive. Rewriting it any
// other way would produce a file Obsidian still reads but every line of which
// shows as changed in git, so we reproduce the chunking exactly.
// lz-string is CommonJS and offers no named ESM exports, so it has to come in
// as a default and be destructured — Node's ESM loader rejects the named form.
import lzString from 'lz-string';

const { compressToBase64, decompressFromBase64 } = lzString;

const CHUNK = 256;

// Where the scene sits in the file, built from the FORMAT rather than copied
// from anyone's implementation. Obsidian's Excalidraw plugin ships a LICENSE
// file that is AGPL-3.0 while its package.json claims MIT; the file governs, so
// none of its code belongs in a GPL-3.0 project and none of it is here. What
// follows is a description of the on-disk layout, which is what compatibility
// actually requires:
//
//   a "# Drawing" or "## Drawing" heading on its own line,
//   optionally followed by text carrying no backtick,
//   then a fence tagged `compressed-json` or `json`,
//   the payload, and the closing fence.
//
// Three groups, because serializeExcalidraw rewrites only the middle one and
// puts the opening and closing fences back exactly as it found them.
const drawingSection = (tag) => new RegExp(
	'(\\n#{1,2} Drawing\\n'   // the heading, on a line of its own
	+ '[^`]*'                  // any preamble, so long as it is not a fence
	+ '```' + tag + '\\n)'      // the opening fence
	+ '([\\s\\S]*?)'            // the payload — lazy: the FIRST close wins
	+ '(```\\n)',               // the closing fence
	'm');

const COMPRESSED_RE = drawingSection('compressed-json');
const JSON_RE = drawingSection('json');

/** Does this path hold an Excalidraw drawing? */
export function isExcalidrawPath(path = '') {
	const lower = String(path).toLowerCase();
	return lower.endsWith('.excalidraw') || lower.endsWith('.excalidraw.md');
}

/** A .excalidraw.md is ALSO a .md — this says which wins. */
export function isExcalidrawMarkdown(path = '') {
	return String(path).toLowerCase().endsWith('.excalidraw.md');
}

/** LZString base64, wrapped the way the plugin wraps it. */
export function compressScene(json) {
	const compressed = compressToBase64(json);
	let out = '';
	for (let i = 0; i < compressed.length; i += CHUNK) {
		out += `${compressed.slice(i, i + CHUNK)}\n\n`;
	}
	return out.trim();
}

/** Undo compressScene: newlines are formatting, not data. */
export function decompressScene(data) {
	let clean = '';
	for (const ch of data) {
		if (ch !== '\n' && ch !== '\r') clean += ch;
	}
	return decompressFromBase64(clean);
}

/**
 * Read a drawing. Returns `{ scene, format, source }` — `scene` is the parsed
 * Excalidraw document, `format` is how it was stored ('json' | 'md-compressed'
 * | 'md-json'), and `source` is the untouched original that serialize() splices
 * into. Returns null when the text holds no drawing at all, which is how a
 * plain note that merely happens to be named .excalidraw.md stays a note.
 */
export function parseExcalidraw(text, path = '') {
	if (!isExcalidrawMarkdown(path) && String(path).toLowerCase().endsWith('.excalidraw')) {
		try {
			return { scene: JSON.parse(text), format: 'json', source: text };
		} catch { return null; }
	}
	// A leading \n so a "## Drawing" on the very first line still matches the
	// plugin's expressions, which all expect a newline before the heading.
	const padded = text.startsWith('\n') ? text : `\n${text}`;
	const compressed = COMPRESSED_RE.exec(padded);
	if (compressed) {
		try {
			return { scene: JSON.parse(decompressScene(compressed[2])), format: 'md-compressed', source: text };
		} catch { return null; }
	}
	const plain = JSON_RE.exec(padded);
	if (plain) {
		try {
			return { scene: JSON.parse(plain[2]), format: 'md-json', source: text };
		} catch { return null; }
	}
	return null;
}

/**
 * Write a scene back into the file it came from, changing nothing else.
 *
 * `parsed` is what parseExcalidraw returned; passing it back is what keeps the
 * frontmatter, the user's own prose, the Text Elements section and any section
 * we have never heard of. Only the bytes between the drawing fence and its
 * closing ``` are replaced, and in the same encoding we found them in — a file
 * Obsidian stored compressed stays compressed.
 */
export function serializeExcalidraw(parsed, scene) {
	const json = JSON.stringify(scene, null, 2);
	if (parsed.format === 'json') return json;

	const padded = parsed.source.startsWith('\n') ? parsed.source : `\n${parsed.source}`;
	const re = parsed.format === 'md-compressed' ? COMPRESSED_RE : JSON_RE;
	const body = parsed.format === 'md-compressed' ? compressScene(json) : json;
	const replaced = padded.replace(re, (_all, open, _old, close) => `${open}${body}\n${close}`);
	return parsed.source.startsWith('\n') ? replaced : replaced.slice(1);
}

/** An empty scene, for "new drawing". Matches what the plugin writes. */
export function emptyScene() {
	return {
		type: 'excalidraw',
		version: 2,
		source: 'https://clew-app.com',
		elements: [],
		appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
		files: {},
	};
}

/**
 * A fresh .excalidraw.md, in the shape Obsidian expects to find. The
 * frontmatter key is what makes its plugin claim the file, so a drawing
 * created in Clew opens as a drawing there rather than as a wall of base64.
 */
export function newMarkdownFile(scene = emptyScene()) {
	return '---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n'
		+ '==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==\n\n\n'
		+ '# Excalidraw Data\n\n## Text Elements\n\n'
		+ `## Drawing\n\`\`\`compressed-json\n${compressScene(JSON.stringify(scene, null, 2))}\n\`\`\`\n%%`;
}

/**
 * The "## Embedded Files" section of the markdown wrapper.
 *
 * Obsidian's plugin does not store a pasted image inside the scene: the image
 * becomes an ordinary vault attachment, the scene's element keeps only its
 * `fileId`, and this section maps the id to a wikilink —
 *
 *   ## Embedded Files
 *   1f8f5a7ac9a2…: [[Pasted image 20240101120000.png]]
 *
 * — so the drawing file stays small and the image stays a real file. Reading
 * such a drawing therefore means resolving these links and rehydrating the
 * scene's `files` map at load; anything we inject that way must be stripped
 * again at save, or every save would copy the image INTO the markdown.
 *
 * Returns [{ id, target }] for wikilink entries (size suffix and anchor
 * dropped) and [{ id, url }] for hyperlink ones, in file order. Tolerates
 * both heading depths and stops at the next section.
 */
export function embeddedFileLinks(source) {
	const section = /\n#{1,2} Embedded Files[ \t]*\n([\s\S]*?)(?=\n#{1,2} |\n%%|$)/
		.exec(source.startsWith('\n') ? source : `\n${source}`);
	if (!section) return [];
	const entries = [];
	for (const line of section[1].split('\n')) {
		const m = /^([A-Za-z0-9_-]+):\s*(.+)$/.exec(line.trim());
		if (!m) continue;
		const [, id, rest] = m;
		const link = /^\[\[([^\]]+)\]\]/.exec(rest);
		if (link) {
			entries.push({ id, target: link[1].split('|')[0].split('#')[0].trim() });
		} else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rest)) {
			entries.push({ id, url: rest.trim() });
		}
	}
	return entries;
}

/**
 * The words inside a drawing, one text element per line.
 *
 * This is what makes a drawing searchable and linkable in Clew. Obsidian gets
 * the same thing by mirroring text elements into a "## Text Elements" section
 * of the markdown wrapper — a workaround for the fact that its indexer only
 * reads markdown. Ours reads whatever we tell it to, so we go to the source
 * and the wrapper stops mattering: a plain .excalidraw indexes exactly as well
 * as a .excalidraw.md.
 *
 * Wikilinks and #tags written inside a drawing therefore reach the graph,
 * backlinks and search like any other text.
 */
export function drawingText(scene) {
	const elements = Array.isArray(scene?.elements) ? scene.elements : [];
	return elements
		.filter((el) => el && el.type === 'text' && !el.isDeleted && typeof el.text === 'string')
		.map((el) => el.text)
		.join('\n');
}
