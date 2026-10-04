// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Deep links and the `clew` command, main's half (FEATURE-IDEAS #8; the
// owner's pick, 2026-10-03). What is asked is decided by main/deep-links.js
// (pure, tested); this does it.
//
// How a request arrives:
// - a `clew://` link: macOS hands a running app `open-url` (and a launching
//   one too, before ready — `listenForLinks` is called at load). Windows and
//   Linux start the app with the link on its command line; the
//   single-instance lock (main.js) hands a second launch's command line to
//   the running one (`onSecondInstance`). Packaged builds declare the scheme
//   (electron-builder `protocols` → Info.plist, the registry, the .desktop
//   file); a dev build is NOT registered on macOS — that would make the bare
//   Electron.app the handler — so in dev a link is given on the command
//   line: `electron . 'clew://open?vault=…'`.
// - the `clew` command (src/cli/clew.mjs): a JSON line over a socket in the
//   profile folder — only this user can reach it — answered here
//   (`startCliServer`), the app started first when it is not running.
//
// What may be done (the owner's rule): a link OPENS and NAVIGATES, nothing
// else — it never runs code, changes trust or writes, except `new`, which
// creates an empty note (or today's diary entry) and says so. A link naming
// a vault this device does not know asks first. The command is the user's
// own, typed in their terminal: it opens what it names without asking, and
// its export runs under the vault's trust, as Export in the menu does.
import { app, dialog } from 'electron';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseClewUrl, resolveVaultSpec, vaultForFile, cleanNotePath } from './deep-links.js';
import { settings } from './settings.js';
import { allSessions, focusedSession } from './session.js';
import { exportNote } from './export.js';
import { CH } from '../shared/channels.js';

const smoke = Boolean(process.env.CLEW_SMOKE);
let openVault = null;
let rootDir = null;
const early = [];

const knownVaults = () => [...new Set([
	...(settings.get('openVaults') ?? []),
	...(settings.get('recentVaults') ?? []),
	settings.get('lastVault'),
].filter(Boolean))];

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isVaultDir = (d) => fs.existsSync(path.join(d, '.clew')) || fs.existsSync(path.join(d, '.obsidian'));

/** `clew:` links in a command line. */
export const linksIn = (argv) => (argv ?? []).filter((a) => typeof a === 'string' && /^clew:/i.test(a));

/** At load, before ready: links that arrive while the app launches. */
export function listenForLinks() {
	app.on('open-url', (event, url) => {
		event.preventDefault();
		receive(url);
	});
	early.push(...linksIn(process.argv));
}

/** A second launch's command line (main.js, the single-instance lock). */
export function onSecondInstance(argv) {
	for (const url of linksIn(argv)) receive(url);
}

function receive(url) {
	if (!openVault) { early.push(url); return; }
	handleUrl(url).catch((err) => console.error('[clew] link:', err));
}

/** After ready, with the windows restored. */
export async function startDeepLinks({ openVaultAnywhere, root }) {
	rootDir = root;
	if (app.isPackaged && !smoke) app.setAsDefaultProtocolClient('clew');
	startCliServer();
	// Not before the restored windows have their vaults open: a link to one
	// of them would find it "not open" and open it AGAIN in a new window.
	await Promise.all(allSessions().map((s) => s.opened).filter(Boolean));
	openVault = openVaultAnywhere;
	for (const url of early.splice(0)) receive(url);
}

/** Say something in the focused window (a refusal), or log it. */
function tell(message) {
	const s = focusedSession();
	if (smoke) console.log(`smoke-link-notice: ${message}`);
	if (s?.win && !s.win.isDestroyed()) {
		try { s.win.webContents.send(CH.EV_DEEP_LINK, { notice: message }); } catch { /* mid-teardown */ }
	} else console.warn(`[clew] ${message}`);
	return { ok: false, error: message };
}

async function askToOpen(dir) {
	if (smoke) {
		const answer = process.env.CLEW_SMOKE_LINK_ANSWER ?? 'cancel';
		console.log(`smoke-link-ask: ${dir} → ${answer}`);
		return answer === 'open';
	}
	const { response } = await dialog.showMessageBox({
		type: 'question',
		buttons: ['Open', 'Cancel'],
		defaultId: 1,
		cancelId: 1,
		message: `Open the vault "${path.basename(dir)}"?`,
		detail: `A clew:// link asked to open ${dir}, which Clew has not opened on this device. Opening it shows its notes; it does not trust its code.`,
	});
	return response === 0;
}

/** The vault a request names (`spec`), or the one in front. */
async function vaultFor(spec, { ask }) {
	if (!spec) {
		const root = focusedSession()?.vaults.root ?? settings.get('lastVault');
		return root ? { path: root } : { error: 'no vault was named, and none is open' };
	}
	const r = resolveVaultSpec(spec, knownVaults(), os.homedir());
	if (r.error) return r;
	if (!isDir(r.path)) return { error: `there is no folder at ${r.path}` };
	if (!r.known && ask && !(await askToOpen(r.path))) return { error: `not opened: ${r.path}`, cancelled: true };
	return { path: r.path };
}

/** The session for `vaultPath`, its vault open. */
async function sessionFor(vaultPath) {
	// A command that arrives while the restored windows are still opening.
	for (let i = 0; i < 300 && !openVault; i++) await new Promise((r) => setTimeout(r, 100));
	if (!openVault) throw new Error('Clew is still starting');
	// A window showing the welcome screen (no vault) takes the vault, rather
	// than a new window opening beside it and leaving it behind — a cold
	// start with nothing restored (Clew-docs, 2026-10-04). The focused one if
	// it is empty, else any; with none, openVaultAnywhere's own rules.
	const empty = (x) => x && !x.vaults.root && x.win && !x.win.isDestroyed();
	const focused = focusedSession();
	const spare = empty(focused) ? focused : (allSessions().find(empty) ?? null);
	const s = openVault(vaultPath, { preferSession: spare });
	await s.opened;
	for (let i = 0; i < 100 && s.vaults.root !== path.resolve(vaultPath); i++) await new Promise((r) => setTimeout(r, 100));
	return s;
}

/**
 * Open (and navigate) or create, in `vaultPath`'s window. The window takes
 * what it should show (`pendingLinks`) when it has put its vault on screen
 * (DEEP_LINK_TAKE, renderer/deep-link.js) — once each, in order.
 */
async function perform(vaultPath, { action, note = null, heading = null, line = null, daily = false }) {
	const s = await sessionFor(vaultPath);
	const name = path.basename(s.vaults.root);
	let pending = null;
	let said;
	if (action === 'new') {
		if (daily) {
			pending = { daily: true, notice: `Today's diary entry, opened from a clew link or command.` };
			said = `today's diary entry in ${name}`;
		} else {
			const rel = s.vaults.createNote(note);   // never over a file: "x 1.md" if taken
			pending = { note: rel, notice: `Created ${rel}, from a clew link or command.` };
			said = `created ${rel} in ${name}`;
		}
	} else {
		if (note && !fs.existsSync(path.join(s.vaults.root, note))) return tell(`No note "${note}" in ${name}.`);
		pending = note ? { note, heading, line } : null;
		said = note ? `opened ${note} in ${name}` : `opened ${name}`;
	}
	if (pending) {
		// A queue: links can arrive together (two on one command line).
		(s.pendingLinks ??= []).push(pending);
		try { s.win.webContents.send(CH.EV_DEEP_LINK, {}); } catch { /* the window will take it on load */ }
	}
	if (!smoke && !s.win.isDestroyed()) { s.win.show(); s.win.focus(); }
	if (smoke) console.log(`smoke-link-done: ${said}`);
	return { ok: true, message: said };
}

async function handleUrl(url) {
	const req = parseClewUrl(url);
	if (smoke) console.log(`smoke-link: ${url} → ${req.error ? `refused: ${req.error}` : req.action}`);
	if (req.error) return tell(`A clew link was refused: ${req.error}.`);
	const target = await vaultFor(req.vault, { ask: true });
	if (target.error) return target.cancelled ? { ok: false, error: target.error } : tell(target.error);
	return perform(target.path, req);
}

// ---- the `clew` command -----------------------------------------------------

/** Where the command reaches the app (src/cli/clew.mjs#socketPath). */
function socketPath() {
	if (process.env.CLEW_CLI_SOCKET) return process.env.CLEW_CLI_SOCKET;
	if (process.platform === 'win32') return `\\\\.\\pipe\\clew-cli-${os.userInfo().username}`;
	return path.join(app.getPath('userData'), 'clew-cli.sock');
}

function startCliServer() {
	// A smoke run's profile path is too long for a socket name: a scenario
	// that wants the command names its own socket.
	if (smoke && !process.env.CLEW_CLI_SOCKET) return;
	const sock = socketPath();
	// The single-instance lock means no other Clew of this profile listens.
	if (process.platform !== 'win32') { try { fs.unlinkSync(sock); } catch { /* none */ } }
	const server = net.createServer((conn) => {
		let buf = '';
		conn.on('data', async (chunk) => {
			buf += chunk;
			const nl = buf.indexOf('\n');
			if (nl < 0) return;
			let answer;
			try { answer = await cliRequest(JSON.parse(buf.slice(0, nl))); } catch (err) { answer = { ok: false, error: String(err?.message ?? err) }; }
			conn.end(JSON.stringify(answer) + '\n');
		});
		conn.on('error', () => {});
	});
	server.on('error', (err) => console.warn('[clew] the clew command cannot reach this app:', err.message));
	server.listen(sock, () => {
		if (process.platform !== 'win32') { try { fs.chmodSync(sock, 0o600); } catch { /* best effort */ } }
		if (smoke) console.log('smoke-cli: listening');
	});
	app.on('will-quit', () => {
		server.close();
		if (process.platform !== 'win32') { try { fs.unlinkSync(sock); } catch { /* gone */ } }
	});
}

/** A file or folder named on the command line: its vault and note. */
function locate(cwd, given) {
	const abs = path.resolve(cwd, String(given ?? ''));
	if (!fs.existsSync(abs)) return { error: `no such file or folder: ${abs}` };
	if (isDir(abs)) return { vault: abs, note: null, abs };
	const vault = vaultForFile(abs, { isVault: isVaultDir, knownPaths: knownVaults() });
	return { vault, note: path.relative(vault, abs).split(path.sep).join('/'), abs };
}

/**
 * Where `clew export` writes: beside the note by default; `--out` names a
 * file, or a folder (one that exists, or written with a trailing slash) to
 * put `<note>.<ext>` in — relative to the command's own working folder, a
 * leading `~` meaning home.
 */
function exportTarget(cwd, noteAbs, format, out) {
	const name = path.basename(noteAbs).replace(/\.(md|jmd)$/i, '') + (format === 'latex' ? '.tex' : `.${format}`);
	if (!out) return path.join(path.dirname(noteAbs), name);
	const given = String(out).replace(/^~(?=$|[\\/])/, os.homedir());
	const abs = path.resolve(cwd, given);
	return isDir(abs) || /[\\/]$/.test(given) ? path.join(abs, name) : abs;
}

async function cliRequest(req) {
	const cwd = typeof req?.cwd === 'string' ? req.cwd : os.homedir();
	if (smoke) console.log(`smoke-cli: ${req?.cmd}`);
	if (req?.cmd === 'open') {
		const at = locate(cwd, req.path);
		if (at.error) return { ok: false, error: at.error };
		return perform(at.vault, { action: 'open', note: at.note });
	}
	if (req?.cmd === 'new') {
		const target = await vaultFor(req.vault, { ask: false });
		if (target.error) return { ok: false, error: target.error };
		if (req.daily) return perform(target.path, { action: 'new', daily: true });
		const note = cleanNotePath(req.note);
		if (!note) return { ok: false, error: 'that note path is empty or climbs out of the vault' };
		return perform(target.path, { action: 'new', note });
	}
	if (req?.cmd === 'export') {
		const at = locate(cwd, req.path);
		if (at.error) return { ok: false, error: at.error };
		if (!at.note || !/\.(md|jmd)$/i.test(at.note)) return { ok: false, error: 'export a note (.md)' };
		const format = ['latex', 'pdf', 'html'].includes(req.format) ? req.format : null;
		if (!format) return { ok: false, error: 'export as latex, pdf or html' };
		const s = await sessionFor(at.vault);
		const outFile = exportTarget(cwd, at.abs, format, req.out);
		// Under the vault's trust, as Export in the menu (export.js) — but a
		// PDF is built apart, so only the PDF is left where it goes.
		const result = await exportNote({
			win: s.win, vaults: s.vaults, sessionId: s.id, callerToken: s.callerToken,
			relPath: at.note, format, outFile, trusted: s.trusted, buildApart: true,
		});
		// Into the vault, it shows in the explorer at once (as the menu's).
		if (result?.output) s.vaults.refreshIfInside(result.output);
		const warnings = result?.warnings?.length ? ` (${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'})` : '';
		return { ok: true, message: `exported ${result?.output ?? outFile}${warnings}` };
	}
	return { ok: false, error: `unknown command "${req?.cmd}"` };
}

// ---- installing the command -------------------------------------------------

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Help → Install the clew Command: a shell shim that runs Clew's own binary
 * as Node over the bundled client (Resources/cli/clew.mjs; dist/cli in dev),
 * in /usr/local/bin when this user may write there, else ~/.local/bin.
 * Never asks for an administrator's password.
 */
export async function installCliCommand(win = null) {
	if (process.platform === 'win32') {
		await dialog.showMessageBox(win ?? undefined, { type: 'info', message: 'The clew command is for macOS and Linux.' });
		return null;
	}
	const node = process.execPath;
	const cli = app.isPackaged ? path.join(process.resourcesPath, 'cli', 'clew.mjs') : path.join(rootDir ?? '', 'dist', 'cli', 'clew.mjs');
	const launch = app.isPackaged
		? (process.platform === 'darwin' ? `open -a ${shq(path.resolve(node, '..', '..', '..'))}` : `${shq(node)} >/dev/null 2>&1 &`)
		: `${shq(node)} ${shq(rootDir ?? '.')} >/dev/null 2>&1 &`;
	const shim = [
		'#!/bin/sh',
		'# clew — Clew\'s command line, written by Clew (Help → Install the clew Command).',
		'# Runs Clew\'s own binary as Node over its bundled client; see `clew` for usage.',
		`CLEW_CLI_LAUNCH=${shq(launch)} ELECTRON_RUN_AS_NODE=1 exec ${shq(node)} ${shq(cli)} "$@"`,
		'',
	].join('\n');
	const dirs = process.env.CLEW_SMOKE_CLI_DIR ? [process.env.CLEW_SMOKE_CLI_DIR] : ['/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
	let target = null;
	for (const dir of dirs) {
		try {
			fs.mkdirSync(dir, { recursive: true });
			fs.accessSync(dir, fs.constants.W_OK);
			target = path.join(dir, 'clew');
			fs.writeFileSync(target, shim, { mode: 0o755 });
			fs.chmodSync(target, 0o755);
			break;
		} catch { target = null; }
	}
	if (smoke) { console.log(`smoke-cli-installed: ${target}`); return target; }
	const onPath = target && (process.env.PATH ?? '').split(':').includes(path.dirname(target));
	await dialog.showMessageBox(win ?? undefined, target ? {
		type: 'info',
		message: `Installed the clew command at ${target}.`,
		detail: `Try: clew open <a note or a vault folder>, clew new --daily, clew export --pdf <note>.${onPath ? '' : `\n\nIf your shell does not find it, add ${path.dirname(target)} to your PATH.`}`,
	} : { type: 'warning', message: 'Could not install the clew command.', detail: `Neither ${dirs.join(' nor ')} could be written.` });
	return target;
}
