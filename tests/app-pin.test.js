// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Pinning an app within its note (shared/app-pin.js): the rule reading view
// and live edit both hold a pinned app by.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinOf, pinnedTop } from '../vendor/clew/shared/app-pin.js';

test('pinOf reads pin=top|bottom from the directive, and nothing else', () => {
	assert.equal(pinOf('@app+[Apps/Ticker]{pin=bottom}'), 'bottom');
	assert.equal(pinOf('@app+[Apps/Ticker]{height=150 pin=top}'), 'top');
	assert.equal(pinOf('@app+[Apps/Ticker]{pin="Bottom" height=150}'), 'bottom');
	assert.equal(pinOf('@app+[Apps/Ticker]{height=150}'), null);
	assert.equal(pinOf('@app+[Apps/Ticker]{pin=left}'), null);
	assert.equal(pinOf('@app+[Apps/pin=top]'), null, 'the target is not an option');
	assert.equal(pinOf(null), null);
});

const view = { viewTop: 0, viewBottom: 800 };

test('a bottom pin is held at the bottom while its place is below the view', () => {
	// Its place far below: held at the bottom edge.
	assert.deepEqual(pinnedTop({ ...view, top: 3000, height: 150, pin: 'bottom' }), { top: 650, stuck: true });
	// Its place partly below: held, so all of it shows.
	assert.deepEqual(pinnedTop({ ...view, top: 700, height: 150, pin: 'bottom' }), { top: 650, stuck: true });
	// Its place in view: there.
	assert.deepEqual(pinnedTop({ ...view, top: 400, height: 150, pin: 'bottom' }), { top: 400, stuck: false });
	// Scrolled past (its place above the view): it goes with the note.
	assert.deepEqual(pinnedTop({ ...view, top: -500, height: 150, pin: 'bottom' }), { top: -500, stuck: false });
});

test('a top pin is held at the top once its place is above the view', () => {
	assert.deepEqual(pinnedTop({ ...view, top: -500, height: 150, pin: 'top' }), { top: 0, stuck: true });
	assert.deepEqual(pinnedTop({ ...view, top: 200, height: 150, pin: 'top' }), { top: 200, stuck: false });
	assert.deepEqual(pinnedTop({ ...view, top: 3000, height: 150, pin: 'top' }), { top: 3000, stuck: false });
});

test('the view may start anywhere (a scroller’s content coordinates), and no pin is no change', () => {
	assert.deepEqual(pinnedTop({ viewTop: 1200, viewBottom: 2000, top: 5000, height: 100, pin: 'bottom' }), { top: 1900, stuck: true });
	assert.deepEqual(pinnedTop({ viewTop: 1200, viewBottom: 2000, top: 300, height: 100, pin: 'top' }), { top: 1200, stuck: true });
	assert.deepEqual(pinnedTop({ ...view, top: 5000, height: 100, pin: null }), { top: 5000, stuck: false });
	// Taller than the view: held with its top at the view's top, never above.
	assert.deepEqual(pinnedTop({ ...view, top: 3000, height: 1000, pin: 'bottom' }), { top: 0, stuck: true });
});
