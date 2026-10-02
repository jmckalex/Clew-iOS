// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Settings → Callouts: custom callout types, in the two scopes the TeX
// fragments have — GLOBAL (clew-settings.json `callouts`, this Mac) and THIS
// VAULT (.clew/vault-settings.json `callouts`, travels with it, wins where
// names meet). One row per type: name, title, icon (a searchable picker over
// Font Awesome Free), colour (a swatch, or any hex/rgb()/hsl()/CSS name
// typed), aliases, and a preview in both themes drawn by the same rule
// reading view and live edit use. A row the rules refuse says why (shared/
// callout-definitions.js locally, and main's own verdict — which also covers a
// hand-edited file — after each save).
//
// The icon table (~1.9 MB) is fetched from main only when the picker first
// opens; the rows' previews ask main for just the icons they name.
import { settingsStore } from '../../state/settings-store.js';
import { vaultStore } from '../../state/vault-store.js';
import { vaultSettingsStore } from '../../state/vault-settings-store.js';
import { ipc, CH } from '../../ipc.js';
import { debounce } from '../../lib/debounce.js';
import { NAME_RE, validColor, defaultTitle } from '#jmarkdown/callout-definitions.js';
import { BUILTIN_CALLOUT_TYPES, builtinCalloutIcon } from '#jmarkdown/callout-table.js';
import { calloutProblems, onCalloutsSynced } from '../../callouts.js';

const PICKER_LIMIT = 240;
let fullTable = null; // { version, icons } once the picker has asked

const svgOf = (icon) => {
	if (!icon) return '';
	const [w, h, d] = icon;
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
	svg.setAttribute('class', 'callout-icon');
	svg.setAttribute('aria-hidden', 'true');
	const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('fill', 'currentColor');
	path.setAttribute('d', d);
	svg.append(path);
	return svg;
};

/** Stored → the rows' shape; anything odd becomes text the row then judges. */
function entriesOf(list) {
	return (Array.isArray(list) ? list : []).map((raw) => {
		const e = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
		return {
			name: typeof e.name === 'string' ? e.name : String(e.name ?? ''),
			title: e.title == null ? '' : String(e.title),
			icon: e.icon == null ? '' : String(e.icon),
			color: e.color == null ? '' : String(e.color),
			aliases: Array.isArray(e.aliases) ? e.aliases.map(String).join(', ') : '',
		};
	});
}

/** The rows' shape → what is stored: empty fields left out. */
function stored(entry) {
	const out = { name: entry.name.trim() };
	if (entry.title.trim()) out.title = entry.title.trim();
	if (entry.icon.trim()) out.icon = entry.icon.trim();
	if (entry.color.trim()) out.color = entry.color.trim();
	const aliases = entry.aliases.split(/[\s,]+/).map((a) => a.trim().toLowerCase()).filter(Boolean);
	if (aliases.length) out.aliases = aliases;
	return out;
}

/** A built-in's palette colour, read from the stylesheet (live-edit.css). */
function paletteColor(name) {
	const probe = document.createElement('span');
	probe.className = `le-callout le-callout-${name}`;
	probe.style.display = 'none';
	document.body.append(probe);
	const color = getComputedStyle(probe).getPropertyValue('--callout').trim();
	probe.remove();
	return color || '#6b7785';
}

/** Any colour the rules accept as #rrggbb, for the swatch (it takes no other
 *  form); null when the browser cannot read it. */
function hexOf(color) {
	const probe = document.createElement('span');
	probe.style.color = color;
	if (!probe.style.color) return null;
	probe.style.display = 'none';
	document.body.append(probe);
	const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(probe).color);
	probe.remove();
	return m ? `#${m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : null;
}

/** The section; `dispose()` flushes pending saves and lets go of listeners. */
export function calloutsSection(sectionOf) {
	const section = sectionOf('Callouts', []);
	section.classList.add('callouts-section');
	const hint = document.createElement('p');
	hint.className = 'settings-hint';
	hint.textContent = 'Callout types of your own, used as > [!name] like the built-in ones. '
		+ 'A name a built-in already has (note, tip, warning, …) changes that one instead. '
		+ 'One colour drives the border, icon, title and tint; Clew keeps it readable in both '
		+ 'themes. Notes using a type re-render as you edit it.';
	section.append(hint);
	const groups = [makeGroup('global')];
	section.append(groups[0].element);
	if (vaultStore.vault) {
		groups.push(makeGroup('vault'));
		section.append(groups[1].element);
	} else {
		const none = document.createElement('p');
		none.className = 'settings-hint';
		none.textContent = 'Open a vault to give it callout types of its own.';
		section.append(none);
	}
	const refreshAll = () => { for (const g of groups) g.refresh(); };
	for (const g of groups) g.siblings = groups;
	const off = onCalloutsSynced(() => { for (const g of groups) g.synced(); });
	const closePicker = () => document.querySelector('.callout-icon-picker')?.remove();
	refreshAll();
	return {
		element: section,
		dispose() {
			off();
			closePicker();
			for (const g of groups) g.persist.flush();
		},
	};
}

function makeGroup(scope) {
	const element = document.createElement('div');
	element.className = 'tex-fragment-group callout-def-group';
	element.dataset.scope = scope;
	const subhead = document.createElement('h3');
	subhead.className = 'settings-subhead';
	subhead.textContent = scope === 'global'
		? 'Global — every vault on this Mac'
		: `This vault (${vaultStore.vault?.name ?? '…'}) — travels with the vault, wins over global`;
	const list = document.createElement('div');
	list.className = 'tex-fragment-list';
	const notes = document.createElement('p');
	notes.className = 'tex-fragment-note callout-def-group-notes';
	const add = document.createElement('button');
	add.className = 'hotkey-button';
	add.textContent = 'Add callout type';
	element.append(subhead, list, notes, add);

	const entries = [];
	const rows = [];
	/** Icons the previews have: name as stored → [w, h, d] (or null: unknown). */
	const icons = new Map();
	let lastSaved = '';

	// Long, as the fragments' is: every save respawns the render worker and
	// re-renders the previews — a keystroke is not a change of mind.
	const persist = debounce(() => {
		const value = entries.map(stored);
		lastSaved = JSON.stringify(value);
		if (scope === 'global') settingsStore.set('callouts', value);
		else vaultSettingsStore.set('callouts', value).catch(() => {});
	}, 900);

	const group = { element, persist, siblings: [], refresh, synced };

	async function fetchIcons(names) {
		const wanted = names.filter((n) => n && !icons.has(n));
		if (!wanted.length) return;
		try {
			const { icons: found } = await ipc.invoke(CH.CALLOUT_ICONS, { names: wanted });
			for (const n of wanted) icons.set(n, found?.[n]?.icon ?? null);
		} catch {
			for (const n of wanted) icons.set(n, null);
		}
		refresh();
	}

	function localNote(entry, index) {
		const name = entry.name.trim();
		if (!name) return 'Unnamed: no callout can use it yet.';
		if (!NAME_RE.test(name)) return `Skipped: “${name}” is not a callout name — a letter, then letters, digits, - or _.`;
		if (entry.color.trim() && !validColor(entry.color)) return `Skipped: “${entry.color.trim()}” is not a colour (hex, rgb(), hsl() or a CSS name).`;
		const badAlias = entry.aliases.split(/[\s,]+/).filter(Boolean).find((a) => !NAME_RE.test(a));
		if (badAlias) return `Skipped: the alias “${badAlias}” is not a callout name.`;
		if (entry.icon.trim() && icons.get(entry.icon.trim()) === null) return `Skipped: no Font Awesome icon called “${entry.icon.trim()}”.`;
		const key = name.toLowerCase();
		const before = entries.slice(0, index).some((e) => e.name.trim().toLowerCase() === key);
		const after = entries.slice(index + 1).some((e) => e.name.trim().toLowerCase() === key);
		if (after) return 'Named again below — the last row wins.';
		if (before) return 'Named twice here — this row wins.';
		const parts = [];
		if (BUILTIN_CALLOUT_TYPES[key]) parts.push(`Changes the built-in “${key}”.`);
		if (scope === 'vault' && group.siblings[0]?.names().has(key)) parts.push('Its fields win over the global one of this name.');
		return parts.join(' ');
	}

	function names() {
		return new Set(entries.map((e) => e.name.trim().toLowerCase()).filter(Boolean));
	}
	group.names = names;

	function refresh() {
		const problems = calloutProblems().filter((p) => p.scope === scope);
		rows.forEach((row, index) => {
			const main = row.edited ? null : problems.find((p) => p.index === index && p.skipped);
			row.note.textContent = main ? `Skipped: ${main.reason}.` : localNote(row.entry, index);
			row.paint();
		});
		const general = problems.filter((p) => !p.skipped).map((p) => `${p.name ? `${p.name}: ` : ''}${p.reason}.`);
		notes.textContent = general.join(' ');
	}

	function synced() {
		for (const row of rows) row.edited = false;
		// A hand edit of the vault's file while Settings is open: take it,
		// unless the user is typing here (their next save is the newer one).
		if (scope === 'vault' && !element.contains(document.activeElement)) {
			ipc.invoke(CH.VAULT_SETTINGS_GET).then((vs) => {
				const fresh = JSON.stringify(Array.isArray(vs?.callouts) ? vs.callouts : []);
				if (fresh !== lastSaved && fresh !== JSON.stringify(entries.map(stored))) load(vs?.callouts);
				else refresh();
			}).catch(refresh);
			return;
		}
		refresh();
	}

	function addRow(entry, { focus = false } = {}) {
		const row = document.createElement('div');
		row.className = 'callout-def-row';
		const fields = document.createElement('div');
		fields.className = 'tex-fragment-side callout-def-fields';
		const input = (placeholder, value, label) => {
			const el = document.createElement('input');
			el.type = 'text';
			el.placeholder = placeholder;
			el.value = value;
			el.spellcheck = false;
			el.setAttribute('aria-label', label);
			el.addEventListener('keydown', (e) => e.stopPropagation());
			return el;
		};
		const name = input('name, e.g. remark', entry.name, 'Name');
		name.className = 'callout-def-name';
		const title = input('Title', entry.title, 'Title');
		title.className = 'callout-def-title';
		const line = document.createElement('div');
		line.className = 'callout-def-line';
		const iconButton = document.createElement('button');
		iconButton.className = 'callout-def-icon';
		iconButton.title = 'Choose an icon';
		const swatch = document.createElement('input');
		swatch.type = 'color';
		swatch.className = 'callout-def-swatch';
		swatch.setAttribute('aria-label', 'Colour');
		const color = input('#5b8def', entry.color, 'Colour');
		color.className = 'callout-def-color';
		line.append(iconButton, swatch, color);
		const aliases = input('aliases, e.g. rem, aside', entry.aliases, 'Aliases');
		aliases.className = 'callout-def-aliases';
		const note = document.createElement('p');
		note.className = 'tex-fragment-note callout-def-note';
		const del = document.createElement('button');
		del.className = 'tex-fragment-delete';
		del.textContent = 'Delete';
		fields.append(name, title, line, aliases, note, del);

		const preview = document.createElement('div');
		preview.className = 'callout-def-preview';
		const samples = ['is-dark', 'is-light'].map((theme) => {
			const sample = document.createElement('div');
			sample.className = `callout-sample ${theme}`;
			const head = document.createElement('div');
			head.className = 'callout-sample-title';
			const body = document.createElement('div');
			body.className = 'callout-sample-body';
			sample.append(head, body);
			preview.append(sample);
			return { sample, head, body };
		});
		row.append(fields, preview);

		const record = { entry, note, edited: false, paint: () => {} };
		record.paint = () => {
			const key = entry.name.trim().toLowerCase();
			const builtin = BUILTIN_CALLOUT_TYPES[key];
			const colorOk = entry.color.trim() && validColor(entry.color);
			const shown = colorOk ? entry.color.trim() : builtin ? paletteColor(key) : '#6b7785';
			const iconName = entry.icon.trim();
			const icon = iconName ? icons.get(iconName) : null;
			const label = entry.title.trim() || builtin?.label || (key ? defaultTitle(key) : 'Callout');
			title.placeholder = builtin?.label ?? (key ? defaultTitle(key) : 'Title');
			color.placeholder = builtin ? paletteColor(key) : '#5b8def';
			iconButton.replaceChildren();
			const glyph = icon ? svgOf(icon) : null;
			if (glyph) iconButton.append(glyph);
			else iconButton.insertAdjacentHTML('beforeend', builtinCalloutIcon(builtin ? key : 'note'));
			const caption = document.createElement('span');
			caption.textContent = iconName || (builtin ? 'built-in icon' : 'icon');
			iconButton.append(caption);
			const hex = hexOf(shown);
			if (hex) swatch.value = hex;
			for (const { sample, head, body } of samples) {
				sample.classList.toggle('is-custom', Boolean(colorOk));
				sample.style.setProperty('--clew-callout-color', shown);
				head.replaceChildren();
				if (glyph) head.append(glyph.cloneNode(true));
				else head.insertAdjacentHTML('beforeend', builtinCalloutIcon(builtin ? key : 'note'));
				const text = document.createElement('span');
				text.textContent = label;
				head.append(text);
				body.textContent = `> [!${key || 'name'}]`;
			}
		};

		const changed = () => {
			record.edited = true;
			refresh();
			for (const g of group.siblings) if (g !== group) g.refresh();
			persist();
		};
		name.addEventListener('input', () => { entry.name = name.value; changed(); });
		title.addEventListener('input', () => { entry.title = title.value; changed(); });
		color.addEventListener('input', () => { entry.color = color.value; changed(); });
		swatch.addEventListener('input', () => { entry.color = swatch.value; color.value = swatch.value; changed(); });
		aliases.addEventListener('input', () => { entry.aliases = aliases.value; changed(); });
		for (const el of [name, title, color, aliases, swatch]) el.addEventListener('blur', () => persist.flush());
		iconButton.addEventListener('click', () => openPicker(iconButton, (picked) => {
			entry.icon = picked.stored;
			icons.set(picked.stored, picked.icon);
			changed();
			persist.flush();
		}));

		// Two steps, as the fragments' Delete: a settings row has no undo.
		let armed = null;
		const disarm = () => {
			clearTimeout(armed);
			armed = null;
			del.textContent = 'Delete';
			del.classList.remove('is-armed');
		};
		del.addEventListener('click', () => {
			if (!armed && (entry.name.trim() || entry.title.trim() || entry.icon.trim() || entry.color.trim())) {
				del.textContent = 'Delete?';
				del.classList.add('is-armed');
				armed = setTimeout(disarm, 4000);
				return;
			}
			disarm();
			const at = entries.indexOf(entry);
			if (at >= 0) entries.splice(at, 1);
			const rowAt = rows.indexOf(record);
			if (rowAt >= 0) rows.splice(rowAt, 1);
			row.remove();
			for (const r of rows) r.edited = true;
			refresh();
			persist();
			persist.flush();
		});

		list.append(row);
		rows.push(record);
		if (focus) name.focus();
	}

	function load(value) {
		entries.length = 0;
		rows.length = 0;
		lastSaved = JSON.stringify(Array.isArray(value) ? value : []);
		list.replaceChildren();
		entries.push(...entriesOf(value));
		for (const entry of entries) addRow(entry);
		refresh();
		fetchIcons(entries.map((e) => e.icon.trim()));
	}

	if (scope === 'global') load(settingsStore.get('callouts'));
	else ipc.invoke(CH.VAULT_SETTINGS_GET).then((vs) => load(vs?.callouts)).catch(() => {});

	add.addEventListener('click', () => {
		const entry = { name: '', title: '', icon: '', color: '', aliases: '' };
		entries.push(entry);
		addRow(entry, { focus: true });
		refresh();
	});
	return group;
}

/** The icon picker: a searchable grid over the whole table, under `anchor`. */
async function openPicker(anchor, onPick) {
	document.querySelector('.callout-icon-picker')?.remove();
	const panel = document.createElement('div');
	panel.className = 'callout-icon-picker';
	const search = document.createElement('input');
	search.type = 'text';
	search.placeholder = 'Search Font Awesome icons…';
	search.spellcheck = false;
	search.className = 'callout-icon-search';
	const status = document.createElement('p');
	status.className = 'callout-icon-status';
	status.textContent = 'Loading icons…';
	const grid = document.createElement('div');
	grid.className = 'callout-icon-grid';
	panel.append(search, status, grid);
	const rect = anchor.getBoundingClientRect();
	panel.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 380))}px`;
	panel.style.top = `${Math.min(rect.bottom + 4, innerHeight - 340)}px`;
	document.body.append(panel);
	search.focus();

	const close = () => {
		panel.remove();
		document.removeEventListener('mousedown', outside, true);
	};
	const outside = (e) => { if (!panel.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); };
	document.addEventListener('mousedown', outside, true);
	search.addEventListener('keydown', (e) => {
		e.stopPropagation();
		if (e.key === 'Escape') { e.preventDefault(); close(); anchor.focus(); }
		if (e.key === 'Enter') grid.querySelector('button')?.click();
	});

	try {
		fullTable ??= await ipc.invoke(CH.CALLOUT_ICONS);
	} catch {
		status.textContent = 'The icon table could not be loaded.';
		return;
	}
	const keys = Object.keys(fullTable.icons ?? {});
	const draw = () => {
		const q = search.value.trim().toLowerCase().replace(/\s+/g, '-');
		const hits = q ? keys.filter((k) => k.slice(k.indexOf(':') + 1).includes(q) || k.startsWith(q)) : keys;
		hits.sort((a, b) => {
			const an = a.slice(a.indexOf(':') + 1);
			const bn = b.slice(b.indexOf(':') + 1);
			return (an !== q) - (bn !== q) || (!an.startsWith(q)) - (!bn.startsWith(q)) || an.localeCompare(bn) || a.localeCompare(b);
		});
		grid.replaceChildren();
		for (const key of hits.slice(0, PICKER_LIMIT)) {
			const [family, name] = key.split(':');
			const button = document.createElement('button');
			button.className = 'callout-icon-choice';
			button.title = family === 'solid' ? name : key;
			button.dataset.icon = key;
			button.append(svgOf(fullTable.icons[key]));
			button.addEventListener('click', () => {
				onPick({ stored: family === 'solid' ? name : key, icon: fullTable.icons[key] });
				close();
			});
			grid.append(button);
		}
		status.textContent = hits.length > PICKER_LIMIT
			? `${hits.length.toLocaleString()} icons — showing ${PICKER_LIMIT}; type to narrow (Font Awesome Free ${fullTable.version ?? ''})`
			: `${hits.length.toLocaleString()} icon${hits.length === 1 ? '' : 's'}`;
	};
	search.addEventListener('input', draw);
	draw();
}
