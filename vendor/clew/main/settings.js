// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// App-level settings persisted in Electron's userData directory:
// recent vaults, last vault, theme. Vault-level state lives in <vault>/.clew/.
import { app } from 'electron';
import path from 'node:path';
import { SettingsStore } from './settings-store.js';

const DEFAULTS = {
	recentVaults: [],
	openVaults: [], // one window each, restored at launch
	newTabMode: 'source', // 'source' | 'live' | 'reading'
	// Live edit (docs/dev/live-edit.md §8). defaultEditMode: where ⌘E
	// returns from reading for a tab that has no editing mode of its own.
	defaultEditMode: 'source',
	liveReveal: 'construct', // 'construct' | 'line'
	liveRenderMath: true,
	liveRenderFences: true,
	liveRenderEmbeds: true,
	liveFrameCap: 16,
	// The editor toolbar (docs/dev/live-edit.md §6.8): shown in live edit only,
	// always, or never; `editorToolbarPrev` remembers which of the first two
	// view:toggle-toolbar returns to. Groups: ordered ids, null = default.
	editorToolbar: 'live',
	editorToolbarPrev: 'live',
	editorToolbarGroups: null,
	selectionBubble: true,
	// The `//` menu (editor/complete/slash-commands.js).
	slashCommands: true,
	// Link hover previews (editor/link-hover.js): 'hover' | 'mod' | 'off'.
	linkPreview: 'hover',
	// The live preview pane (editor/preview-pane.js): 'on' | 'off'.
	previewPane: 'on',
	// The graph's References toggle (clew-graph-view.js, §5.14).
	graphReferences: false,
	// Footnotes in the margin (§5.16): 'auto' (a wide pane with room) | 'on' | 'off'.
	sidenotes: 'auto',
	explorerOpenMode: 'new-tab', // how newly created note tabs open ('source'|'reading')
	diaryMode: 'files', // 'files' = one note per day, 'log' = single log note
	diaryLogFile: 'Diary.md',
	lastVault: null,
	theme: 'dark',
	// Optional 139 MB CJK font download for the PDF viewer, off by
	// default and fetched on demand — see src/main/pdf-fonts.js.
	pdfCjkFonts: false,
	// Paper for "Export as PDF (reading view)" — the LaTeX PDF takes its
	// page size from the document's own class, and is not affected.
	printPaperSize: 'a4',
	// The engine for "Export as PDF (via LaTeX)": 'auto' reads it off the
	// generated document (main/latex-engine.js — fontspec and friends take
	// LuaLaTeX), or 'pdflatex' | 'lualatex' | 'xelatex' for what it cannot see.
	latexEngine: 'auto',
	// What draws TikZ and MetaPost in a TRUSTED vault's note and book exports
	// (export-cache.js#figureEngineOptions): 'auto' — mp-tikz-wasm, the
	// preview's own build, with the installed TeX tools for a figure it cannot
	// draw (a font it cannot find, a file its bundles lack) — or 'external',
	// the installed tools alone. A restricted vault's always use mp-tikz-wasm
	// alone, whatever this says. Read only when the user CHOSE it
	// (export-cache.js#unpinFigureEngine): dev.9–11 wrote the then-default
	// 'external' into every settings file at the first vault opened.
	exportFigureEngine: 'auto',
	// The daily update check (main/updater.js): 'on' | 'off'; and a version
	// the user chose to skip, which is not told again.
	updateCheck: 'on',
	skippedUpdate: null,
	// Named TeX fragments a figure can ask for with `clew-fragments=`
	// ([{ name, text }] — src/engine/tex-fragments.js). These are the
	// GLOBAL ones; a vault's own live in its vault-settings.json and
	// shadow these where the names meet.
	texFragments: [],
	// Custom callout types ([{ name, title?, icon?, color?, aliases? }] —
	// the engine's callout-definitions.js validates them, main/callout-types.js
	// resolves them). These are the GLOBAL ones, this Mac's alone; a vault's
	// own live in its vault-settings.json, travel with it, and win where
	// the names meet.
	callouts: [],
	// The shell panel's font (a family, or a CSS list), placed BEFORE Clew's
	// monospace face and the Nerd/Powerline faces it falls back to for
	// prompt symbols (clew-shell-panel.js#gridFontFamily). Empty: those alone.
	shellFont: '',
};

// The file at userData; settings-store.js reads and writes it.
export const settings = new SettingsStore(DEFAULTS, () => path.join(app.getPath('userData'), 'clew-settings.json'));
