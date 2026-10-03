// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The update check (docs/dev/auto-update.md v1; the owner's answers,
// 2026-10-03): notify only, on by default (`updateCheck`), once 30 s after
// launch and every 24 h. Main, never the renderer: `net.fetch` of the feed,
// nothing sent but the request itself — no identifier, no version in the URL.
// A newer version is told to the focused window ("Clew X is available. What's
// new · Download · Skip this version"); a skipped version is not told again;
// Help → Check for Updates… always answers.
//
// NEVER from a dev build or a smoke run against the real feed — a test must
// not reach the network. `CLEW_UPDATE_FEED=http://127.0.0.1:<port>/…` (a
// LOOPBACK feed) is the one way to exercise it there; `CLEW_UPDATE_DELAY_MS`
// shortens the first wait for a scenario.
import { app, BrowserWindow, net } from 'electron';
import { settings } from './settings.js';
import { FEED_URL, readFeed, decide } from './update-check.js';
import { CH } from '../shared/channels.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//;

function feedUrl() {
	return process.env.CLEW_UPDATE_FEED || FEED_URL;
}

/** May a check run in this process at all? */
export function checkAllowed() {
	const override = process.env.CLEW_UPDATE_FEED;
	if (override) return LOOPBACK.test(override) || (app.isPackaged && !process.env.CLEW_SMOKE);
	if (process.env.CLEW_SMOKE) return false;
	return app.isPackaged;
}

async function fetchFeed() {
	const url = feedUrl();
	const res = await net.fetch(url, { cache: 'no-store', redirect: 'error' });
	if (!res.ok) throw new Error(`the update feed answered ${res.status}`);
	const feed = readFeed(await res.json(), url);
	if (!feed) throw new Error('the update feed is not in the expected form');
	return feed;
}

/**
 * One check. Resolves to what to tell the user — `{ status: 'available' |
 * 'current' | 'skipped' | 'failed' | 'off', … }` — and never throws.
 */
export async function checkForUpdate({ manual = false } = {}) {
	if (!checkAllowed()) return { status: 'off', reason: app.isPackaged ? 'disabled in this run' : 'a development build never checks' };
	try {
		const feed = await fetchFeed();
		return decide(feed, { current: app.getVersion(), skipped: settings.get('skippedUpdate') ?? null, manual });
	} catch (err) {
		console.warn(`clew: update check failed: ${err.message}`);
		return { status: 'failed', reason: String(err.message) };
	}
}

function tellWindow(result) {
	const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
	if (!win || win.isDestroyed()) return;
	try { win.webContents.send(CH.EV_UPDATE_AVAILABLE, result); } catch { /* window going */ }
}

let told = null;

async function scheduled() {
	if (settings.get('updateCheck') === 'off') return;
	const result = await checkForUpdate();
	if (process.env.CLEW_SMOKE) console.log(`smoke-update: scheduled ${result.status}${result.version ? ` ${result.version}` : ''}`);
	// Once per version per run: the daily check does not nag.
	if (result.status === 'available' && told !== result.version) {
		told = result.version;
		tellWindow(result);
	}
}

/** After the first window: the first check, then one a day. */
export function startUpdateChecks() {
	if (!checkAllowed()) return;
	const delay = Number(process.env.CLEW_UPDATE_DELAY_MS) || 30_000;
	setTimeout(() => {
		scheduled();
		setInterval(scheduled, DAY_MS).unref?.();
	}, delay).unref?.();
}
