// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The command registry: one source of truth for the palette, the hotkey
// dispatcher, and (later) the settings hotkey editor.
//
//   registerCommand({ id, name, hotkeys: ['Mod-e'], when(ctx), run(ctx, args) })
//
// Chords use CodeMirror's notation (Mod-Shift-p) so one syntax appears
// everywhere. `when` is a plain predicate over the ui context (optional).
import { workspaceStore } from '../state/workspace-store.js';
import { vaultStore } from '../state/vault-store.js';
import { uiStore } from '../state/ui-store.js';
import { settingsStore } from '../state/settings-store.js';

const commands = new Map();

export function registerCommand(command) {
	commands.set(command.id, command);
}

export function unregisterCommand(id) {
	commands.delete(id);
}

export function allCommands() {
	return [...commands.values()];
}

export function buildContext() {
	const tab = workspaceStore.activeTab();
	return {
		vaultOpen: vaultStore.vault !== null,
		activeTab: tab,
		activeTabKind: tab?.kind ?? null,
		notePath: tab?.kind === 'note' ? tab.path : null,
		editorFocused: uiStore.editorFocused,
		modalOpen: document.querySelector('.clew-modal') !== null,
	};
}

export function isEnabled(command, ctx = buildContext()) {
	return command.when ? !!command.when(ctx) : true;
}

export function runCommand(id, args) {
	const command = commands.get(id);
	if (!command) return false;
	const ctx = buildContext();
	if (!isEnabled(command, ctx)) return false;
	command.run(ctx, args);
	return true;
}

// ---- hotkeys ---------------------------------------------------------------

const isMac = navigator.platform.startsWith('Mac');

/**
 * Normalize a KeyboardEvent to a CM-style chord string, or null. 'Mod' is
 * the platform command key (⌘ on mac, Ctrl elsewhere). On mac, Ctrl is its
 * OWN modifier ('Ctrl-') — collapsing it into Mod would shadow the system's
 * emacs-style text bindings (Ctrl-E end-of-line, Ctrl-A, …), which
 * CodeMirror handles when the chord falls through unclaimed.
 */
export function chordOf(event) {
	const parts = [];
	if (isMac) {
		if (event.metaKey) parts.push('Mod');
		if (event.ctrlKey) parts.push('Ctrl');
	} else {
		if (event.ctrlKey) parts.push('Mod');
		if (event.metaKey) parts.push('Meta');
	}
	if (event.altKey) parts.push('Alt');
	if (event.shiftKey) parts.push('Shift');
	let key = event.key;
	// On mac, Option transforms the typed character (Alt-q is œ), which
	// would make every bare Alt chord unmatchable — recover the base key
	// from the physical code. QWERTY-positional for letters and digits,
	// the trade every editor makes here, and only for chords actually
	// bound: an unbound Option combination still types its character.
	if (isMac && event.altKey) {
		const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code);
		if (m) key = m[1] ?? m[2];
	}
	if (key === ' ') key = 'Space';
	if (key.length === 1) key = key.toLowerCase();
	if (['Meta', 'Control', 'Alt', 'Shift'].includes(key)) return null;
	parts.push(key);
	return parts.join('-');
}

/** A registered chord, adjusted for this platform: away from mac, Ctrl IS
 *  the Mod key, so 'Ctrl-Tab' (mac tab cycling) becomes 'Mod-Tab'. */
export function normalizeChord(chord) {
	if (isMac) return chord;
	return chord.replace(/^(?:Mod-)?Ctrl-/, 'Mod-');
}

/** Effective chord → command-id map (defaults merged with user overrides). */
export function effectiveKeymap() {
	const map = new Map();
	for (const command of commands.values()) {
		for (const chord of command.hotkeys ?? []) map.set(normalizeChord(chord), command.id);
	}
	for (const [id, chords] of Object.entries(settingsStore.get('hotkeys') ?? {})) {
		for (const [chord, mapped] of map) {
			if (mapped === id) map.delete(chord);
		}
		for (const chord of chords) map.set(normalizeChord(chord), id);
	}
	return map;
}

/** Every effective chord — what a forwarding surface (the preview iframe)
 *  needs to know which keydowns belong to the app. Already normalized, so
 *  membership tests against chordOf() output are exact. */
export function effectiveChords() {
	return [...effectiveKeymap().keys()];
}

/** Dispatch one chord exactly as the window keydown dispatcher would —
 *  same context gates, same enablement. Returns whether a command ran. */
export function runChord(chord) {
	const id = effectiveKeymap().get(normalizeChord(chord));
	if (!id) return false;
	const command = commands.get(id);
	const ctx = buildContext();
	if (ctx.modalOpen && !command.inModal) return false;
	if (!isEnabled(command, ctx)) return false;
	command.run(ctx);
	return true;
}

// A shortcut being RECORDED (Settings → Hotkeys) gets every key, and the
// dispatcher stands aside. The recorder's own capture listener came after
// this one, so a chord the app already binds ran its command first: with
// ⌘1–⌘9 switching tabs, recording ⌘1 left the Settings tab and recorded
// nothing (measured 2026-10-01, smoke/hotkey-record-scenario.js).
let recorder = null;

/** Send every keydown to `handler` until the returned function is called. */
export function recordKeys(handler) {
	recorder = handler;
	return () => { if (recorder === handler) recorder = null; };
}

/** Install the global dispatcher (capture phase; CM keymaps see the rest). */
export function installHotkeys() {
	window.addEventListener('keydown', (event) => {
		if (recorder) {
			recorder(event);
			return;
		}
		const chord = chordOf(event);
		if (!chord || !chord.includes('-')) return;
		const id = effectiveKeymap().get(chord);
		if (!id) return;
		const command = commands.get(id);
		const ctx = buildContext();
		if (ctx.modalOpen && !command.inModal) return;
		if (!isEnabled(command, ctx)) return;
		event.preventDefault();
		event.stopPropagation();
		command.run(ctx);
	}, { capture: true });
}
