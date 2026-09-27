// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// <clew-shell-panel>: the terminal pinned under the workspace. One real
// shell per window, started at the vault root by main/shell-core.js; this
// is the grid it draws into and the keyboard that feeds it.
//
// The session outlives the panel being hidden — closing the panel is not
// closing the shell, because the reason to have one is often a build that
// keeps running while you go back to writing. It is reaped when the window
// is (session.js#dispose).
//
// xterm.js owns its own keyboard, selection and scrollback; what this file
// owns is the wiring: keystrokes out over IPC, bytes in from the session,
// geometry kept in step with the panel's size, and the theme taken from
// Clew's own CSS variables so the terminal is not a foreign object on a
// light page.
import { ClewElement } from '../base/clew-element.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ipc, CH } from '../../ipc.js';
import { vaultStore } from '../../state/vault-store.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { settingsStore } from '../../state/settings-store.js';

const escapeHtml = (value) => String(value)
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A CSS custom property as an actual colour, for xterm's flat theme object. */
function cssVar(name, fallback) {
	const value = getComputedStyle(document.body).getPropertyValue(name).trim();
	return value || fallback;
}

/** xterm's theme, in Clew's colours — read at build and on a theme change. */
function terminalTheme() {
	return {
		background: cssVar('--clew-bg-primary', '#1e1e1e'),
		foreground: cssVar('--clew-text-normal', '#dadada'),
		cursor: cssVar('--clew-accent', '#8b7ec8'),
		cursorAccent: cssVar('--clew-bg-primary', '#1e1e1e'),
		selectionBackground: cssVar('--clew-selection', 'rgba(139,126,200,0.35)'),
	};
}

class ClewShellPanel extends ClewElement {
	#term = null;
	#fit = null;
	#offData = null;
	#offExit = null;
	#resizeObserver = null;
	#opened = false;

	subscribe() {
		this.listen(workspaceStore, 'shell-changed', () => this.#applyVisibility());
		// A new vault means a new window's worth of context; the shell for
		// this window keeps running, but its geometry may have changed while
		// the panel was hidden.
		this.listen(vaultStore, 'vault-changed', () => this.#fitSoon());
		this.listen(settingsStore, 'settings-changed', () => {
			// The theme is a setting; the grid's colours follow it.
			if (this.#term) this.#term.options.theme = terminalTheme();
		});
	}

	render() {
		this.innerHTML = `
			<div class="shell-header">
				<span class="shell-title">Shell</span>
				<span class="shell-cwd">${escapeHtml(vaultStore.vault?.name ?? '')}</span>
				<button class="icon-button shell-close" title="Hide shell (⌃\`)">✕</button>
			</div>
			<div class="shell-grid"></div>
		`;
		this.querySelector('.shell-close').addEventListener('click', () => workspaceStore.setShell({ open: false }));
		this.#applyVisibility();
	}

	cleanup() {
		this.#teardownTerminal();
	}

	#applyVisibility() {
		const open = workspaceStore.shell.open;
		this.classList.toggle('is-open', open);
		if (open) this.#ensureTerminal();
		// Hidden, not closed: the grid and the session both stay.
		if (open) this.#fitSoon();
	}

	/** Build the grid and open the session, once per panel lifetime. */
	#ensureTerminal() {
		if (this.#term) return;
		const host = this.querySelector('.shell-grid');
		if (!host) return;
		this.#term = new Terminal({
			// MONOSPACE, and not the editor's face. xterm draws a grid: it
			// measures one cell from the font and then places every character
			// in its own cell, so a proportional family (Clew's editor font is
			// Avenir Next) leaves a visible gap around each letter — the
			// owner's report, 2026-09-25. `monospace` is appended as a last
			// resort in case a theme ever overrides the token with something
			// that is not.
			fontFamily: `${cssVar('--clew-mono-font', "'SF Mono', Menlo")}, monospace`,
			fontSize: 12.5,
			cursorBlink: true,
			// The scrollback a build's output wants, without being a memory leak.
			scrollback: 5000,
			theme: terminalTheme(),
			allowProposedApi: false,
		});
		this.#fit = new FitAddon();
		this.#term.loadAddon(this.#fit);
		this.#term.open(host);
		// The dev hook (renderer/main.js) is how the smoke harness reaches the
		// stores; the terminal goes there too, because everything worth
		// asserting about a grid — its geometry, its buffer — is inside xterm
		// rather than in the DOM it draws.
		if (window.__clew) window.__clew.shellTerminal = this.#term;

		// Keystrokes out. xterm hands us exactly the bytes a terminal would.
		this.#term.onData((data) => ipc.invoke(CH.SHELL_WRITE, { data }).catch(() => {}));
		// Bytes in.
		this.#offData = ipc.on(CH.EV_SHELL_DATA, ({ data }) => this.#term?.write(data));
		this.#offExit = ipc.on(CH.EV_SHELL_EXIT, ({ code, signal }) => {
			this.#term?.write(`\r\n\x1b[2m[shell exited${signal ? ` on ${signal}` : code === null ? '' : ` (${code})`}]`
				+ ' — reopen the panel to start another\x1b[0m\r\n');
			this.#opened = false;
		});

		this.#resizeObserver = new ResizeObserver(() => this.#fitSoon());
		this.#resizeObserver.observe(this);
		this.#openSession();
	}

	async #openSession() {
		if (this.#opened) return;
		this.#opened = true;
		const result = await ipc.invoke(CH.SHELL_OPEN, {}).catch((err) => ({ ok: false, error: err.message }));
		if (!result?.ok) {
			this.#term?.write(`\r\n\x1b[31m[clew] ${result?.error ?? 'could not open a shell'}\x1b[0m\r\n`);
			this.#opened = false;
			return;
		}
		// The session survives this panel being rebuilt, but the scrollback
		// does not — xterm's buffer went with the grid. Say so rather than
		// show what looks like a dead terminal; the resize that follows
		// raises SIGWINCH, and most shells redraw their prompt on it.
		if (result.running) {
			this.#term?.write('\x1b[2m[clew] reattached to the shell already running in this window\x1b[0m\r\n');
		}
		// Without a pty there is no prompt and no colour — say so once rather
		// than leave the reader wondering why their shell looks dead.
		if (window.__clew) window.__clew.shellPty = result.pty !== false;
		if (result.pty === false) {
			this.#term?.write('\x1b[2m[clew] no python3 for a pty: running a plain pipe shell '
				+ '(no prompt, no colour)\x1b[0m\r\n');
		}
		this.#fitSoon();
	}

	/** Fit after layout has settled, and tell the pty its new size. */
	#fitSoon() {
		if (!this.#term || !this.#fit || !workspaceStore.shell.open) return;
		requestAnimationFrame(() => {
			try { this.#fit.fit(); } catch { /* not laid out yet */ }
			const { cols, rows } = this.#term;
			if (cols > 0 && rows > 0) ipc.invoke(CH.SHELL_RESIZE, { cols, rows }).catch(() => {});
		});
	}

	/** Focus the grid — what the toggle command does when it opens the panel. */
	focusTerminal() {
		this.#ensureTerminal();
		this.#term?.focus();
	}

	#teardownTerminal() {
		this.#offData?.();
		this.#offExit?.();
		this.#offData = this.#offExit = null;
		this.#resizeObserver?.disconnect();
		this.#resizeObserver = null;
		this.#term?.dispose();
		this.#term = null;
		if (window.__clew?.shellTerminal) window.__clew.shellTerminal = null;
		this.#fit = null;
	}
}

customElements.define('clew-shell-panel', ClewShellPanel);
