// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What the UI calls the machine it runs on — "Trust on this Mac", "every
// vault on this iPad" — because trust and global settings are the DEVICE's,
// and saying "this Mac" on an iPad is wrong (Clew-iOS patched the string at
// build time until this). A host that knows better names it:
// `globalThis.__clewDeviceName = 'iPad'`, set before the renderer loads.
// Otherwise the browser's own answer, with iPadOS's quirk: its WebKit
// reports platform `MacIntel` and a Mac user agent, and only its touch
// points tell it from a Mac.

/**
 * @param {{ hostName?: string, platform?: string, userAgent?: string,
 *   maxTouchPoints?: number }} [env]
 * @returns {string} `this iPad`, `this iPhone`, `this Mac`, `this computer`
 *   (Windows, Linux) or `this device`
 */
export function deviceName({ hostName, platform = '', userAgent = '', maxTouchPoints = 0 } = {}) {
	const named = typeof hostName === 'string' ? hostName.trim() : '';
	if (named && named.length <= 40) return `this ${named}`;
	if (/iPhone|iPod/.test(userAgent) || /^iP(hone|od)/.test(platform)) return 'this iPhone';
	if (/iPad/.test(userAgent) || platform === 'iPad' || (platform.startsWith('Mac') && maxTouchPoints > 1)) return 'this iPad';
	if (platform.startsWith('Mac')) return 'this Mac';
	if (/^(Win|Linux|X11|FreeBSD|OpenBSD)/.test(platform)) return 'this computer';
	return 'this device';
}

/** This page's device, decided once. */
export const DEVICE = deviceName({
	hostName: globalThis.__clewDeviceName,
	platform: globalThis.navigator?.platform,
	userAgent: globalThis.navigator?.userAgent,
	maxTouchPoints: globalThis.navigator?.maxTouchPoints,
});
