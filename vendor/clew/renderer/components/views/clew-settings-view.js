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
import { allCommands, chordOf } from '../../commands/registry.js';
import { debounce } from '../../lib/debounce.js';
import { invalidateNoteApiGate } from '../../note-api.js';
import { ipc, CH } from '../../ipc.js';

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

	subscribe() {
		this.listen(settingsStore, 'settings-changed', () => {
			// Re-render only when not mid-edit in a text field.
			if (!this.contains(document.activeElement) || this.#recordingId) return;
		});
	}

	render() {
		this.classList.add('settings-view');
		this.innerHTML = '<div class="settings-scroll"></div>';
		const scroll = this.firstElementChild;
		scroll.append(
			this.#section('Appearance', [
				this.#selectRow('Theme', 'theme', [['dark', 'Dark'], ['light', 'Light']]),
				this.#selectRow('New note tabs open in', 'newTabMode',
					[['source', 'Source (edit) mode'], ['reading', 'Reading mode']]),
				this.#selectRow('Explorer click opens files', 'explorerOpenMode',
					[['new-tab', 'In a new tab'], ['replace', 'In the current tab (Obsidian-style)']]),
				this.#numberRow('Editor font size (px)', 'editorFontSize', 16, 10, 28),
				this.#numberRow('Editor line width (em)', 'editorLineWidth', 44, 20, 120),
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
			this.#section('Files', [
				this.#textRow('Attachment folder', 'attachmentFolder', 'Attachments'),
				this.#textRow('Templates folder', 'templatesFolder', 'Templates'),
			]),
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

	/** Discovered vault plugins (.clew/plugins/*) with per-plugin enables. */
	#pluginRows(section) {
		ipc.invoke(CH.PLUGINS_LIST).then(({ plugins, enabled }) => {
			if (!plugins.length) return;
			const heading = document.createElement('p');
			heading.className = 'settings-hint';
			heading.textContent = 'Plugins found in this vault (.clew/plugins/). '
				+ 'A plugin is arbitrary code — enable only what you trust. '
				+ 'Notes already open re-render; reopen them if a preview plugin '
				+ 'doesn\'t appear.';
			section.append(heading);
			const enabledSet = new Set(enabled);
			for (const plugin of plugins) {
				const box = document.createElement('input');
				box.type = 'checkbox';
				box.checked = enabledSet.has(plugin.id);
				const surfaces = Object.keys(plugin.surfaces).join(', ') || 'no surfaces';
				const row = this.#row(`${plugin.name} (${plugin.version}) — ${surfaces}`, box);
				box.addEventListener('change', () => {
					if (box.checked) enabledSet.add(plugin.id);
					else enabledSet.delete(plugin.id);
					box.disabled = true;
					ipc.invoke(CH.VAULT_SETTINGS_SET, { key: 'plugins', value: [...enabledSet] })
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
			ipc.invoke(CH.VAULT_SETTINGS_SET, { key, value: input.value.trim() }).finally(() => {
				window.dispatchEvent(new CustomEvent('clew:vault-settings-changed', { detail: { key } }));
			});
		}, 500);
		input.addEventListener('input', save);
		input.addEventListener('blur', () => save.flush());
		input.addEventListener('keydown', (e) => e.stopPropagation());
		return [row, hint];
	}

	#vaultToggle(key, label, hintText) {
		const box = document.createElement('input');
		box.type = 'checkbox';
		box.disabled = true;
		const row = this.#row(label, box);
		const hint = document.createElement('p');
		hint.className = 'settings-hint';
		hint.textContent = hintText;
		ipc.invoke(CH.VAULT_SETTINGS_GET).then((vaultSettings) => {
			box.checked = vaultSettings?.[key] === true;
			box.disabled = false;
		}).catch(() => {});
		box.addEventListener('change', () => {
			box.disabled = true;
			ipc.invoke(CH.VAULT_SETTINGS_SET, { key, value: box.checked })
				.finally(() => {
					box.disabled = false;
					invalidateNoteApiGate();
					window.dispatchEvent(new CustomEvent('clew:vault-settings-changed', { detail: { key } }));
				});
		});
		return [row, hint];
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
	}
}

customElements.define('clew-settings-view', ClewSettingsView);
