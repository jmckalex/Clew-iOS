// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// <clew-settings-view>: a settings tab — appearance, daily notes/templates,
// and the hotkey editor (records chords straight into settings overrides).
import { ClewElement } from '../base/clew-element.js';
import { settingsStore } from '../../state/settings-store.js';
import { vaultStore } from '../../state/vault-store.js';
import { vaultSettingsStore } from '../../state/vault-settings-store.js';
import { allCommands, chordOf } from '../../commands/registry.js';
import { debounce } from '../../lib/debounce.js';
import { invalidateNoteApiGate } from '../../note-api.js';
import { ipc, CH } from '../../ipc.js';
import { createCodeEditor } from '../../editor/mini-editor.js';
import { fragmentKey } from '../../../engine/tex-fragments.js';
import { TOOLBAR_GROUPS } from '../../editor/toolbar/toolbar-spec.js';

const isMac = navigator.platform.startsWith('Mac');

export function prettyChord(chord) {
	return chord
		.replace('Ctrl', isMac ? '⌃' : 'Ctrl') // before Mod→Ctrl on non-mac
		.replace('Mod', isMac ? '⌘' : 'Ctrl')
		.replace('Alt', isMac ? '⌥' : 'Alt')
		.replace('Shift', '⇧')
		.replace('ArrowLeft', '←')
		.replace('ArrowRight', '→')
		.replace('ArrowUp', '↑')
		.replace('ArrowDown', '↓')
		.replaceAll('-', isMac ? '' : '+');
}

class ClewSettingsView extends ClewElement {
	#recordingId = null;
	#filter = '';
	/** Every mini editor on screen — this component destroys what it made. */
	#fragmentEditors = [];
	/** scope → { entries, refresh }, so each group can see the other's names. */
	#fragmentScopes = new Map();

	subscribe() {
		this.listen(settingsStore, 'settings-changed', () => {
			// Re-render only when not mid-edit in a text field.
			if (!this.contains(document.activeElement) || this.#recordingId) return;
		});
	}

	render() {
		// A re-render replaces the DOM wholesale; the mini editors in it are
		// this component's to free (mini-editor.js is not the pool).
		this.#dropFragmentEditors();
		this.classList.add('settings-view');
		this.innerHTML = '<div class="settings-scroll"></div>';
		const scroll = this.firstElementChild;
		scroll.append(
			this.#section('Appearance', [
				this.#selectRow('Theme', 'theme', [['dark', 'Dark'], ['light', 'Light']]),
				this.#selectRow('New note tabs open in', 'newTabMode',
					[['source', 'Source mode'], ['live', 'Live edit'], ['reading', 'Reading mode']]),
				this.#selectRow('Explorer click opens files', 'explorerOpenMode',
					[['new-tab', 'In a new tab'], ['replace', 'In the current tab (Obsidian-style)']]),
				this.#numberRow('Editor font size (px)', 'editorFontSize', 16, 10, 28),
				this.#numberRow('Editor line width (em)', 'editorLineWidth', 44, 20, 120),
				this.#numberRow('Fill column (hard-wrap)', 'fillColumn', 72, 40, 120),
				this.#checkRow('Auto-fill while typing', 'autoFill'),
				this.#selectRow('Link previews on hover', 'linkPreview',
					[['hover', 'Always'], ['mod', navigator.platform.startsWith('Mac') ? 'With ⌘ held' : 'With Ctrl held'], ['off', 'Off']]),
				this.#selectRow('Live preview of maths and diagrams while editing', 'previewPane',
					[['on', 'On'], ['off', 'Off']]),
				this.#selectRow('Footnotes in the margin (sidenotes)', 'sidenotes',
					[['auto', 'When the pane is wide enough'], ['on', 'Always'], ['off', 'Never']]),
				this.#selectRow('PDF paper size (reading-view export)', 'printPaperSize',
					[['a4', 'A4'], ['letter', 'US Letter'], ['legal', 'US Legal'], ['tabloid', 'Tabloid']]),
			]),
			this.#section('Live edit', [
				this.#selectRow('⌘E returns from reading mode to', 'defaultEditMode',
					[['source', 'Source mode'], ['live', 'Live edit']]),
				this.#selectRow('Reveal syntax for', 'liveReveal',
					[['construct', 'The construct under the cursor'], ['line', 'The whole line']]),
				this.#checkRow('Typeset math in place', 'liveRenderMath'),
				this.#checkRow('Render diagram and query fences in place', 'liveRenderFences'),
				this.#checkRow('Render embeds and media in place', 'liveRenderEmbeds'),
				this.#numberRow('Rendered blocks kept alive (advanced)', 'liveFrameCap', 16, 4, 64),
			]),
			this.#section('Editor toolbar', [
				this.#selectRow('Show the toolbar', 'editorToolbar',
					[['live', 'In live edit'], ['always', 'In live edit and source mode'], ['never', 'Never']]),
				this.#checkRow('Selection bubble over selected text', 'selectionBubble'),
				this.#checkRow('// menu: type // for the Format menu', 'slashCommands'),
				this.#toolbarGroupsRow(),
			]),
			this.#section('Diary', [
				this.#selectRow('Mode', 'diaryMode',
					[['files', 'One note per day'], ['log', 'Single log note']]),
				this.#textRow('Log note (log mode)', 'diaryLogFile', 'Diary.md'),
				this.#textRow('Folder (per-day mode)', 'dailyNoteFolder', 'Daily'),
				this.#textRow('Date format', 'dailyNoteFormat', 'YYYY-MM-DD'),
				this.#textRow('Template note (optional)', 'dailyNoteTemplate', ''),
			]),
			this.#section('PDF viewer', [...this.#cjkFontRow()]),
			this.#section('Office documents', [...this.#officeEngineRow()]),
			this.#section('Files', [
				this.#textRow('Attachment folder', 'attachmentFolder', 'Attachments'),
				this.#textRow('Templates folder', 'templatesFolder', 'Templates'),
			]),
			this.#texFragmentsSection(),
			this.#vaultSection(),
			this.#hotkeysSection(),
		);
	}

	// ---- per-vault settings (.clew/vault-settings.json) --------------------

	#vaultSection() {
		const section = this.#section(`This vault (${vaultStore.vault?.name ?? '…'})`, []);
		section.append(
			...this.#vaultToggle('jmarkdownProject',
				'jmarkdown project: render own-line [[file.md]] links as inclusions',
				'For vaults that are jmarkdown manuscripts (a book folder, say): '
				+ 'reading mode transcludes [[chapter.md]] lines the way the CLI does. '
				+ 'Own-line wikilinks stop being plain links while this is on. '
				+ 'Open previews re-render when toggled.'),
			...this.#vaultToggle('normalSyntax',
				'Standard Markdown syntax: disable the jmarkdown inline dialect',
				'By default the dialect means *strong*, **intense**, /italic/, '
				+ '==highlight==, ~strikethrough~, and TeX-style sub/superscripts. '
				+ 'With this on, the engine reverts those to normal Markdown '
				+ '(*italic*, **bold**, etc.) while keeping everything else — math, '
				+ 'citations, diagrams, theorems. Renders and exports both honor it. '
				+ 'The editor highlighting still assumes the dialect for now.'),
			...this.#vaultToggle('noteApi',
				'Note API: scripts in rendered notes may control Clew',
				'Gives <script> tags in reading mode a window.clew API: open notes, '
				+ 'search, read and write notes and frontmatter, run commands, and share '
				+ 'state in clewdata.json (which travels with the vault). Notes are code '
				+ 'with this on — enable it only for vaults you trust. See the Note API '
				+ 'guide note.'),
			...this.#vaultToggle('history',
				'Note history: keep snapshots of notes as they change',
				'Before a save displaces an existing note (or canvas), the old text '
				+ 'is copied into .clew/history/ — at most one snapshot per five '
				+ 'minutes of editing, capped per note at 40 versions and 60 days '
				+ '(the newest always survives). Browse and restore with "View note '
				+ 'history…" in the palette or the File menu; the snapshots are '
				+ 'plain files you could also recover by hand.',
				{ defaultOn: true }),
		);
		section.append(
			...this.#vaultTextRow('bibliography',
				'Bibliography file (vault-wide)',
				'refs.bib — a path from the vault root, or an absolute path',
				'Every note resolves \\cite commands against this BibTeX file, '
				+ 'with no per-note properties needed. A note that sets its own '
				+ 'Bibliography: property still wins, and @bibliography blocks '
				+ 'keep their full jmarkdown behaviour (sections, scopes, styles). '
				+ 'Clear the field to turn vault-wide citations off.'),
			...this.#vaultTextRow('bibliographyStyle',
				'Bibliography style',
				'chicago (default) — a style name or a .csl file path',
				'Named styles ship with the engine: apa, chicago, harvard1, '
				+ 'vancouver, bjps, ajp, econometrica, ergo. Anything else is '
				+ 'read as a path to a custom CSL file (from the vault root, or '
				+ 'absolute). Notes can override with a Bibliography style: '
				+ 'property.',
				['apa', 'chicago', 'harvard1', 'vancouver', 'bjps', 'ajp', 'econometrica', 'ergo']),
			...this.#vaultTextRow('excalidrawFormat',
				'New Excalidraw drawings are saved as',
				'markdown — Obsidian\'s convention (default)',
				'Leave empty or set "markdown" for Obsidian\'s .excalidraw.md, which '
				+ 'is what a vault shared with Obsidian should contain: its plugin '
				+ 'only indexes markdown, so the wrapper is what gives a drawing '
				+ 'backlinks, tags and searchable text THERE. Set "json" for a plain '
				+ '.excalidraw, which is the honest extension for a vault Clew has to '
				+ 'itself. Clew reads and indexes both identically — it reads the '
				+ 'words out of the drawing itself — so the choice costs you nothing '
				+ 'here, only in Obsidian.',
				['markdown', 'json']),
			...this.#vaultToggle('pandocCitations',
				'Pandoc citations: read [@key] and @key as citations',
				'For vaults whose notes were written for pandoc — Zotero and '
				+ 'Better BibTeX export this style. [@key] becomes a parenthetical '
				+ 'citation, @key a textual one, [-@key] a bare year; they mix '
				+ 'freely with \\cite commands and resolve against the same '
				+ 'bibliography. Off by default because @ is jmarkdown\'s '
				+ 'directive sigil: with this on, a bare @word that is not a '
				+ 'registered directive is read as a citation key, so an email '
				+ 'address or an @mention in prose will change how it renders.'),
			...this.#vaultToggle('dataviewJs',
				'Run dataviewjs blocks in this vault',
				'Obsidian\'s ```dataviewjs blocks are JavaScript, not queries, so '
				+ 'there is no way to tell in advance what one will do — which is '
				+ 'why this is per-vault and off by default rather than a global '
				+ 'setting you turn on once and forget. Turn it on for a vault you '
				+ 'wrote or trust. Clew gives those blocks a `dv` object over its '
				+ 'own index: dv.pages, dv.current, dv.table, dv.list, dv.taskList '
				+ 'and dv.view all work. dv.app, dv.io and dv.luxon have no '
				+ 'equivalent here and say so by name when a block reaches for '
				+ 'them. Plain ```dataview queries always run and need no setting.'),
			...this.#vaultListRow('unindexed',
				'Listed but not indexed',
				'**/libs\n**/node_modules',
				'Folders here stay in the file explorer and open normally, but Clew '
				+ 'does not index or watch them: no backlinks, tags, search hits or '
				+ 'quick-switcher entries, and a change made by another program will '
				+ 'not refresh on its own. This is for the large folders that are not '
				+ 'notes — a presentation library, a build directory, a font pack. '
				+ 'One pattern per line: a path means that folder and everything under '
				+ 'it, * matches within one folder name, ** matches any depth — '
				+ 'prefer **/libs over */libs unless you really mean the top level only.'),
			...this.#vaultListRow('hidden',
				'Hidden entirely',
				'Archive/2019',
				'As if the folder were not in the vault at all: not listed, not opened, '
				+ 'not indexed, not watched, and not published by a website export. '
				+ 'Same pattern syntax. (.clew, .git, .obsidian, node_modules and '
				+ '.trash are always hidden, whatever these lists say.)'),
			...this.#vaultToggle('bibliographyPanel',
				'References panel: show the bibliography in the right sidebar',
				'Adds a Refs tab beside Links/Out/Tags showing the active note\'s '
				+ 'formatted references — even while the note is in source mode. '
				+ 'Notes never need an inline @bibliography block for it; authoring '
				+ 'one anyway still renders inline as usual.'),
		);
		this.#pluginRows(section);
		return section;
	}

	/** Every plugin available here — this vault's (.clew/plugins/) and the
	 *  globally installed ones — each with its per-vault enable. */
	#pluginRows(section) {
		ipc.invoke(CH.PLUGINS_LIST).then(({ plugins, enabled, globalDir }) => {
			const heading = document.createElement('p');
			heading.className = 'settings-hint';
			heading.textContent = plugins.length
				? 'Plugins available here: this vault\'s own (.clew/plugins/) and '
					+ 'the ones installed globally, marked below. Installing is '
					+ 'global; enabling is always per-vault — a plugin is arbitrary '
					+ 'code, so enable only what you trust. Notes already open '
					+ 're-render; reopen them if a preview plugin doesn\'t appear.'
				: 'No plugins found. A plugin is a folder with a manifest.json, '
					+ 'either in this vault\'s .clew/plugins/ or in the global '
					+ 'folder — install it once there and it is offered in every '
					+ 'vault, still off until you enable it here.';
			section.append(heading);
			// The global folder, and a way to reach it (it may not exist yet).
			const openButton = document.createElement('button');
			openButton.className = 'hotkey-button';
			openButton.textContent = 'Open global plugin folder';
			openButton.addEventListener('click', () => {
				ipc.invoke(CH.PLUGINS_REVEAL_GLOBAL).catch(() => {});
			});
			const folderRow = this.#row('Global plugins', openButton);
			folderRow.title = globalDir ?? '';
			section.append(folderRow);

			const enabledSet = new Set(enabled);
			for (const plugin of plugins) {
				const box = document.createElement('input');
				box.type = 'checkbox';
				box.checked = enabledSet.has(plugin.id);
				const surfaces = Object.keys(plugin.surfaces).join(', ') || 'no surfaces';
				const where = plugin.scope === 'global' ? 'global' : 'this vault';
				const row = this.#row(
					`${plugin.name} (${plugin.version}) — ${surfaces} · ${where}`, box);
				box.addEventListener('change', () => {
					if (box.checked) enabledSet.add(plugin.id);
					else enabledSet.delete(plugin.id);
					box.disabled = true;
					vaultSettingsStore.set('plugins', [...enabledSet])
						.finally(() => { box.disabled = false; });
				});
				section.append(row);
				if (plugin.description) {
					const hint = document.createElement('p');
					hint.className = 'settings-hint';
					hint.textContent = plugin.description;
					section.append(hint);
				}
			}
		}).catch(() => {});
	}

	/**
	 * A per-vault list, one entry per line — the exclusion globs. A textarea
	 * rather than a text input because these are lists people grow, and
	 * because a glob with a comma in it should not have to be escaped.
	 */
	#vaultListRow(key, label, placeholder, hintText) {
		const box = document.createElement('textarea');
		box.className = 'settings-list-input';
		box.rows = 3;
		box.placeholder = placeholder;
		box.spellcheck = false;
		box.disabled = true;
		const row = this.#row(label, box);
		row.classList.add('settings-row-stacked');
		const hint = document.createElement('p');
		hint.className = 'settings-hint';
		hint.textContent = hintText;
		ipc.invoke(CH.VAULT_SETTINGS_GET).then((vaultSettings) => {
			const list = Array.isArray(vaultSettings?.[key]) ? vaultSettings[key] : [];
			box.value = list.join('\n');
			box.disabled = false;
		}).catch(() => {});
		// Long, because saving re-walks the vault: tree, watcher and index.
		const save = debounce(() => {
			const value = box.value.split('\n').map((line) => line.trim()).filter(Boolean);
			vaultSettingsStore.set(key, value).catch(() => {});
		}, 900);
		box.addEventListener('input', save);
		box.addEventListener('blur', () => save.flush());
		box.addEventListener('keydown', (e) => e.stopPropagation());
		return [row, hint];
	}

	#vaultTextRow(key, label, placeholder, hintText, suggestions = []) {
		const input = document.createElement('input');
		input.type = 'text';
		input.placeholder = placeholder;
		input.disabled = true;
		const row = this.#row(label, input);
		if (suggestions.length > 0) {
			const list = document.createElement('datalist');
			list.id = `vault-${key}-suggestions`;
			for (const value of suggestions) {
				const option = document.createElement('option');
				option.value = value;
				list.append(option);
			}
			input.setAttribute('list', list.id);
			row.append(list);
		}
		const hint = document.createElement('p');
		hint.className = 'settings-hint';
		hint.textContent = hintText;
		ipc.invoke(CH.VAULT_SETTINGS_GET).then((vaultSettings) => {
			input.value = typeof vaultSettings?.[key] === 'string' ? vaultSettings[key] : '';
			input.disabled = false;
		}).catch(() => {});
		const save = debounce(() => {
			vaultSettingsStore.set(key, input.value.trim()).catch(() => {});
		}, 500);
		input.addEventListener('input', save);
		input.addEventListener('blur', () => save.flush());
		input.addEventListener('keydown', (e) => e.stopPropagation());
		return [row, hint];
	}

	#vaultToggle(key, label, hintText, { defaultOn = false } = {}) {
		const box = document.createElement('input');
		box.type = 'checkbox';
		box.disabled = true;
		const row = this.#row(label, box);
		const hint = document.createElement('p');
		hint.className = 'settings-hint';
		hint.textContent = hintText;
		ipc.invoke(CH.VAULT_SETTINGS_GET).then((vaultSettings) => {
			box.checked = defaultOn
				? vaultSettings?.[key] !== false
				: vaultSettings?.[key] === true;
			box.disabled = false;
		}).catch(() => {});
		box.addEventListener('change', () => {
			box.disabled = true;
			vaultSettingsStore.set(key, box.checked)
				.catch(() => {})
				.finally(() => {
					box.disabled = false;
					invalidateNoteApiGate();
				});
		});
		return [row, hint];
	}

	// ---- TeX fragments -----------------------------------------------------
	// Named preamble text a ```latex / ```tex / ```tikz block asks for by
	// name — `clew-fragments='math macros, colours'` — instead of carrying
	// its own copy (src/engine/figures.js#applyTexFragments).
	//
	// Two scopes, because both answers to "where should these live" are
	// right: the GLOBAL list is yours on this machine and offered in every
	// vault, THIS VAULT's list travels with the vault to another machine or
	// another person. A vault fragment SHADOWS a global one of the same
	// name — the plugins arrangement. engine/tex-fragments.js owns that rule
	// and the worker applies it; this view imports the same fragmentKey so
	// what it calls a clash is what the worker calls a shadow.

	#texFragmentsSection() {
		const section = this.#section('TeX fragments', []);
		const hint = document.createElement('p');
		hint.className = 'settings-hint';
		hint.textContent = 'Preamble text your figures can share. Name a fragment here, then '
			+ 'ask for it on a figure\'s first line — ```latex clew-fragments=\'math macros, '
			+ 'colours\' — and its text is inserted into that figure\'s preamble, after the '
			+ '\\documentclass Clew writes. Several names are separated by commas, and are '
			+ 'inserted in the order you list them. A name nothing here defines is refused by '
			+ 'name rather than typeset without it. Figures using a fragment re-typeset as '
			+ 'you edit it.';
		section.append(hint);
		section.append(this.#fragmentGroup('global'));
		if (vaultStore.vault) {
			section.append(this.#fragmentGroup('vault'));
		} else {
			const none = document.createElement('p');
			none.className = 'settings-hint';
			none.textContent = 'Open a vault to give it fragments of its own.';
			section.append(none);
		}
		return section;
	}

	/** Anything stored → the shape the rows edit. */
	#fragmentEntries(list) {
		return (Array.isArray(list) ? list : [])
			.filter((entry) => entry && typeof entry === 'object')
			.map((entry) => ({ name: String(entry.name ?? ''), text: String(entry.text ?? '') }));
	}

	/** Repaint every group's per-row notes (a rename in one scope changes the other's). */
	#refreshFragmentHints() {
		for (const group of this.#fragmentScopes.values()) group.refresh();
	}

	#fragmentGroup(scope) {
		const group = document.createElement('div');
		group.className = 'tex-fragment-group';
		const subhead = document.createElement('h3');
		subhead.className = 'settings-subhead';
		subhead.textContent = scope === 'global'
			? 'Global — every vault on this machine'
			: `This vault (${vaultStore.vault?.name ?? '…'}) — travels with the vault`;
		const list = document.createElement('div');
		list.className = 'tex-fragment-list';
		const add = document.createElement('button');
		add.className = 'hotkey-button';
		add.textContent = 'Add fragment';
		group.append(subhead, list, add);

		const entries = [];
		const rows = [];

		// Long, because every save respawns the render worker and re-renders
		// the previews using a fragment: a keystroke is not a change of mind.
		const persist = debounce(() => {
			const value = entries.map(({ name, text }) => ({ name, text }));
			if (scope === 'global') settingsStore.set('texFragments', value);
			else vaultSettingsStore.set('texFragments', value).catch(() => {});
		}, 900);

		const refresh = () => {
			const globalEntries = this.#fragmentScopes.get('global')?.entries
				?? this.#fragmentEntries(settingsStore.get('texFragments'));
			const shadowed = new Set(globalEntries.map((e) => fragmentKey(e.name)).filter(Boolean));
			const counts = new Map();
			for (const { entry } of rows) {
				const key = fragmentKey(entry.name);
				if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
			}
			for (const { entry, note } of rows) {
				const key = fragmentKey(entry.name);
				if (!key) note.textContent = 'Unnamed: a figure cannot ask for it yet.';
				// The attribute is a comma list, so a comma in a name makes the
				// fragment unaskable — better said here than discovered as a
				// refusal on a figure.
				else if (key.includes(',')) note.textContent = 'A comma in the name: a figure could not ask for this one.';
				else if (counts.get(key) > 1) note.textContent = 'Named twice here — the last row wins.';
				else if (scope === 'vault' && shadowed.has(key)) note.textContent = 'Shadows the global fragment of this name.';
				else note.textContent = '';
			}
		};
		this.#fragmentScopes.set(scope, { entries, refresh, persist });

		const addRow = (entry, { focus = false } = {}) => {
			const row = document.createElement('div');
			row.className = 'tex-fragment-row';
			const side = document.createElement('div');
			side.className = 'tex-fragment-side';
			const name = document.createElement('input');
			name.type = 'text';
			name.placeholder = 'math macros';
			name.value = entry.name;
			const note = document.createElement('p');
			note.className = 'tex-fragment-note';
			const del = document.createElement('button');
			del.className = 'tex-fragment-delete';
			del.textContent = 'Delete';
			side.append(name, note, del);

			const host = document.createElement('div');
			host.className = 'tex-fragment-editor';
			const editor = createCodeEditor({
				doc: entry.text,
				language: 'latex',
				placeholder: '\\usepackage{mathtools}\n\\newcommand{\\R}{\\mathbb{R}}',
				onChange: (text) => { entry.text = text; persist(); },
			});
			host.append(editor.dom);
			this.#fragmentEditors.push(editor);

			name.addEventListener('input', () => {
				entry.name = name.value;
				this.#refreshFragmentHints();
				persist();
			});
			name.addEventListener('blur', () => persist.flush());
			editor.view.dom.addEventListener('focusout', () => persist.flush());
			name.addEventListener('keydown', (e) => e.stopPropagation());

			// Two steps, because a settings row has no undo and a fragment
			// some note names is not something to lose to a stray click.
			let armed = null;
			const disarm = () => {
				clearTimeout(armed);
				armed = null;
				del.textContent = 'Delete';
				del.classList.remove('is-armed');
			};
			del.addEventListener('click', () => {
				if (!armed && (entry.name.trim() || editor.text().trim())) {
					del.textContent = 'Delete?';
					del.classList.add('is-armed');
					armed = setTimeout(disarm, 4000);
					return;
				}
				disarm();
				const at = entries.indexOf(entry);
				if (at >= 0) entries.splice(at, 1);
				const rowAt = rows.findIndex((r) => r.entry === entry);
				if (rowAt >= 0) rows.splice(rowAt, 1);
				this.#fragmentEditors = this.#fragmentEditors.filter((e) => e !== editor);
				editor.destroy();
				row.remove();
				this.#refreshFragmentHints();
				persist();
				persist.flush();
			});

			row.append(side, host);
			list.append(row);
			rows.push({ entry, note });
			if (focus) name.focus();
		};

		const load = (stored) => {
			entries.push(...this.#fragmentEntries(stored));
			for (const entry of entries) addRow(entry);
			this.#refreshFragmentHints();
		};
		if (scope === 'global') load(settingsStore.get('texFragments'));
		else ipc.invoke(CH.VAULT_SETTINGS_GET).then((vs) => load(vs?.texFragments)).catch(() => {});

		add.addEventListener('click', () => {
			const entry = { name: '', text: '' };
			entries.push(entry);
			addRow(entry, { focus: true });
			this.#refreshFragmentHints();
		});
		return group;
	}

	#section(title, rows) {
		const section = document.createElement('section');
		section.className = 'settings-section';
		const heading = document.createElement('h2');
		heading.textContent = title;
		section.append(heading, ...rows);
		return section;
	}

	/**
	 * The optional CJK font download. A PDF that uses Chinese, Japanese or
	 * Korean text without embedding its fonts needs the reader to supply them,
	 * and the four Noto packs are 139 MB — too much to put in every installer
	 * for the minority who need them, and not something to fetch from a CDN
	 * mid-render. So: an explicit, one-time, app-global download.
	 */
	#cjkFontRow() {
		const button = document.createElement('button');
		const hint = document.createElement('p');
		hint.className = 'settings-hint';

		const EXPLAIN = 'Downloaded once from the EmbedPDF font packages and kept locally — '
			+ 'nothing is fetched while you read. Only needed for PDFs that use CJK text '
			+ 'without embedding their own fonts.';
		const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;
		let polling = null;

		const paint = (status) => {
			const on = settingsStore.get('pdfCjkFonts') === true;
			if (status.downloading) {
				const p = status.progress ?? { done: 0, total: 0 };
				button.textContent = 'Downloading…';
				button.disabled = true;
				hint.textContent = `Downloading ${p.pack ?? ''} — file ${p.done} of ${p.total}. `
					+ 'You can leave this screen; it continues in the background.';
			} else if (status.installed) {
				button.textContent = on ? 'Remove' : 'Switch on';
				button.disabled = false;
				hint.textContent = (on
					? `Installed (${mb(status.bytesOnDisk)}). CJK PDFs can use them now. `
					: `Downloaded (${mb(status.bytesOnDisk)}) but switched off. `) + EXPLAIN;
			} else {
				button.textContent = `Download (${mb(status.totalBytes)})`;
				button.disabled = false;
				hint.textContent = 'Not downloaded — a CJK PDF that does not embed its fonts '
					+ 'may render blank. ' + EXPLAIN;
			}
			if (status.downloading && !polling) polling = setInterval(refresh, 700);
			if (!status.downloading && polling) { clearInterval(polling); polling = null; }
		};

		const refresh = () => ipc.invoke(CH.PDF_FONTS_STATUS).then(paint).catch(() => {});

		button.addEventListener('click', async () => {
			const status = await ipc.invoke(CH.PDF_FONTS_STATUS);
			if (status.installed && settingsStore.get('pdfCjkFonts') === true) {
				settingsStore.set('pdfCjkFonts', false);
				paint(await ipc.invoke(CH.PDF_FONTS_REMOVE));
				return;
			}
			settingsStore.set('pdfCjkFonts', true);
			if (status.installed) { refresh(); return; }
			button.disabled = true;
			button.textContent = 'Downloading…';
			polling ??= setInterval(refresh, 700);
			paint(await ipc.invoke(CH.PDF_FONTS_DOWNLOAD));
		});

		refresh();
		// Row + hint as siblings, the way the vault rows do it: .settings-row is
		// a two-column flex and a third child would squeeze the label to shreds.
		return [this.#row('Chinese, Japanese and Korean fonts', button), hint];
	}

	/**
	 * The LibreOffice engine download — the same shape as the CJK fonts:
	 * off the installer, fetched once by explicit choice, removable. The
	 * pin-verification story lives in src/main/zeta-assets.js.
	 */
	#officeEngineRow() {
		const button = document.createElement('button');
		const hint = document.createElement('p');
		hint.className = 'settings-hint';

		const EXPLAIN = 'Word, Excel and PowerPoint documents open and edit in tabs using '
			+ 'LibreOffice (ZetaOffice), downloaded once and verified against pinned '
			+ 'checksums — nothing is fetched while you work.';
		const mb = (bytes) => `${Math.round((bytes ?? 0) / 1048576)} MB`;
		let polling = null;

		const paint = (status) => {
			if (status.downloading) {
				const p = status.progress ?? {};
				button.textContent = 'Downloading…';
				button.disabled = true;
				hint.textContent = `Downloading ${p.file ?? ''} — ${mb(p.received)}`
					+ `${p.expected ? ` of ${mb(p.expected)}` : ''} (file ${Math.min(p.done + 1, p.total)} of ${p.total}). `
					+ 'You can leave this screen; it continues in the background.';
			} else if (status.installed) {
				button.textContent = status.managed ? 'Remove' : 'Installed';
				button.disabled = !status.managed; // dev tree: hand-installed
				hint.textContent = `Installed (${mb(status.bytesOnDisk)} on disk). ` + EXPLAIN;
			} else {
				button.textContent = `Download (${mb(status.wireBytes)})`;
				button.disabled = false;
				hint.textContent = (status.lastError
					? `The last download did not finish: ${status.lastError} `
					: 'Not downloaded — office documents show a download offer when opened. ') + EXPLAIN;
			}
			if (status.downloading && !polling) polling = setInterval(refresh, 700);
			if (!status.downloading && polling) { clearInterval(polling); polling = null; }
		};

		const refresh = () => ipc.invoke(CH.OFFICE_ENGINE_STATUS).then(paint).catch(() => {});

		button.addEventListener('click', async () => {
			const status = await ipc.invoke(CH.OFFICE_ENGINE_STATUS);
			if (status.installed && status.managed) {
				paint(await ipc.invoke(CH.OFFICE_ENGINE_REMOVE));
				return;
			}
			button.disabled = true;
			button.textContent = 'Downloading…';
			polling ??= setInterval(refresh, 700);
			paint(await ipc.invoke(CH.OFFICE_ENGINE_DOWNLOAD));
		});

		refresh();
		return [this.#row('LibreOffice engine', button), hint];
	}

	#row(label, control) {
		const row = document.createElement('div');
		row.className = 'settings-row';
		const labelEl = document.createElement('label');
		labelEl.textContent = label;
		row.append(labelEl, control);
		return row;
	}

	#textRow(label, key, placeholder) {
		const input = document.createElement('input');
		input.type = 'text';
		input.placeholder = placeholder;
		input.value = settingsStore.get(key) ?? '';
		const save = debounce(() => settingsStore.set(key, input.value.trim()), 400);
		input.addEventListener('input', save);
		input.addEventListener('blur', () => save.flush());
		input.addEventListener('keydown', (e) => e.stopPropagation());
		return this.#row(label, input);
	}

	/** The toolbar's groups: shown or not, and their order (▲▼). The mode
	 *  switch is not listed — it cannot be hidden. */
	#toolbarGroupsRow() {
		const wrap = document.createElement('div');
		wrap.className = 'settings-row settings-row-stacked toolbar-groups-setting';
		const all = TOOLBAR_GROUPS.filter((g) => g.id !== 'mode');
		const draw = () => {
			const saved = settingsStore.get('editorToolbarGroups');
			const order = Array.isArray(saved) ? saved.filter((id) => all.some((g) => g.id === id)) : all.map((g) => g.id);
			const hidden = all.filter((g) => !order.includes(g.id)).map((g) => g.id);
			const rows = [...order, ...hidden].map((id, i, list) => {
				const group = all.find((g) => g.id === id);
				const row = document.createElement('div');
				row.className = 'toolbar-group-row';
				row.dataset.group = id;
				const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: order.includes(id) });
				const name = Object.assign(document.createElement('span'), { textContent: group.label });
				const up = Object.assign(document.createElement('button'), { textContent: '▲', title: 'Move up', disabled: i === 0 });
				const down = Object.assign(document.createElement('button'), { textContent: '▼', title: 'Move down', disabled: i === list.length - 1 });
				const save = (next) => { settingsStore.set('editorToolbarGroups', next); draw(); };
				box.addEventListener('change', () => save(box.checked ? [...order, id] : order.filter((x) => x !== id)));
				const move = (d) => {
					const next = [...list];
					[next[i], next[i + d]] = [next[i + d], next[i]];
					save(next.filter((x) => order.includes(x)));
				};
				up.addEventListener('click', () => move(-1));
				down.addEventListener('click', () => move(1));
				row.append(box, name, up, down);
				return row;
			});
			const reset = Object.assign(document.createElement('button'), { textContent: 'Reset', className: 'toolbar-groups-reset' });
			reset.addEventListener('click', () => { settingsStore.set('editorToolbarGroups', null); draw(); });
			const label = Object.assign(document.createElement('div'), { className: 'settings-label', textContent: 'Groups, in order' });
			wrap.replaceChildren(label, ...rows, reset);
		};
		draw();
		return wrap;
	}

	#numberRow(label, key, fallback, min, max) {
		const input = document.createElement('input');
		input.type = 'number';
		input.min = min;
		input.max = max;
		input.value = settingsStore.get(key) ?? fallback;
		input.addEventListener('change', () => {
			const value = Math.max(min, Math.min(max, Number(input.value) || fallback));
			input.value = value;
			settingsStore.set(key, value);
		});
		input.addEventListener('keydown', (e) => e.stopPropagation());
		return this.#row(label, input);
	}

	#checkRow(label, key) {
		const box = document.createElement('input');
		box.type = 'checkbox';
		box.checked = settingsStore.get(key) === true;
		box.addEventListener('change', () => settingsStore.set(key, box.checked));
		return this.#row(label, box);
	}

	#selectRow(label, key, options) {
		const select = document.createElement('select');
		for (const [value, text] of options) {
			const option = document.createElement('option');
			option.value = value;
			option.textContent = text;
			select.append(option);
		}
		select.value = settingsStore.get(key) ?? options[0][0];
		select.addEventListener('change', () => settingsStore.set(key, select.value));
		return this.#row(label, select);
	}

	// ---- hotkeys ----------------------------------------------------------

	#hotkeysSection() {
		const section = document.createElement('section');
		section.className = 'settings-section';
		const heading = document.createElement('h2');
		heading.textContent = 'Hotkeys';
		const filter = document.createElement('input');
		filter.type = 'text';
		filter.className = 'hotkey-filter';
		filter.placeholder = 'Filter commands…';
		filter.value = this.#filter;
		filter.addEventListener('keydown', (e) => e.stopPropagation());
		const list = document.createElement('div');
		list.className = 'hotkey-list';
		filter.addEventListener('input', () => {
			this.#filter = filter.value;
			this.#renderHotkeyList(list);
		});
		section.append(heading, filter, list);
		this.#renderHotkeyList(list);
		return section;
	}

	#chordsFor(command, overrides) {
		return overrides[command.id] ?? command.hotkeys ?? [];
	}

	#renderHotkeyList(list) {
		const overrides = settingsStore.get('hotkeys') ?? {};
		const commands = allCommands()
			.filter((c) => !this.#filter || c.name.toLowerCase().includes(this.#filter.toLowerCase()))
			.sort((a, b) => a.name.localeCompare(b.name));

		// Conflicts: any chord claimed by more than one command's EFFECTIVE set.
		const claims = new Map();
		for (const command of allCommands()) {
			for (const chord of this.#chordsFor(command, overrides)) {
				claims.set(chord, (claims.get(chord) ?? 0) + 1);
			}
		}

		list.replaceChildren(...commands.map((command) => {
			const row = document.createElement('div');
			row.className = 'hotkey-row';

			const name = document.createElement('span');
			name.className = 'hotkey-name';
			name.textContent = command.name;

			const chords = document.createElement('span');
			chords.className = 'hotkey-chords';
			const effective = this.#chordsFor(command, overrides);
			if (this.#recordingId === command.id) {
				chords.textContent = 'Press a shortcut… (esc cancels)';
				chords.classList.add('is-recording');
			} else if (effective.length === 0) {
				chords.textContent = '—';
			} else {
				chords.replaceChildren(...effective.map((chord) => {
					const kbd = document.createElement('kbd');
					kbd.textContent = prettyChord(chord);
					if ((claims.get(chord) ?? 0) > 1) kbd.classList.add('is-conflict');
					return kbd;
				}));
			}
			if (command.id in overrides) chords.classList.add('is-custom');

			const setButton = document.createElement('button');
			setButton.className = 'hotkey-button';
			setButton.textContent = this.#recordingId === command.id ? 'Cancel' : 'Set';
			setButton.addEventListener('click', () => {
				if (this.#recordingId === command.id) this.#stopRecording(list);
				else this.#startRecording(command.id, list);
			});

			const resetButton = document.createElement('button');
			resetButton.className = 'hotkey-button';
			resetButton.textContent = 'Reset';
			resetButton.disabled = !(command.id in overrides);
			resetButton.addEventListener('click', () => {
				const next = { ...settingsStore.get('hotkeys') };
				delete next[command.id];
				settingsStore.set('hotkeys', next);
				this.#renderHotkeyList(list);
			});

			row.append(name, chords, setButton, resetButton);
			return row;
		}));
	}

	#recorderCleanup = null;

	#startRecording(commandId, list) {
		this.#stopRecording(list);
		this.#recordingId = commandId;
		const onKey = (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (event.key === 'Escape') {
				this.#stopRecording(list);
				return;
			}
			const chord = chordOf(event);
			if (!chord || !chord.includes('-')) return; // wait for a full chord
			settingsStore.set('hotkeys', {
				...(settingsStore.get('hotkeys') ?? {}),
				[commandId]: [chord],
			});
			this.#stopRecording(list);
		};
		window.addEventListener('keydown', onKey, { capture: true });
		this.#recorderCleanup = () => window.removeEventListener('keydown', onKey, { capture: true });
		this.#renderHotkeyList(list);
	}

	#stopRecording(list) {
		this.#recorderCleanup?.();
		this.#recorderCleanup = null;
		this.#recordingId = null;
		this.#renderHotkeyList(list);
	}

	cleanup() {
		this.#recorderCleanup?.();
		this.#dropFragmentEditors();
	}

	#dropFragmentEditors() {
		// A fragment edited in the last 900ms has a save pending; the tab
		// closing (or the vault changing) must not be what loses it.
		for (const group of this.#fragmentScopes.values()) group.persist.flush();
		for (const editor of this.#fragmentEditors) editor.destroy();
		this.#fragmentEditors = [];
		this.#fragmentScopes.clear();
	}
}

customElements.define('clew-settings-view', ClewSettingsView);
