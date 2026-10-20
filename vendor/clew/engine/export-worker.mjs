// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// An EXPORT's engine run, with the engine's Obsidian links on (jmarkdown
// obsidian-links.js — the owner, 2026-10-05: "teach it, Clew switches it
// on"). The engine's own one-shot worker (watch-worker.js) takes its options
// over IPC, which carries no functions, and the resolvers are functions; so
// this worker hands the engine its resolvers itself, and otherwise does
// exactly what that worker does: import the engine, say ready, run ONE
// build, report its output and warnings — and a book's map and LaTeX files
// when the build made them (processFile's result) — exit.
//
//   resolveEmbed(name, { file }) — an image embed resolved as the preview
//     resolves one (vault-files.js#resolveFileTarget, wikilinks.js's own: by
//     name across the vault, the shortest path first, clamped by realpath in
//     a vault this device does not trust: CLEW_VAULT_ROOT,
//     CLEW_VAULT_RESTRICTED), pointed from the file the export WRITES by
//     export-config.js#exportEmbedPath — every host's arithmetic: relative to
//     the output's folder, by realpath for LaTeX, a book's from its chapter.
//     Nothing found: the name stays as written, relative to the note.
//   resolveLink() — nothing: an export has no page to point a note's link at,
//     so a [[link]] prints as its text (the alias, or "Note > Heading").
//
// And the engine's figureFonts (jmarkdown 97caa3e): a font family a TikZ or
// MetaPost figure NAMES is given this machine's files for it as the preview
// gives them (font-families.js, over the index main built: CLEW_FONT_INDEX) —
// whole families, none past the cap or for a family the machine lacks, which
// the engine takes as final. Fonts only, never a tool: a restricted vault's
// exports have it too. No index to read: no option, the engine's search of
// the font folders by file name, as before.
//
// argv[2] is the engine's watch-worker.js; its folder holds index.js.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveFileTarget } from './vault-files.js';
import { familyFiles, readFontIndex } from './font-families.js';
import { configureExportBuild, exportEmbedPath } from './export-config.js';

const engineDir = path.dirname(process.argv[2]);
const load = (name) => import(pathToFileURL(path.join(engineDir, name)).href);
const { processFile } = await load('index.js');
const { getWarnings } = await load('warnings.js');
const { configManager, DEFAULT_CONFIG } = await load('config-manager.js');

let building = null;   // the build's message: its file and options
const fontIndex = process.env.CLEW_FONT_INDEX ? readFontIndex(process.env.CLEW_FONT_INDEX) : null;
const figureFonts = fontIndex ? { figureFonts: (family) => familyFiles(fontIndex, family) } : {};

// An image embed resolved as the preview resolves one, then pointed from the
// file this export writes (export-config.js#exportEmbedPath).
const resolveEmbed = (name, { file } = {}) => {
	const rel = resolveFileTarget(String(name));
	if (!rel) return null;
	const { output, to, chapters } = building.options ?? {};
	return exportEmbedPath({ abs: path.join(process.env.CLEW_VAULT_ROOT, rel), output, to, chapters, file, realpath: fs.realpathSync });
};

if (process.send) process.send({ type: 'ready' });

process.once('message', async (msg) => {
	if (!msg || msg.type !== 'build') return;
	building = msg;
	try {
		const options = { ...msg.options, obsidianLinks: { resolveEmbed, resolveLink: () => null }, ...figureFonts };
		// Clew's configuration for this build (export-config.js: the fenced
		// header, the vault's citations in HTML, LaTeX's own title, Clew's
		// LaTeX style), on the engine's own configManager, after the user's
		// config files and before the build.
		configureExportBuild(configManager, { to: options.to, latexStyle: msg.latexStyle, biblify: msg.biblify, defaults: DEFAULT_CONFIG });
		const { outFile, bookMap = null, latexFiles = null } = await processFile(msg.file, options);
		if (process.send) process.send({ type: 'done', output: outFile, warnings: getWarnings(), bookMap, latexFiles });
	} catch (err) {
		if (process.send) process.send({ type: 'error', message: String((err && err.message) || err) });
	} finally {
		process.exit(0);
	}
});
