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
import { app, BrowserWindow, clipboard, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpc } from './ipc.js';
import { appMenu } from './menu.js';
import { settings } from './settings.js';
import { CH } from '../shared/channels.js';
import { registerPreviewScheme, installPreviewProtocol } from './protocol.js';
import { VaultSession, focusedSession, sessionForVault } from './session.js';
import { paths } from './paths.js';

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

export function createWindow(vaultPath = null) {
	const win = new BrowserWindow({
		width: 1280,
		height: 850,
		minWidth: 640,
		minHeight: 400,
		titleBarStyle: 'hiddenInset',
		backgroundColor: '#1e1e1e',
		webPreferences: {
			preload: path.join(distDir, 'preload', 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			plugins: true, // Chromium's built-in PDF viewer
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
		existing.win.show();
		existing.win.focus();
		return existing;
	}
	settings.addOpenVault(abs);
	if (preferSession && !preferSession.vaults.root && preferSession.win) {
		preferSession.vaults.open(abs);
		preferSession.win.focus();
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
	if (app.isPackaged) {
		target = path.join(app.getPath('documents'), 'Clew Demo Vault');
		if (!fs.existsSync(target)) {
			fs.cpSync(paths.demoVault, target, { recursive: true });
		}
	}
	if (!fs.existsSync(target)) return null;
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

app.whenReady().then(() => {
	settings.load();
	registerIpc();
	installPreviewProtocol({
		distDir,
		nodeModulesDir: paths.previewAssets,
		engineAssetsDir: paths.engineAssets,
		embedpdfDir: paths.embedpdfAssets,
		mptikzDir: paths.mptikzAssets,
		zetaDir: paths.zetaAssets,
		globalPluginsDir: paths.globalPlugins,
	});
	// No { role: 'close' } anywhere in the menu: Cmd+W belongs to the
	// renderer (close tab). See src/main/menu.js.
	appMenu.init({ rootDir });
	if (process.env.CLEW_DEV) watchRendererDist();

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
if (process.env.CLEW_SMOKE) {
	app.whenReady().then(() => {
		setTimeout(async () => {
			try {
				const primary = windowOrder[0];
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
				// window.__clewSmokeInput = [{click:{x,y}} | {text:'abc'} |
				// {combo:{key:'s',modifiers:2}} | {wait:ms}] (modifiers CDP
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
					const keyParams = (key, modifiers = 0) => {
						const upper = key.length === 1 ? key.toUpperCase() : key;
						const vk = key.length === 1 ? upper.charCodeAt(0) : 0;
						return {
							modifiers,
							key,
							code: /^[a-z]$/i.test(key) ? `Key${upper}` : undefined,
							windowsVirtualKeyCode: vk,
							nativeVirtualKeyCode: vk,
						};
					};
					for (const ev of inputEvents) {
						if (ev.wait) { await sleep(ev.wait); continue; }
						if (ev.click || ev.tripleClick) {
							const { x, y } = ev.click ?? ev.tripleClick;
							const base = { x, y, pointerType: 'mouse' };
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
							await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
							await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
							for (const [bit, mod] of pressed.reverse()) {
								await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: held, ...mod });
								held &= ~bit;
							}
						}
						await sleep(ev.delay ?? 30);
					}
					try { dbg.detach(); } catch { /* fine */ }
					await sleep(500);
				}
				if (process.env.CLEW_SMOKE_CLIPBOARD) {
					console.log('smoke-clipboard: ' + JSON.stringify(clipboard.readText()));
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
				if (process.env.CLEW_SMOKE_FRAME_SCRIPT) {
					const frameScript = fs.readFileSync(process.env.CLEW_SMOKE_FRAME_SCRIPT, 'utf8');
					const frame = primary.webContents.mainFrame.frames
						.find((f) => f.url.startsWith('clew-preview:'));
					if (frame) await frame.executeJavaScript(`(async () => { ${frameScript} })()`);
					else console.error('smoke: no preview frame found');
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
		}, 3000);
	});
}
