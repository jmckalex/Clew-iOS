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
import { app, BrowserWindow, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpc } from './ipc.js';
import { appMenu } from './menu.js';
import { settings } from './settings.js';
import { registerPreviewScheme, installPreviewProtocol } from './protocol.js';
import { VaultSession, focusedSession, sessionForVault } from './session.js';
import { paths } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.dirname(__dirname); // dist/
const rootDir = path.dirname(distDir);

registerPreviewScheme();

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
	});
	// No { role: 'close' } anywhere in the menu: Cmd+W belongs to the
	// renderer (close tab). See src/main/menu.js.
	appMenu.init({ rootDir });
	if (process.env.CLEW_DEV) watchRendererDist();

	// Smoke runs open EXACTLY the given vault — never the user's restored
	// set, and without rewriting openVaults/recents (harness isolation).
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
				if (process.env.CLEW_SMOKE_SCRIPT) {
					const script = fs.readFileSync(process.env.CLEW_SMOKE_SCRIPT, 'utf8');
					await primary.webContents.executeJavaScript(`(async () => { ${script} })()`);
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
			} catch (err) {
				console.error('smoke failed:', err);
			}
			app.quit();
		}, 3000);
	});
}
