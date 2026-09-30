// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Clew — Electron main process entry point. Multi-window: every window is
// one vault with its own VaultSession (services + watchers + render
// workers); windows/vaults open and close independently. Opening a vault
// focuses the window that already shows it, fills the current window if it
// is vaultless (the welcome screen), and otherwise makes a new window.
import { app, BrowserWindow, clipboard, dialog, Menu, session as electronSession, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpc } from './ipc.js';
import { appMenu } from './menu.js';
import { settings } from './settings.js';
import { trust } from './trust.js';
import { CH } from '../shared/channels.js';
import { registerPreviewScheme, installPreviewProtocol } from './protocol.js';
import { VaultSession, focusedSession, sessionForVault } from './session.js';
import { paths } from './paths.js';
import { prepareNoteFonts } from './note-fonts.js';
import { assetStamp, stampChanged } from './asset-stamp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.dirname(__dirname); // dist/
const rootDir = path.dirname(distDir);

registerPreviewScheme();

// SharedArrayBuffer for the ZetaOffice (LibreOffice wasm) viewer, which is
// a pthreads build. True cross-origin isolation (COOP/COEP) is off the
// table by architecture: the app page is file:// and previews are
// DELIBERATELY cross-origin clew-preview://, so the top-level document can
// never satisfy COEP for its frames. This switch enables SAB without COI —
// a conscious relaxation. The exposure is bounded: arbitrary web content
// runs only in canvas-web-node <webview> guests (separate processes), and
// SAB matters for cross-origin data mainly as a Spectre timer amplifier.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

let quitting = false;
const windowOrder = []; // creation order, for the smoke hook

// Smoke runs stay out of the way of whoever is at the machine (owner's ask,
// 2026-09-29): no window is shown, none takes focus, no Dock icon appears.
// The page still lays out, paints and animates (background throttling is
// off), capturePage still works, and the smoke hook turns on CDP focus
// emulation so the page answers document.hasFocus() as a focused one would
// — CodeMirror's hasFocus reads it, and the preview pane and the selection
// bubble gate on that. CLEW_SMOKE_VISIBLE=1 puts the window on screen again,
// to watch a run.
const smokeHidden = Boolean(process.env.CLEW_SMOKE) && !process.env.CLEW_SMOKE_VISIBLE;
if (smokeHidden) app.dock?.hide();

export function createWindow(vaultPath = null) {
	const win = new BrowserWindow({
		width: 1280,
		height: 850,
		minWidth: 640,
		minHeight: 400,
		titleBarStyle: 'hiddenInset',
		backgroundColor: '#1e1e1e',
		show: !smokeHidden,
		webPreferences: {
			preload: path.join(distDir, 'preload', 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			backgroundThrottling: !smokeHidden,
			// Chromium's built-in PDF viewer. Clew's own PDF surfaces are all
			// EmbedPDF now, canvas scenes included; what still reaches the
			// plugin is a raw PDF iframe — a portal's miniature, and any
			// `<iframe src="x.pdf">` a note writes itself — so it stays.
			plugins: true,
			webviewTag: true, // canvas web-page nodes
		},
	});
	const session = new VaultSession(win, distDir);
	windowOrder.push(win);

	win.loadFile(path.join(distDir, 'renderer', 'index.html'));

	// External links open in the browser, never inside the app window. This
	// also catches target=_blank clicks inside canvas-embed web iframes
	// (their sandbox has allow-popups so the request lands here) — http(s)
	// only, matching the webview guard below.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/i.test(url)) shell.openExternal(url);
		return { action: 'deny' };
	});

	// Defense in depth for the unsandboxed preview frames: nothing may
	// navigate the app's main frame away from the bundled index.html.
	win.webContents.on('will-navigate', (event) => event.preventDefault());

	// A dirty office tab (LibreOffice edits are NOT auto-saved) must get its
	// Save / Discard / Cancel moment before the window goes. The renderer is
	// asked on every close and answers immediately when nothing blocks; the
	// timer fails OPEN because a renderer too wedged to answer is too wedged
	// to save anything either.
	let closeApproved = false;
	let closePending = false;
	session.resolveClose = null;
	win.on('close', (e) => {
		if (closeApproved) return;
		e.preventDefault();
		if (closePending) return; // the question is already on screen
		closePending = true;
		const finish = (proceed) => {
			if (!closePending) return;
			closePending = false;
			session.resolveClose = null;
			if (proceed) {
				closeApproved = true;
				// Deferred: the resolution arrives over IPC from this very
				// window, and destroying the sender synchronously inside its
				// own handle() callback deadlocks the main process.
				setImmediate(() => win.close());
			} else {
				// A cancelled close aborts any quit in flight; without this the
				// stale flag would misfile later hand-closed windows as a quit.
				quitting = false;
			}
		};
		const timer = setTimeout(() => finish(true), 3000);
		session.resolveClose = (proceed) => {
			clearTimeout(timer);
			// 'pending' = the renderer took the question and put a dialog up;
			// stop the fail-open timer and wait for the person to answer it.
			if (proceed !== 'pending') finish(proceed);
		};
		win.webContents.send(CH.EV_CLOSE_REQUESTED);
	});

	win.on('closed', () => {
		windowOrder.splice(windowOrder.indexOf(win), 1);
		// A window closed by hand takes its vault out of the restore set; a
		// quit keeps the whole set for next launch.
		if (!quitting && session.vaults.root) settings.removeOpenVault(session.vaults.root);
		session.dispose();
		if (!quitting) appMenu.rebuild();
	});

	if (process.env.CLEW_DEV) {
		// Surface renderer console output in the dev terminal.
		win.webContents.on('console-message', (details) => {
			const { level, message, lineNumber, sourceId } = details;
			if (level === 'error' || level === 'warning') {
				console.log(`[renderer:${level}] ${message} (${sourceId}:${lineNumber})`);
			}
		});
	}

	if (vaultPath) {
		// The vault opens once the renderer is ready; callers that need the
		// opened vault's info await this.
		session.opened = new Promise((resolve) => {
			win.webContents.once('did-finish-load', () => {
				try {
					session.vaults.open(vaultPath);
				} catch (err) {
					console.error('Failed to open vault:', err);
				}
				resolve();
			});
		});
	}
	return session;
}

/**
 * Open a vault wherever it belongs: focus the window that already shows
 * it, fill `preferSession`'s window when it has no vault, else new window.
 */
export function openVaultAnywhere(vaultPath, { preferSession = null } = {}) {
	const abs = path.resolve(vaultPath);
	const existing = sessionForVault(abs);
	if (existing) {
		if (!smokeHidden) {
			existing.win.show();
			existing.win.focus();
		}
		return existing;
	}
	settings.addOpenVault(abs);
	if (preferSession && !preferSession.vaults.root && preferSession.win) {
		preferSession.vaults.open(abs);
		if (!smokeHidden) preferSession.win.focus();
		return preferSession;
	}
	return createWindow(abs);
}

export async function openVaultDialog(fromSession = null) {
	const result = await dialog.showOpenDialog(fromSession?.win ?? undefined, {
		title: 'Open vault folder',
		buttonLabel: 'Open Vault',
		properties: ['openDirectory', 'createDirectory'],
	});
	if (result.canceled || result.filePaths.length === 0) return null;
	return openVaultAnywhere(result.filePaths[0], { preferSession: fromSession }).vaults.info;
}

/** Create-a-vault: pick a name and place, mkdir, open. The welcome
 *  screen's answer for someone who has no folder of notes yet. */
export async function createVaultDialog(fromSession = null) {
	const result = await dialog.showSaveDialog(fromSession?.win ?? undefined, {
		title: 'Create a new vault',
		buttonLabel: 'Create Vault',
		nameFieldLabel: 'Vault name',
		defaultPath: path.join(app.getPath('documents'), 'My Vault'),
		properties: ['createDirectory', 'showOverwriteConfirmation'],
	});
	if (result.canceled || !result.filePath) return null;
	fs.mkdirSync(result.filePath, { recursive: true });
	// Made here, by its owner, empty: nothing in it came from anyone else.
	trust.trust(result.filePath, 'created');
	return openVaultAnywhere(result.filePath, { preferSession: fromSession }).vaults.info;
}

/**
 * The demo vault — the de-facto tutorial. In dev it opens the repo's
 * demo-vault in place (that copy IS the documentation working corpus).
 * Installed, the bundle's copy is read-only app payload and a vault must
 * be writable, so the user gets their own copy in Documents — created on
 * first use, reopened (never overwritten) after that, so their edits and
 * experiments survive.
 */
export function openDemoVault(fromSession = null) {
	let target = paths.demoVault;
	let fresh = false;
	if (app.isPackaged) {
		target = path.join(app.getPath('documents'), 'Clew Demo Vault');
		if (!fs.existsSync(target)) {
			fs.cpSync(paths.demoVault, target, { recursive: true });
			fresh = true;
		}
	}
	if (!fs.existsSync(target)) return null;
	// Clew's own vault (§4.8) is trusted by construction: a copy made just
	// now from the bundle, or one this device has never decided about. A
	// decision already recorded — a revoke — stands.
	if (fresh || !trust.entries()[fs.realpathSync(target)]) trust.trust(target, 'demo');
	return openVaultAnywhere(target, { preferSession: fromSession }).vaults.info;
}

// Dev mode: reload every window whenever esbuild rewrites the renderer
// bundle or scripts/dev.js recopies static assets.
function watchRendererDist() {
	let timer = null;
	try {
		fs.watch(path.join(distDir, 'renderer'), { recursive: true }, () => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				for (const win of BrowserWindow.getAllWindows()) {
					win.webContents.reloadIgnoringCache();
				}
			}, 150);
		});
	} catch (err) {
		console.error('dist watcher failed:', err);
	}
}

app.whenReady().then(async () => {
	settings.load();
	registerIpc();
	// The TeX engines are served immutable (protocol.js), so a restaged or
	// upgraded build would be answered from Chromium's HTTP cache for a
	// year; clear it when the build's identity changes (asset-stamp.js),
	// before any window can fetch. Awaited: a window racing the clear
	// could refill the cache from the old entries.
	try {
		const record = path.join(app.getPath('userData'), 'asset-stamp.txt');
		if (stampChanged(record, assetStamp(paths.mptikzAssets, app.getVersion()))) {
			await electronSession.defaultSession.clearCache();
			console.log('asset cache cleared: the staged TeX engines changed');
		}
	} catch (err) {
		console.error('asset stamp:', err);
	}
	// The note's typeface, as files for `font=note` figures (main/
	// note-fonts.js). Before the protocol and before any vault opens: the
	// render worker reads the index at spawn, and a preview fetches the
	// faces the moment a figure asks for them. A failure here costs that
	// feature, not the app.
	try {
		prepareNoteFonts(paths.noteFonts);
	} catch (err) {
		console.error('note fonts:', err);
	}
	installPreviewProtocol({
		distDir,
		nodeModulesDir: paths.previewAssets,
		engineAssetsDir: paths.engineAssets,
		embedpdfDir: paths.embedpdfAssets,
		mptikzDir: paths.mptikzAssets,
		zetaDir: paths.zetaAssets,
		noteFontsDir: paths.noteFonts,
		globalPluginsDir: paths.globalPlugins,
	});
	// No { role: 'close' } anywhere in the menu: Cmd+W belongs to the
	// renderer (close tab). See src/main/menu.js.
	appMenu.init({ rootDir });
	if (process.env.CLEW_DEV) watchRendererDist();

	// The interim vault-trust guard (vault-trust.js): the first launch that
	// has it records every vault this device already knew as trusted — it
	// has run their code already — so nothing changes for their owner. Only
	// a vault first opened AFTER this asks. Before any window: the windows
	// being restored below are exactly those vaults.
	trust.migrate([
		...(settings.get('openVaults') ?? []),
		...(settings.get('recentVaults') ?? []),
		settings.get('lastVault'),
	]);

	// Smoke runs open EXACTLY the given vault — never the user's restored
	// set. The rest of the isolation lives in settings.js#save: under
	// CLEW_SMOKE nothing is ever persisted, so vault opens and setting
	// flips inside a scenario cannot leak into the user's real settings.
	if (process.env.CLEW_SMOKE && process.env.CLEW_SMOKE_VAULT) {
		createWindow(process.env.CLEW_SMOKE_VAULT);
		return;
	}

	// Reopen every vault that was open last time (one window each);
	// migrate from the old single lastVault setting.
	let toOpen = (settings.get('openVaults') ?? []).filter((p) => fs.existsSync(p));
	if (toOpen.length === 0) {
		const last = settings.get('lastVault');
		if (last && fs.existsSync(last)) toOpen = [last];
	}
	settings.set('openVaults', toOpen);
	if (toOpen.length === 0) createWindow(null);
	else for (const vaultPath of toOpen) createWindow(vaultPath);

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow(null);
	});
	app.on('browser-window-focus', () => appMenu.rebuild());
});

app.on('before-quit', () => {
	quitting = true;
});

// Canvas web-page nodes run in <webview> guests: no popups (external links
// go to the browser), and navigation stays on the open web — never into
// file:// or clew-preview:// where vault content lives.
app.on('web-contents-created', (_event, contents) => {
	if (contents.getType() !== 'webview') return;
	contents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/i.test(url)) shell.openExternal(url);
		return { action: 'deny' };
	});
	contents.on('will-navigate', (event, url) => {
		if (!/^https?:/i.test(url)) event.preventDefault();
	});
});

app.on('window-all-closed', () => {
	// Smoke runs own their exit (app.exit after screenshots): quitting here
	// would race the harness out of its final assertions.
	if (process.env.CLEW_SMOKE) return;
	app.quit();
});

// Smoke-test hook for headless verification during development:
//   CLEW_SMOKE=/path/out.png            screenshot after boot, then quit
//   CLEW_SMOKE_SCRIPT=/path/scenario.js run this in the first window first
// Every window is captured: the first to CLEW_SMOKE's path, the rest with
// -2, -3, … suffixes in creation order.
// Boot is WAITED FOR, not timed: the first window, then its page. A fixed
// 3 s after `ready` served an idle machine and failed on a loaded one
// (2026-09-30, load ~15: `smoke failed: … reading 'webContents'` — there was
// no window yet). The old 3 s stays the MINIMUM, so a scenario's timing on a
// fast machine is what it always was; SMOKE_BOOT_LIMIT_MS bounds the wait,
// with an error that says which step never came.
const SMOKE_BOOT_LIMIT_MS = 120000;
async function smokeBootedWindow(readyAt) {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const late = () => Date.now() - readyAt > SMOKE_BOOT_LIMIT_MS;
	while (!windowOrder[0]) {
		if (late()) throw new Error(`no window ${SMOKE_BOOT_LIMIT_MS / 1000} s after app ready — the app did not boot`);
		await sleep(100);
	}
	const win = windowOrder[0];
	const windowMs = Date.now() - readyAt;
	while (win.webContents.isLoading()) {
		if (late()) throw new Error(`the window's page was still loading ${SMOKE_BOOT_LIMIT_MS / 1000} s after app ready`);
		await sleep(100);
	}
	console.log(`smoke-boot: window after ${windowMs} ms, page loaded after ${Date.now() - readyAt} ms`);
	await sleep(Math.max(0, 3000 - (Date.now() - readyAt)));
	return win;
}

if (process.env.CLEW_SMOKE) {
	app.whenReady().then(() => {
		const readyAt = Date.now();
		(async () => {
			try {
				const primary = await smokeBootedWindow(readyAt);
				// The input queue's key events never reach the native menu. CDP
				// key events carry no characters, and Electron hands one the page
				// leaves unhandled to the menu, where an empty key with ⌘ matches
				// the FIRST item: every ⌘ chord a scenario sent — a bare Meta
				// keydown is enough — opened "About Electron" on screen (measured
				// 2026-09-29 in hidden runs; the hand-off does not depend on the
				// window being shown). Nothing is lost: the renderer's dispatcher
				// owns every chord (menu accelerators are display-only), and every
				// chord from here matched About before anything else.
				primary.webContents.setIgnoreMenuShortcuts(true);
				// A hidden window is never focused, so the page is TOLD it is:
				// held for the whole run (the input queue below reuses this
				// attachment and must not detach it).
				if (smokeHidden) {
					try { primary.webContents.debugger.attach('1.3'); } catch { /* already attached */ }
					await primary.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
				}
				// CLEW_SMOKE_LOG=1: every console message from every frame
				// (previews included) to the terminal — wasm-boot debugging.
				if (process.env.CLEW_SMOKE_LOG) {
					primary.webContents.on('console-message', (details) => {
						console.log(`[smoke:${details.level}] ${details.message}`);
					});
				}
				if (process.env.CLEW_SMOKE_SCRIPT) {
					const script = fs.readFileSync(process.env.CLEW_SMOKE_SCRIPT, 'utf8');
					await primary.webContents.executeJavaScript(`(async () => { ${script} })()`);
				}
				// Real input through Chromium's pipeline — the only way to reach
				// surfaces synthetic DOM events can't (the LibreOffice canvas,
				// focus-sensitive keymaps). Dispatched over CDP, NOT
				// webContents.sendInputEvent: the office viewer is a
				// cross-origin iframe (an OOPIF), and sendInputEvent never
				// routes there (measured 2026-09-01) while the debugger's
				// Input domain hit-tests properly. A scenario queues
				// window.__clewSmokeInput = [{click:{x,y}} | {move:{x,y}} | {text:'abc'} |
				// {combo:{key:'s',modifiers:2}} | {wait:ms}] — a click may carry
				// `modifiers` too, e.g. {click:{x,y},modifiers:4}; and
				// {wheel:{x,y,deltaY}} scrolls (modifiers CDP
				// bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8).
				// window.__clewSmokeClipboard (string) preloads the clipboard;
				// CLEW_SMOKE_CLIPBOARD=1 dumps clipboard text afterwards.
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				const preloadClip = await primary.webContents.executeJavaScript('window.__clewSmokeClipboard ?? null');
				if (typeof preloadClip === 'string') clipboard.writeText(preloadClip);
				const inputEvents = await primary.webContents.executeJavaScript('window.__clewSmokeInput ?? null');
				if (Array.isArray(inputEvents)) {
					const dbg = primary.webContents.debugger;
					try { dbg.attach('1.3'); } catch { /* already attached */ }
					// A named key needs its real keyCode: xterm — and any library
					// reading the legacy `keyCode` rather than `key` — sees nothing
					// otherwise, so an Enter dispatched with 0 never reaches a
					// terminal as a carriage return.
					const NAMED_KEYS = {
						Enter: 13, Tab: 9, Backspace: 8, Escape: 27, Delete: 46,
						ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
						Home: 36, End: 35, PageUp: 33, PageDown: 34,
					};
					// And a punctuation character's keyCode is its US-layout KEY,
					// not its charCode: `-` is 189, while 45 is Insert — which is
					// what a terminal read it as, dropping every hyphen typed
					// (measured 2026-09-25, the shell-panel scenario). Anything
					// unlisted gets 0, so a library falls through to `key`.
					const PUNCT_KEYS = {
						';': 186, '=': 187, ',': 188, '-': 189, '.': 190, '/': 191,
						'`': 192, '[': 219, '\\': 220, ']': 221, "'": 222,
					};
					const keyParams = (key, modifiers = 0) => {
						const upper = key.length === 1 ? key.toUpperCase() : key;
						const vk = key.length !== 1 ? (NAMED_KEYS[key] ?? 0)
							: /[a-z0-9 ]/i.test(key) ? upper.charCodeAt(0)
								: (PUNCT_KEYS[key] ?? 0);
						return {
							modifiers,
							key,
							code: /^[a-z]$/i.test(key) ? `Key${upper}` : (NAMED_KEYS[key] ? key : undefined),
							windowsVirtualKeyCode: vk,
							nativeVirtualKeyCode: vk,
						};
					};
					for (const ev of inputEvents) {
						if (ev.wait) { await sleep(ev.wait); continue; }
						if (ev.wheel) {
							// {wheel:{x,y,deltaY}}: a real wheel tick at a point —
							// the only way to prove a wheel over a cross-origin
							// frame chains to the scroller beneath it.
							const { x, y, deltaY = 0, deltaX = 0 } = ev.wheel;
							await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'none', x, y });
							await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
							continue;
						}
						if (ev.move) {
							// {move:{x,y}, modifiers?}: the pointer to a point, nothing
							// pressed — hover (link previews). `modifiers` (the CDP
							// bitmask) makes it a ⌘-hover: e.metaKey in the page.
							const { x, y } = ev.move;
							await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'none', x, y, modifiers: ev.modifiers ?? 0 });
							await sleep(ev.delay ?? 30);
							continue;
						}
						if (ev.frameClick) {
							// {frameClick:{match, selector}}: a click at the centre of
							// an element INSIDE a preview frame — cross-origin, so a
							// scenario on the app page cannot measure it — resolved
							// at dispatch time from the frame (webFrameMain) and the
							// iframe's own box in the app page. `match` is a substring
							// of the frame's URL (the note), as CLEW_SMOKE_FRAME_MATCH.
							const { match, selector } = ev.frameClick;
							const frame = primary.webContents.mainFrame.framesInSubtree.find((f) =>
								f.url.startsWith('clew-preview:') && f.url.includes(match) && f.parent === primary.webContents.mainFrame);
							const inner = frame && await frame.executeJavaScript(`(() => {
								const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
								return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
							const outer = inner && await primary.webContents.executeJavaScript(`(() => {
								const f = [...document.querySelectorAll('iframe')].find((el) => el.offsetParent && (el.src || '').includes(${JSON.stringify(match)}));
								const r = f?.getBoundingClientRect(); return r ? { x: r.left, y: r.top } : null; })()`);
							if (!inner || !outer) {
								console.log(`smoke: frameClick found no ${selector} in a frame matching ${match}`);
								continue;
							}
							ev.click = { x: Math.round(outer.x + inner.x), y: Math.round(outer.y + inner.y) };
						}
						if (ev.click || ev.tripleClick) {
							const { x, y } = ev.click ?? ev.tripleClick;
							// `modifiers` on a click event (same CDP bitmask) makes it
							// a ⌘-click etc. — e.metaKey in the page (inverse search).
							const base = { x, y, pointerType: 'mouse', modifiers: ev.modifiers ?? 0 };
							const clicks = ev.tripleClick ? 3 : 1;
							await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'none', ...base });
							for (let count = 1; count <= clicks; count++) {
								await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: count, ...base });
								await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: count, ...base });
							}
						} else if (typeof ev.text === 'string') {
							for (const ch of ev.text) {
								const params = keyParams(ch);
								await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, ...params });
								await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
								await sleep(25);
							}
						} else if (ev.combo) {
							// Qt (the LibreOffice canvas) tracks modifier STATE from
							// Control/Meta keydowns — a bare modifiers bitmask on the
							// letter reads as plain typing there. Press the modifier
							// keys for real, around the letter.
							const MODS = [
								[2, { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 }],
								[4, { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, nativeVirtualKeyCode: 91 }],
								[1, { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18 }],
								[8, { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 }],
							];
							const want = ev.combo.modifiers ?? 0;
							let held = 0;
							const pressed = [];
							for (const [bit, mod] of MODS) {
								if (!(want & bit)) continue;
								held |= bit;
								await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: held, ...mod });
								pressed.push([bit, mod]);
							}
							const params = keyParams(ev.combo.key, held);
							// `text` makes the key TYPE as a real one does: a real
							// Enter's keyDown carries "\r", which is what puts a
							// newline in a textarea; without it (the default, which
							// every older scenario was written against) CDP's key
							// inserts nothing.
							if (ev.combo.text) Object.assign(params, { text: ev.combo.text, unmodifiedText: ev.combo.text });
							await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
							await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
							for (const [bit, mod] of pressed.reverse()) {
								await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: held, ...mod });
								held &= ~bit;
							}
						}
						await sleep(ev.delay ?? 30);
					}
					if (!smokeHidden) try { dbg.detach(); } catch { /* fine */ }
					await sleep(500);
				}
				if (process.env.CLEW_SMOKE_CLIPBOARD) {
					console.log('smoke-clipboard: ' + JSON.stringify(clipboard.readText()));
				}
				// CLEW_SMOKE_MENU=1: the application menu as the OS holds it —
				// every item's trail, accelerator and enablement, one line each.
				// A native menu is an OS-level window that capturePage cannot
				// see, so this is the only assertion a menu change can carry.
				// It reads the REAL menu, so it also proves the template built:
				// a malformed accelerator throws inside buildFromTemplate.
				if (process.env.CLEW_SMOKE_MENU) {
					const walk = (items, trail) => {
						for (const item of items) {
							if (item.type === 'separator') continue;
							const where = [...trail, item.label];
							console.log('smoke-menu: ' + where.join(' > ')
								+ (item.accelerator ? ` [${item.accelerator}]` : '')
								+ (item.enabled === false ? ' (disabled)' : ''));
							if (item.submenu) walk(item.submenu.items, where);
						}
					};
					walk(Menu.getApplicationMenu()?.items ?? [], []);
				}
				// CLEW_SMOKE_CLOSE_WINDOW=1: drive a REAL window close after the
				// scenario, so close-guard flows (dirty office tab + the
				// CLEW_SMOKE_CONFIRM answer) are testable end-to-end. The window
				// count that survives is the assertion.
				if (process.env.CLEW_SMOKE_CLOSE_WINDOW) {
					primary.close();
					await new Promise((r) => setTimeout(r, 2500));
					console.log('smoke-windows: ' + BrowserWindow.getAllWindows().length);
				}
				// Optionally drive the preview iframe's document (cross-origin from
				// the app, but reachable from main via webFrameMain).
				// CLEW_SMOKE_FRAME_MATCH=<substring>: run it in EVERY
				// clew-preview:// frame whose URL contains the substring (live
				// edit's block frames, `__clew_block__`), one after another; the
				// script sees `SMOKE_FRAME` — the URL's last path segment — to
				// prefix its lines with.
				if (process.env.CLEW_SMOKE_FRAME_SCRIPT) {
					const frameScript = fs.readFileSync(process.env.CLEW_SMOKE_FRAME_SCRIPT, 'utf8');
					const match = process.env.CLEW_SMOKE_FRAME_MATCH;
					const previews = primary.webContents.mainFrame.framesInSubtree
						.filter((f) => f.url.startsWith('clew-preview:'));
					const frames = match
						? previews.filter((f) => f.url.includes(match))
						: previews.filter((f) => f.parent === primary.webContents.mainFrame).slice(0, 1);
					if (frames.length === 0) console.error('smoke: no preview frame found');
					if (match) console.log(`smoke-frames: ${frames.length} matching ${match}`);
					for (const frame of frames) {
						const tag = new URL(frame.url).pathname.split('/').filter(Boolean).pop() ?? '';
						await frame.executeJavaScript(
							`(async () => { const SMOKE_FRAME = ${JSON.stringify(tag)}; ${frameScript} })()`);
					}
					await new Promise((r) => setTimeout(r, 1500));
				}
				await new Promise((r) => setTimeout(r, 800));
				const base = process.env.CLEW_SMOKE;
				for (let i = 0; i < windowOrder.length; i++) {
					const image = await windowOrder[i].webContents.capturePage();
					const file = i === 0 ? base : base.replace(/\.png$/, `-${i + 1}.png`);
					fs.writeFileSync(file, image.toPNG());
				}
				console.log(`smoke: ${windowOrder.length} screenshot(s) written`);
				// CLEW_SMOKE_METRICS=/path.json: per-process memory/CPU dump
				// beside the screenshot (the ZetaOffice spike measures with it).
				if (process.env.CLEW_SMOKE_METRICS) {
					fs.writeFileSync(process.env.CLEW_SMOKE_METRICS,
						JSON.stringify(app.getAppMetrics(), null, '\t'));
				}
			} catch (err) {
				console.error('smoke failed:', err);
			}
			// Flush pending note auto-saves, then exit HARD: app.quit() runs
			// the window-close guards, and a scenario that deliberately left a
			// dirty office document (+ CLEW_SMOKE_CONFIRM=cancel) would block
			// the harness forever on its own success.
			try {
				await windowOrder[0]?.webContents.executeJavaScript(
					'window.__clew?.editorPool?.flushAll?.()');
			} catch { /* window already gone */ }
			app.exit(0);
		})();
	});
}
