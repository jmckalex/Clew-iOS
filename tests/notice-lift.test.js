// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The window's notices sit clear of every PDF viewer's status chip
// (renderer/lib/notice-lift.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noticeLift, CHIP_CORNER } from '../vendor/clew/renderer/lib/notice-lift.js';

const H = 850;
// The column at rest: bottom 40 px, centred, 460 px wide in a 1280 px window.
const notices = { left: 410, right: 870, top: H - 40 - 44, bottom: H - 40 };

test('a viewer whose chip corner the notice covers lifts the column above it', () => {
	// A PDF tab filling the left of the window to just above the status bar.
	const viewer = { left: 0, right: 980, top: 70, bottom: H - 22 };
	const bottom = noticeLift(notices, [viewer], H, 40);
	assert.equal(bottom, 22 + CHIP_CORNER.height + 6);
	// Lifted, the column's lower edge is above the corner's top.
	assert.ok(H - bottom <= viewer.bottom - CHIP_CORNER.height);
});

test('a viewer elsewhere leaves the column at rest', () => {
	// Its corner is right of the notice …
	assert.equal(noticeLift(notices, [{ left: 900, right: 1280, top: 70, bottom: H - 22 }], H, 40), 40);
	// … or far above it (a canvas card).
	assert.equal(noticeLift(notices, [{ left: 300, right: 700, top: 100, bottom: 400 }], H, 40), 40);
	assert.equal(noticeLift(notices, [], H, 40), 40);
});

test('the highest covered corner wins', () => {
	const low = { left: 0, right: 640, top: 70, bottom: H - 22 };
	const high = { left: 640, right: 860, top: 70, bottom: H - 30 };
	assert.equal(noticeLift(notices, [low, high], H, 40), 30 + CHIP_CORNER.height + 6);
});

test('a narrow viewer’s corner is no wider than the viewer', () => {
	// 120 px wide, its whole width is the corner; the notice reaches it.
	assert.equal(noticeLift(notices, [{ left: 840, right: 960, top: 500, bottom: H - 22 }], H, 40), 68);
	// Just past the notice's right edge: clear.
	assert.equal(noticeLift(notices, [{ left: 870, right: 990, top: 500, bottom: H - 22 }], H, 40), 40);
});
