// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The embed disclosure keyword: read by the engine, written by the toggle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmbedModes, setEmbedState } from '../vendor/clew/engine/embed-state.js';

test('no alias means no modes at all', () => {
	assert.deepEqual(parseEmbedModes(null), { state: null, chrome: null, alias: null });
});

test('a keyword-only alias is a state, not a title', () => {
	assert.deepEqual(parseEmbedModes('collapsed'), { state: 'collapsed', chrome: null, alias: null });
	assert.deepEqual(parseEmbedModes('open'), { state: 'open', chrome: null, alias: null });
});

test('the keyword is the LAST segment; earlier segments stay the title', () => {
	assert.deepEqual(parseEmbedModes('Reading|collapsed'),
		{ state: 'collapsed', chrome: null, alias: 'Reading' });
});

test('a plain alias is left alone', () => {
	assert.deepEqual(parseEmbedModes('Week Three'), { state: null, chrome: null, alias: 'Week Three' });
});

test('the keyword is recognised whatever its case', () => {
	assert.equal(parseEmbedModes('Collapsed').state, 'collapsed');
	assert.equal(parseEmbedModes('OPEN').state, 'open');
});

test('a title that merely contains the word is not a state', () => {
	assert.deepEqual(parseEmbedModes('collapsed notes'),
		{ state: null, chrome: null, alias: 'collapsed notes' });
});

test('setEmbedState adds a keyword to a bare embed', () => {
	assert.equal(setEmbedState('![[Week 3]]', 'collapsed'), '![[Week 3|collapsed]]');
});

test('setEmbedState flips an existing keyword rather than stacking them', () => {
	assert.equal(setEmbedState('![[Week 3|collapsed]]', 'open'), '![[Week 3|open]]');
	assert.equal(setEmbedState('![[Week 3|open]]', 'collapsed'), '![[Week 3|collapsed]]');
});

test('setEmbedState keeps a real alias, and the fragment, and the indent', () => {
	assert.equal(setEmbedState('  ![[Week 3#Readings|Reading list|open]]', 'collapsed'),
		'  ![[Week 3#Readings|Reading list|collapsed]]');
});

test('setEmbedState(null) removes the keyword entirely', () => {
	assert.equal(setEmbedState('![[Week 3|collapsed]]', null), '![[Week 3]]');
	assert.equal(setEmbedState('![[Week 3|Reading|open]]', null), '![[Week 3|Reading]]');
});

test('setEmbedState returns null for a line that is not an embed', () => {
	// How a drifted line number is caught before anything is written.
	assert.equal(setEmbedState('Just some prose.', 'collapsed'), null);
	assert.equal(setEmbedState('[[Week 3]]', 'collapsed'), null); // a link, not an embed
	assert.equal(setEmbedState('![[Week 3]] with trailing prose', 'collapsed'), null);
});

// ---- chrome: how much frame the embed draws ------------------------------

test('quiet and bare are chrome, not state', () => {
	assert.deepEqual(parseEmbedModes('quiet'), { state: null, chrome: 'quiet', alias: null });
	assert.deepEqual(parseEmbedModes('bare'), { state: null, chrome: 'bare', alias: null });
});

test('chrome and state combine, in either order', () => {
	const expected = { state: 'collapsed', chrome: 'quiet', alias: null };
	assert.deepEqual(parseEmbedModes('quiet|collapsed'), expected);
	assert.deepEqual(parseEmbedModes('collapsed|quiet'), expected);
});

test('a title survives in front of both keywords', () => {
	assert.deepEqual(parseEmbedModes('Reading list|quiet|collapsed'),
		{ state: 'collapsed', chrome: 'quiet', alias: 'Reading list' });
});

test('only the TAIL is consumed, so a note really called Bare keeps its title', () => {
	assert.deepEqual(parseEmbedModes('Bare|quiet'),
		{ state: null, chrome: 'quiet', alias: 'Bare' });
});

test('a repeated mode stops the scan — the last wins, the earlier is title', () => {
	assert.deepEqual(parseEmbedModes('quiet|bare'),
		{ state: null, chrome: 'bare', alias: 'quiet' });
});

test('setEmbedState preserves the chrome keyword when it flips the fold', () => {
	assert.equal(setEmbedState('![[Week 3|quiet|collapsed]]', 'open'), '![[Week 3|quiet|open]]');
	assert.equal(setEmbedState('![[Week 3|quiet]]', 'collapsed'), '![[Week 3|quiet|collapsed]]');
});

test('setEmbedState writes keywords canonically as title|chrome|state', () => {
	assert.equal(setEmbedState('![[Week 3|Reading|collapsed|quiet]]', 'open'),
		'![[Week 3|Reading|quiet|open]]');
});

test('the canonical round trip is a fixed point', () => {
	const once = setEmbedState('![[Week 3|Reading|quiet|open]]', 'collapsed');
	assert.equal(once, '![[Week 3|Reading|quiet|collapsed]]');
	assert.equal(setEmbedState(once, 'open'), '![[Week 3|Reading|quiet|open]]');
});
