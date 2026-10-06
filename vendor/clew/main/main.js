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
import { trust, setTrustNotice } from './trust.js';
import { readVaultRequests } from './vault-requests.js';
import { startUpdateChecks } from './updater.js';
import { CH } from '../shared/channels.js';
import { registerPreviewScheme, installPreviewProtocol, installAppProtocol, installFrameProtocol } from './protocol.js';
import { VaultSession, focusedSession, sessionForVault, sessionForWindow } from './session.js';
import { paths } from './paths.js';
import { prepareNoteFonts } from './note-fonts.js';
import { assetStamp, stampChanged } from './asset-stamp.js';
import { staleSources } from './build-stamp.js';
import { listenForLinks, onSecondInstance, startDeepLinks } from './deep-link-host.js';
import { syncDemoVault, demoSyncNotice } from './demo-sync.js';
import demoHistory from './demo-history.json';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.dirname(__dirname); // dist/
const rootDir = path.dirname(distDir);

registerPreviewScheme();

// SharedArrayBuffer for the ZetaOffice (LibreOffice wasm) viewer, which is
// a pthreads build. True cross-origin isolation (COOP/COEP) is off the
// table by architecture: the app page is clew-app://app and previews are
// DELIBERATELY cross-origin clew-preview://, so the top-level document can
// never satisfy COEP for its frames. This switch enables SAB without COI —
// a conscious relaxation. The exposure is bounded: arbitrary web content
// runs only in canvas-web-node <webview> guests (separate processes), and
// SAB matters for cross-origin data mainly as a Spectre timer amplifier.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

// One process per profile (keyed by the userData folder, which paths.js has
// set by now — so smoke runs, each with its own, never collide): a second
// launch — a clew:// link on Windows and Linux, the app started twice —
// hands its command line to this one and goes (deep-link-host.js).
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', (_event, argv) => {
	onSecondInstance(argv);
	const s = focusedSession();
	if (s?.win && !s.win.isDestroyed() && !process.env.CLEW_SMOKE) { s.win.show(); s.win.focus(); }
});
// A link that opened the app arrives before ready (macOS `open-url`).
listenForLinks();

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
			// No `plugins` (docs/dev/pdf-unification.md §6): every PDF surface
			// is EmbedPDF — tabs, embeds, canvas nodes and scenes, portals (a
			// first-page picture), a note's own frames, vault or web. Dropping
			// the flag does NOT retire Chromium's own viewer (Electron 43,
			// measured 2026-09-30), so a frame that navigates to a vault PDF
			// anyway is sent to EmbedPDF by protocol.js, and a web PDF Clew
			// cannot recognise still opens in Chromium's viewer. No
			// will-download guard either: EmbedPDF's own Download is a blob
			// `<a download="x.pdf">`, and a guard cancelled it (measured).
			webviewTag: true, // canvas web-page nodes
		},
	});
	const session = new VaultSession(win, distDir);
	windowOrder.push(win);

	// The app page on its own origin (frame-bridge.md §2), not file://, whose
	// origin is `null` — the one every sandboxed frame has too. Served by
	// protocol.js#installAppProtocol from dist/renderer and nothing else.
	win.loadURL('clew-app://app/index.html');

	// Nothing legitimate frames the app page, so no SUBFRAME may load it
	// (§2.7) — beside `frame-ancestors 'none'` on the document itself.
	win.webContents.on('will-frame-navigate', (event) => {
		if (!event.isMainFrame && /^clew-app:/i.test(event.url)) {
			event.preventDefault();
			if (process.env.CLEW_SMOKE) console.log(`smoke-app-frame-refused: ${event.url}`);
			return;
		}
		// An app frame stays on its own origin (frame-bridge.md §7, R2): a
		// frame navigating itself to https://…?<data> is an outbound channel
		// no CSP closes. Its first load (from about:blank) is the preview
		// client's own doing and passes.
		const from = event.frame?.url ?? '';
		if (!event.isMainFrame && /^clew-frame:/i.test(from)) {
			let same = false;
			try { same = new URL(from).origin === new URL(event.url).origin; } catch { /* not a URL */ }
			if (!same) {
				event.preventDefault();
				if (process.env.CLEW_SMOKE) console.log(`smoke-app-nav-refused: ${event.url}`);
			}
		}
	});

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

	// A trust change reloads the window (frame-bridge.md §4.6), and a reload
	// loses what a close would: the same question first. Resolves true when
	// the page may reload now; false on Cancel, or while a close is already
	// being asked about. A 'pending' answer (a dialog is up, or PDF
	// annotations are being written) stops the fail-open timer, as above.
	session.askToReload = () => new Promise((resolve) => {
		if (closePending || session.resolveClose) return resolve(false);
		let timer = null;
		const done = (proceed) => {
			clearTimeout(timer);
			session.resolveClose = null;
			resolve(proceed === true);
		};
		timer = setTimeout(() => done(true), 3000);
		session.resolveClose = (proceed) => {
			if (proceed === 'pending') { clearTimeout(timer); return; }
			done(proceed);
		};
		win.webContents.send(CH.EV_CLOSE_REQUESTED, { reason: 'reload' });
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
 * Bring a window forward — the Window menu's list of open vaults. Under a
 * hidden smoke run nothing is shown or focused (a hidden window cannot take
 * focus, and showing one breaks the run's invisibility), so the switch is
 * recorded as the focus event would record it and logged instead.
 */
export function focusWindow(session) {
	const win = session?.win;
	if (!win || win.isDestroyed()) return;
	if (smokeHidden) {
		session.lastFocusedAt = Date.now();
		console.log(`smoke-window-focus: ${session.vaults.root ? path.basename(session.vaults.root) : '(no vault)'}`);
		appMenu.rebuild();
		return;
	}
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
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
	// A scenario's own copy takes the packaged path from a dev build
	// (smoke/demo-sync-scenario.js); never outside the harness.
	const smokeTarget = process.env.CLEW_SMOKE ? process.env.CLEW_SMOKE_DEMO_TARGET || null : null;
	const copying = app.isPackaged || Boolean(smokeTarget);
	if (copying) {
		target = smokeTarget ?? path.join(app.getPath('documents'), 'Clew Demo Vault');
		if (!fs.existsSync(target)) {
			fs.cpSync(paths.demoVault, target, { recursive: true });
			fresh = true;
		}
	}
	if (!fs.existsSync(target)) return null;
	// The demo brought up to date in this copy (demo-sync.js): new files
	// added, untouched old ones updated (by the hash given, or a version Clew
	// ever shipped — demo-history.json), the user's own changes and
	// deletions left alone, never into .clew. A fresh copy only records.
	let synced = { added: [], updated: [] };
	if (copying) {
		try { synced = syncDemoVault(paths.demoVault, target, { history: demoHistory }); } catch (err) { console.warn(`[clew] demo vault update: ${err.message}`); }
		if (process.env.CLEW_SMOKE) console.log(`smoke-demo-sync: fresh=${fresh} added=${synced.added.length} updated=${synced.updated.length} ${JSON.stringify(synced.updated.slice(0, 12))}`);
	}
	// Clew's own vault (§4.8) is trusted by construction: a copy made just
	// now from the bundle, or one this device has never decided about. A
	// decision already recorded — a revoke — stands.
	if (fresh || !trust.entries()[fs.realpathSync(target)]) trust.trust(target, 'demo', readVaultRequests(target)?.enable ?? null);
	const session = openVaultAnywhere(target, { preferSession: fromSession });
	const text = demoSyncNotice(synced);
	if (text) {
		if (session.vaults.root) session.vaults.refreshTree?.();
		Promise.resolve(session.opened).then(() => setTimeout(() => {
			if (process.env.CLEW_SMOKE) console.log(`smoke-demo-sync: notice ${JSON.stringify(text)}`);
			session.send(CH.EV_NOTICE, { text, ms: 12000 });
		}, 1500));
	}
	return session.vaults.info;
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
	installAppProtocol({ rendererDir: path.join(distDir, 'renderer') });
	installFrameProtocol({ bridgeFile: path.join(distDir, 'preview-client', 'clew-bridge.js') });
	// CLEW_SMOKE_NET_LOG=1: every request that LEAVES the machine (http(s),
	// ws(s)) from any page, as `smoke-net: <method> <url>` — how a scenario
	// proves Clew made no outbound request (frame-bridge.md §4.9a). What a
	// CSP blocks never gets this far.
	if (process.env.CLEW_SMOKE && process.env.CLEW_SMOKE_NET_LOG) {
		const logNet = (ses) => ses.webRequest.onBeforeRequest(
			{ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
			(details, callback) => { console.log(`smoke-net: ${details.method} ${details.url}`); callback({}); });
		logNet(electronSession.defaultSession);
		app.on('session-created', logNet);
	}
	installPreviewProtocol({
		distDir,
		nodeModulesDir: paths.previewAssets,
		engineAssetsDir: paths.engineAssets,
		embedpdfDir: paths.embedpdfAssets,
		stampsDir: paths.stampsAssets,
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
	const known = [
		...(settings.get('openVaults') ?? []),
		...(settings.get('recentVaults') ?? []),
		settings.get('lastVault'),
	].filter(Boolean);
	trust.migrate(known);
	// The full design (2026-10-02): the store moves to version 2 once, and
	// that launch says so — naming any known vault this device has NOT
	// trusted, since those now run none of their code (scripts, plugins
	// included). Every vault known when the guard arrived is trusted already.
	if ((!process.env.CLEW_SMOKE || process.env.CLEW_SMOKE_TRUST_NOTICE) && trust.takeNotice()) {
		const restricted = [...new Set(known)].filter((root) => fs.existsSync(root) && !trust.isTrusted(root))
			.map((root) => path.basename(root));
		setTrustNotice({ restricted });
	}

	// Smoke runs open EXACTLY the given vault — never the user's restored
	// set. The rest of the isolation lives in settings.js#save: under
	// CLEW_SMOKE nothing is ever persisted, so vault opens and setting
	// flips inside a scenario cannot leak into the user's real settings.
	if (process.env.CLEW_SMOKE && process.env.CLEW_SMOKE_VAULT) {
		createWindow(process.env.CLEW_SMOKE_VAULT);
		// Only ever against a LOOPBACK feed here (updater.js#checkAllowed).
		startUpdateChecks();
		// Links given on the command line; the `clew` command only with a
		// socket the scenario names (CLEW_CLI_SOCKET).
		startDeepLinks({ openVaultAnywhere, root: rootDir });
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
	// The daily update check: packaged builds only (updater.js).
	startUpdateChecks();
	// clew:// links and the `clew` command, once the restored windows exist.
	startDeepLinks({ openVaultAnywhere, root: rootDir });

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow(null);
	});
	app.on('browser-window-focus', (_event, win) => {
		const session = sessionForWindow(win);
		if (session) session.lastFocusedAt = Date.now();
		appMenu.rebuild();
	});
});

app.on('before-quit', () => {
	quitting = true;
});

// Canvas web-page nodes run in <webview> guests: no popups (external links
// go to the browser), and navigation stays on the open web — never into
// file://, clew-preview:// where vault content lives, or clew-app://.
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

// A smoke run measures the code in dist/, so that must BE the code in src/
// (build-stamp.js): refuse, naming every source that changed since the
// build, when they differ — before any window. A packaged app is checked
// only when told which checkout to compare with: smoke/boot-test.sh passes
// CLEW_SMOKE_SOURCES=<repo>. CLEW_SMOKE_ALLOW_STALE=1 runs anyway (and says so).
if (process.env.CLEW_SMOKE) {
	const sources = app.isPackaged ? process.env.CLEW_SMOKE_SOURCES : app.getAppPath();
	const stale = sources ? staleSources(sources, path.join(app.getAppPath(), 'dist', 'build-stamp.json')) : { changed: [] };
	if (!stale || stale.changed.length) {
		const what = app.isPackaged ? 'this packaged app' : 'dist/';
		const listed = stale ? stale.changed.slice(0, 15).join(', ') + (stale.changed.length > 15 ? `, … ${stale.changed.length} in all` : '') : '';
		const message = stale
			? `smoke-stale: ${what} was built from other sources than ${sources} — changed since its build (${stale.builtAt}): ${listed}`
			: `smoke-stale: ${what} has no build stamp (dist/build-stamp.json)`;
		if (process.env.CLEW_SMOKE_ALLOW_STALE) {
			console.warn(`${message} — running anyway (CLEW_SMOKE_ALLOW_STALE)`);
		} else {
			console.error(`${message}. Rebuild first (node scripts/build.js${app.isPackaged ? ', then package' : ''}), or set CLEW_SMOKE_ALLOW_STALE=1.`);
			process.exit(3);
		}
	}
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
				// CLEW_SMOKE_WEBRTC_POLICY=<policy>: this window's WebRTC IP
				// handling, for measuring choice D (frame-bridge.md §6) — what an
				// app frame's ICE can do — before anything is set for real.
				if (process.env.CLEW_SMOKE_WEBRTC_POLICY) {
					primary.webContents.setWebRTCIPHandlingPolicy(process.env.CLEW_SMOKE_WEBRTC_POLICY);
					console.log(`smoke-webrtc-policy: ${primary.webContents.getWebRTCIPHandlingPolicy()}`);
				}
				// A trust change reloads the window (frame-bridge.md §4.6), which
				// ends whatever scenario was running in it. Listening from here
				// on: a load after this point IS that reload.
				let reloads = 0;
				primary.webContents.on('did-finish-load', () => { reloads++; });
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
				// window.__clewSmokeInput = [{click:{x,y}} | {click:{selector}} (the
				// centre of an app-page element, found when its turn comes) |
				// {move:{x,y}} | {move:{selector}} | {text:'abc'} |
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
						if (ev.drag) {
							// {drag:{from, to, steps?}}: press at `from`, move to `to`
							// with the button held (in `steps`, default 8), release —
							// a pointer drag (the Book panel's grip). Each end is
							// {x,y} or {selector, dx?, dy?}: the centre of that app-page
							// element, offset, found when its turn comes.
							const end = async (point) => {
								if (!point?.selector) return point;
								const found = await primary.webContents.executeJavaScript(`(() => {
									const r = document.querySelector(${JSON.stringify(point.selector)})?.getBoundingClientRect();
									return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
								return found && { x: Math.round(found.x + (point.dx ?? 0)), y: Math.round(found.y + (point.dy ?? 0)) };
							};
							const from = await end(ev.drag.from);
							const to = await end(ev.drag.to);
							if (!from || !to) {
								console.log(`smoke: drag found no ${!from ? ev.drag.from?.selector : ev.drag.to?.selector}`);
								continue;
							}
							const steps = ev.drag.steps ?? 8;
							const base = { pointerType: 'mouse', modifiers: ev.modifiers ?? 0 };
							await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'none', ...from, ...base });
							await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...from, ...base });
							for (let i = 1; i <= steps; i++) {
								const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
								const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
								await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x, y, ...base });
								await sleep(16);
							}
							await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...to, ...base });
							await sleep(ev.delay ?? 30);
							continue;
						}
						if (ev.move) {
							// {move:{x,y}, modifiers?}: the pointer to a point, nothing
							// pressed — hover (link previews). `modifiers` (the CDP
							// bitmask) makes it a ⌘-hover: e.metaKey in the page.
							// {move:{selector}}: the middle of that app-page element's
							// FIRST line box (a wrapped inline's bounding box can be
							// empty in its middle), found when its turn comes.
							let point = ev.move;
							if (ev.move.selector) {
								point = await primary.webContents.executeJavaScript(`(() => {
									const r = document.querySelector(${JSON.stringify(ev.move.selector)})?.getClientRects()[0];
									return r ? { x: Math.round(r.left + Math.min(r.width / 2, 40)), y: Math.round(r.top + r.height / 2) } : null; })()`);
								if (!point) {
									console.log(`smoke: move found no ${ev.move.selector}`);
									continue;
								}
							}
							const { x, y } = point;
							await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'none', x, y, modifiers: ev.modifiers ?? 0 });
							await sleep(ev.delay ?? 30);
							continue;
						}
						let at = null;
						if (ev.frameClick) {
							// {frameClick:{match, selector}}: a click at the centre of
							// an element INSIDE a preview frame — cross-origin, so a
							// scenario on the app page cannot measure it — resolved
							// at dispatch time from the frame (webFrameMain) and the
							// iframe's own box in the app page. `match` is a substring
							// of the frame's URL (the note), as CLEW_SMOKE_FRAME_MATCH.
							// The selector also reaches into open shadow roots: the
							// PDF viewer draws its UI in one.
							const { match, selector } = ev.frameClick;
							// A preview frame on the page, or — when none matches — a
							// frame at ANY depth (an app's clew-frame:// inside a note's
							// frame), placed by adding each ancestor iframe's box.
							const top = primary.webContents.mainFrame;
							const frame = top.framesInSubtree.find((f) =>
								f.url.startsWith('clew-preview:') && f.url.includes(match) && f.parent === top)
								?? top.framesInSubtree.find((f) => f !== top && /^clew-(preview|frame):/.test(f.url) && f.url.includes(match));
							const inner = frame && await frame.executeJavaScript(`(() => {
								const deep = (root) => root.querySelector(${JSON.stringify(selector)})
									?? [...root.querySelectorAll('*')].reduce((hit, el) => hit ?? (el.shadowRoot ? deep(el.shadowRoot) : null), null);
								const r = deep(document)?.getBoundingClientRect();
								return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
							let outer = inner ? { x: 0, y: 0 } : null;
							for (let child = frame; outer && child && child !== top; child = child.parent) {
								// The iframe holding `child` in its parent: by its URL (sans
								// hash), else — the page's own preview frames — by `match`.
								const box = await child.parent.executeJavaScript(`(() => {
									const want = ${JSON.stringify(child.url.split('#')[0])};
									const frames = [...document.querySelectorAll('iframe')].filter((el) => el.offsetParent);
									const f = frames.find((el) => (el.src || '').split('#')[0] === want)
										?? frames.find((el) => (el.src || '').includes(${JSON.stringify(match)}));
									if (!f) return null;
									const r = f.getBoundingClientRect();
									return { x: r.left + f.clientLeft, y: r.top + f.clientTop }; })()`);
								outer = box ? { x: outer.x + box.x, y: outer.y + box.y } : null;
							}
							if (!inner || !outer) {
								console.log(`smoke: frameClick found no ${selector} in a frame matching ${match}`);
								continue;
							}
							at = { x: Math.round(outer.x + inner.x), y: Math.round(outer.y + inner.y) };
						}
						if (ev.click?.selector) {
							// {click:{selector}}: the centre of an element on the APP
							// page, resolved at dispatch time — for what appears only
							// after earlier input (a hover popover's button).
							const found = await primary.webContents.executeJavaScript(`(() => {
								const r = document.querySelector(${JSON.stringify(ev.click.selector)})?.getBoundingClientRect();
								return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
							if (!found) {
								console.log(`smoke: click found no ${ev.click.selector}`);
								continue;
							}
							at = { x: Math.round(found.x), y: Math.round(found.y) };
						}
						// Resolved positions go in `at`, never back into the event:
						// a scenario may queue ONE object several times.
						at ??= ev.click ?? ev.tripleClick;
						if (at) {
							const { x, y } = at;
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
							// `code`: the physical key, when it is not the one `key`
							// implies — a Mac's ⌥Q is key "œ" on code "KeyQ".
							if (ev.combo.code) params.code = ev.combo.code;
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
				// A checked checkbox or radio ends in ` ✓`.
				// CLEW_SMOKE_MENU_CLICK='Window > Alpha' then clicks that REAL item
				// (its own click handler, as a mouse would run it) and dumps the
				// item's top-level menu again as `smoke-menu-after:` lines.
				const walk = (items, trail, tag = 'smoke-menu', visit = null) => {
					for (const item of items) {
						if (item.type === 'separator') continue;
						const where = [...trail, item.label];
						visit?.(item, where.join(' > '));
						console.log(`${tag}: ` + where.join(' > ')
							+ (item.accelerator ? ` [${item.accelerator}]` : '')
							+ (item.enabled === false ? ' (disabled)' : '')
							+ (item.checked ? ' ✓' : ''));
						if (item.submenu) walk(item.submenu.items, where, tag, visit);
					}
				};
				if (process.env.CLEW_SMOKE_MENU) {
					const wanted = process.env.CLEW_SMOKE_MENU_CLICK;
					let target = null;
					walk(Menu.getApplicationMenu()?.items ?? [], [], 'smoke-menu',
						(item, where) => { if (wanted && where.startsWith(wanted)) target ??= item; });
					if (wanted) {
						console.log(`smoke-menu-click: ${wanted} → ${target ? target.label : 'NOT FOUND'}`);
						target?.click();
						await sleep(500);
						const top = (Menu.getApplicationMenu()?.items ?? []).find((m) => m.label === wanted.split(' > ')[0]);
						if (top) walk([top], [], 'smoke-menu-after');
					}
				}
				// CLEW_SMOKE_CLOSE_WINDOW=1: drive a REAL window close after the
				// scenario, so close-guard flows (dirty office tab + the
				// CLEW_SMOKE_CONFIRM answer) are testable end-to-end. The window
				// count that survives is the assertion.
				if (process.env.CLEW_SMOKE_CLOSE_WINDOW) {
					primary.close();
					await new Promise((r) => setTimeout(r, 2500));
					console.log('smoke-windows: ' + BrowserWindow.getAllWindows().length);
					// With CLEW_SMOKE_MENU: the Window menu once the window is gone.
					const windowMenu = (Menu.getApplicationMenu()?.items ?? []).find((m) => m.label === 'Window');
					if (process.env.CLEW_SMOKE_MENU && windowMenu) walk([windowMenu], [], 'smoke-menu-closed');
				}
				// CLEW_SMOKE_SCRIPT_RELOADED=/path.js: the scenario's second half,
				// run in the page that a reload brought (a trust change reloads the
				// window — vault-trust's scenarios). Waits for that reload — at
				// most a minute, logging `smoke-reloaded: <n>` — then for the vault.
				if (process.env.CLEW_SMOKE_SCRIPT_RELOADED) {
					for (let i = 0; i < 600 && reloads === 0; i++) await sleep(100);
					console.log(`smoke-reloaded: ${reloads}`);
					await sleep(3000);
					const second = fs.readFileSync(process.env.CLEW_SMOKE_SCRIPT_RELOADED, 'utf8');
					await primary.webContents.executeJavaScript(`(async () => { ${second} })()`);
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
					// Preview documents, and apps in notes (clew-frame:).
					const previews = primary.webContents.mainFrame.framesInSubtree
						.filter((f) => /^clew-(preview|frame):/.test(f.url));
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
