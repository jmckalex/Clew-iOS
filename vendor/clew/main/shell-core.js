// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * @file One real shell per window, run under a real pty.
 *
 * The mechanism is the owner's own, lifted from Godot/jmacs
 * (`apps/desktop/src/shell.js`) at their request, because it solves the
 * hard part in a way worth keeping: **a pty with no native addon**.
 *
 * `node-pty` would mean a compiled module rebuilt for every Electron
 * version, on every platform Clew ships to. Instead the child is
 * `python3 -c <script>`, and the script calls stdlib `pty.fork()`, execs
 * the user's `$SHELL -i` in the slave (a LOGIN shell on macOS — see
 * loginShell), and runs a select loop proxying
 * between the pty master and its own stdio — which is wired to us. macOS
 * ships python3; so does every Linux distribution; the `pty` module is
 * stdlib. Nothing to build, nothing to rebuild.
 *
 * Two details in the script are load-bearing, and both were learned the
 * hard way upstream:
 *
 *   - It resets SIGTERM to SIG_DFL. A child spawned by Electron can
 *     INHERIT an ignored disposition across exec, which makes
 *     `child.kill()` a silent no-op — the helper then sits in select()
 *     for ever and the pty, with its shell, leaks.
 *   - Resizing goes through a sidechannel on fd 3, not through the pty:
 *     lines of `<cols>:<rows>\n` trigger `TIOCSWINSZ` on the master, the
 *     kernel raises SIGWINCH, and prompts and full-screen programs
 *     reflow. Without it a resized panel shows a shell that still
 *     believes in its first geometry.
 *
 * Where python3 is missing (or on Windows, where the model does not
 * apply) the session falls back to plain pipes: a shell without a
 * controlling terminal, so no prompt and no colour, but commands still
 * run. The session says which backing it got so the panel can too.
 *
 * Electron-free on purpose — `registerShellIpc` in ipc.js does the
 * wiring, and these parts are unit-tested under plain node.
 */
import { spawn, spawnSync } from 'node:child_process';

/**
 * The helper. Kept to one statement per line so it survives being passed
 * as a single `-c` argument.
 */
export const PYTHON_PTY_SCRIPT =
	'import sys, os, pty, struct, fcntl, termios, select, signal\n'
	// Electron may hand us an ignored SIGTERM; a kill must actually reap us.
	+ 'signal.signal(signal.SIGTERM, signal.SIG_DFL)\n'
	+ 'sh = sys.argv[1]\n'
	// argv[0] for the shell: `-zsh` makes it a login shell (shellArgv0).
	+ 'argv0 = sys.argv[2] if len(sys.argv) > 2 else sh\n'
	+ "args = [argv0, '-i']\n"
	+ 'pid, fd = pty.fork()\n'
	+ 'if pid == 0:\n'
	+ '  os.execvp(sh, args)\n'
	// Parent: proxy stdin (0) ↔ pty master (fd), plus the resize channel (3).
	+ "rbuf = b''\n"
	+ 'while True:\n'
	+ '  try: r, _, _ = select.select([0, fd, 3], [], [])\n'
	+ '  except (OSError, KeyboardInterrupt): break\n'
	+ '  if 0 in r:\n'
	+ '    d = os.read(0, 4096)\n'
	+ '    if not d: break\n'
	+ '    os.write(fd, d)\n'
	+ '  if fd in r:\n'
	+ '    try: d = os.read(fd, 4096)\n'
	+ '    except OSError: break\n'
	+ '    if not d: break\n'
	+ '    os.write(1, d)\n'
	+ '  if 3 in r:\n'
	+ '    try: d = os.read(3, 4096)\n'
	+ "    except OSError: d = b''\n"
	+ '    if d:\n'
	+ '      rbuf += d\n'
	+ "      while b'\\n' in rbuf:\n"
	+ "        line, rbuf = rbuf.split(b'\\n', 1)\n"
	+ "        s = line.decode('ascii', 'ignore').strip()\n"
	+ "        if ':' in s:\n"
	+ "          c, _, rr = s.partition(':')\n"
	+ '          try:\n'
	+ '            cols = int(c); rows = int(rr)\n'
	+ '            if cols > 0 and rows > 0:\n'
	+ "              fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))\n"
	+ '          except ValueError: pass\n';

/** The user's shell, as their login shell says; a sane default otherwise. */
export function userShell(env = process.env, platform = process.platform) {
	if (platform === 'win32') return env.COMSPEC || 'cmd.exe';
	return env.SHELL || '/bin/sh';
}

/**
 * Does the shell start as a LOGIN shell? On macOS, yes — as Terminal, iTerm
 * and VS Code start theirs. An app opened from the Dock inherits launchd's
 * bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), and what extends it —
 * path_helper in /etc/zprofile, `brew shellenv` in ~/.zprofile — runs only
 * in a login shell; a plain `-i` shell read ~/.zshrc, so its aliases named
 * commands it could not find (the owner's `ls` → `gls`, 2026-09-29).
 * Elsewhere, no: a Linux desktop session has already exported the
 * profile's PATH to the app, and a login bash reads ~/.bash_profile, which
 * does not always source ~/.bashrc.
 */
export function loginShell(platform = process.platform) {
	return platform === 'darwin';
}

/**
 * argv[0] for the shell. A leading `-` is how login(1) marks a login shell,
 * and every shell honours it — csh and tcsh included, which accept `-l`
 * only as their sole argument.
 */
export function shellArgv0(shell, login) {
	return login ? '-' + shell.split('/').pop() : shell;
}

/** `<cols>:<rows>\n` — the one line the resize sidechannel understands. */
export function resizeLine(cols, rows) {
	const c = Math.max(1, Math.floor(Number(cols) || 0));
	const r = Math.max(1, Math.floor(Number(rows) || 0));
	return `${c}:${r}\n`;
}

let pythonChecked = null;

/**
 * Is there a python3 with a working `pty`? Probed once — python does not
 * come and go while the app runs, and a probe per spawn would be silly.
 */
export function hasPythonPty({ platform = process.platform, run = spawnSync } = {}) {
	if (platform === 'win32') return false;
	if (pythonChecked !== null) return pythonChecked;
	try {
		const probe = run('python3', ['-c', 'import pty, fcntl, termios, select'], { stdio: 'ignore' });
		pythonChecked = probe.status === 0;
	} catch {
		pythonChecked = false;
	}
	return pythonChecked;
}

/** Tests only: forget the probe. */
export function resetPythonProbe() { pythonChecked = null; }

/**
 * One shell session per key (Clew uses the window's session id, so a shell
 * belongs to a window and dies with it). Output is handed to `onData`, and
 * the child's end to `onExit`.
 */
export class ShellSessions {
	#sessions = new Map();

	/**
	 * @param {string} key
	 * @param {object} options
	 * @param {string} options.cwd where the shell starts — the vault root
	 * @param {(data: string) => void} options.onData
	 * @param {(info: { code: number|null, signal: string|null }) => void} options.onExit
	 * @param {typeof spawn} [options.spawnFn] tests
	 * @param {boolean} [options.login] start a login shell (loginShell)
	 * @returns {{ pty: boolean, shell: string }}
	 */
	open(key, { cwd, onData, onExit, spawnFn = spawn, pty = hasPythonPty(), login = loginShell() }) {
		this.close(key);
		const shell = userShell();
		const argv0 = shellArgv0(shell, login);
		const child = pty
			? spawnFn('python3', ['-c', PYTHON_PTY_SCRIPT, shell, argv0], {
				cwd,
				// fd 3 is the resize sidechannel the helper reads.
				stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
				env: { ...process.env, TERM: 'xterm-256color' },
			})
			: spawnFn(shell, ['-i'], { cwd, argv0, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });

		const record = { child, pty, shell, onData, onExit };
		this.#sessions.set(key, record);
		child.stdout?.on('data', (chunk) => onData(chunk.toString('utf8')));
		// Without a pty the shell's own diagnostics arrive on stderr; with one
		// they are already in the stream, and stderr carries the helper's own
		// complaints, which the reader still wants to see.
		child.stderr?.on('data', (chunk) => onData(chunk.toString('utf8')));
		child.on('exit', (code, signal) => {
			if (this.#sessions.get(key) === record) this.#sessions.delete(key);
			onExit({ code, signal });
		});
		child.on('error', (err) => onData(`\r\n[clew] could not start a shell: ${err.message}\r\n`));
		return { pty, shell };
	}

	/** Keystrokes from the terminal grid. */
	write(key, data) {
		const record = this.#sessions.get(key);
		if (!record) return false;
		try { record.child.stdin?.write(data); return true; } catch { return false; }
	}

	/** Tell the pty its new geometry, so the shell reflows (SIGWINCH). */
	resize(key, cols, rows) {
		const record = this.#sessions.get(key);
		if (!record?.pty) return false;
		const channel = record.child.stdio?.[3];
		if (!channel?.writable) return false;
		try { channel.write(resizeLine(cols, rows)); return true; } catch { return false; }
	}

	close(key) {
		const record = this.#sessions.get(key);
		if (!record) return false;
		this.#sessions.delete(key);
		try { record.child.kill('SIGTERM'); } catch { /* already gone */ }
		return true;
	}

	closeAll() {
		for (const key of [...this.#sessions.keys()]) this.close(key);
	}

	has(key) { return this.#sessions.has(key); }

	/** Tests and diagnostics. */
	get size() { return this.#sessions.size; }
}
