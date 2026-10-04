// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What the UI calls the machine (renderer/lib/device-name.js): "Trust on
// this Mac" must not say Mac on an iPad.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceName } from '../vendor/clew/renderer/lib/device-name.js';

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

test('a Mac is this Mac', () => {
	// Electron on macOS: MacIntel, no touch points (Apple silicon too).
	assert.equal(deviceName({ platform: 'MacIntel', userAgent: `${MAC_UA} Clew/0.12.1 Electron/43`, maxTouchPoints: 0 }), 'this Mac');
});

test('an iPad is this iPad, though its WebKit says MacIntel', () => {
	// iPadOS 13+: a desktop-class user agent and platform; only the touch
	// points tell it apart (WKWebView, as Clew-iOS runs).
	assert.equal(deviceName({ platform: 'MacIntel', userAgent: MAC_UA, maxTouchPoints: 5 }), 'this iPad');
	assert.equal(deviceName({ platform: 'iPad', userAgent: 'Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X)' }), 'this iPad');
});

test('an iPhone is this iPhone', () => {
	assert.equal(deviceName({ platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', maxTouchPoints: 5 }), 'this iPhone');
});

test('Windows and Linux are this computer; anything else this device', () => {
	assert.equal(deviceName({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }), 'this computer');
	assert.equal(deviceName({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }), 'this computer');
	assert.equal(deviceName({ platform: '', userAgent: '' }), 'this device');
	assert.equal(deviceName(), 'this device');
});

test('a host that names the device is believed', () => {
	assert.equal(deviceName({ hostName: 'iPad', platform: 'MacIntel', maxTouchPoints: 0 }), 'this iPad');
	assert.equal(deviceName({ hostName: '  Vision Pro ', platform: 'MacIntel' }), 'this Vision Pro');
	// Blank or absurd: the browser's own answer instead.
	assert.equal(deviceName({ hostName: '   ', platform: 'MacIntel' }), 'this Mac');
	assert.equal(deviceName({ hostName: 'x'.repeat(41), platform: 'MacIntel' }), 'this Mac');
	assert.equal(deviceName({ hostName: 42, platform: 'MacIntel' }), 'this Mac');
});
