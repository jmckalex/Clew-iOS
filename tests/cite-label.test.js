// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// live edit's local citation text (src/renderer/editor/live/cite-label.js):
// what a pill reads before, or without, the engine's own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localCiteText } from '../vendor/clew/renderer/editor/live/cite-label.js';

const AK = { label: 'Akerlof and Kranton 2000', authors: 'Akerlof & Kranton', year: '2000' };
const SM = { label: 'Smith et al. 2001', authors: 'Smith et al.', year: '2001' };

test('the label, shaped by the command', () => {
	assert.equal(localCiteText('cite', ['ak'], [AK]), 'Akerlof and Kranton 2000');
	assert.equal(localCiteText('citet', ['ak'], [AK]), 'Akerlof and Kranton 2000');
	assert.equal(localCiteText('citep', ['ak'], [AK]), '(Akerlof and Kranton 2000)');
	assert.equal(localCiteText('citeauthor', ['ak'], [AK]), 'Akerlof and Kranton');
	assert.equal(localCiteText('citeyear', ['ak'], [AK]), '2000');
});

test('several keys, and an unknown one as itself', () => {
	assert.equal(localCiteText('citep', ['ak', 'sm'], [AK, SM]), '(Akerlof and Kranton 2000; Smith et al. 2001)');
	assert.equal(localCiteText('cite', ['nosuchkey'], [null]), 'nosuchkey');
	assert.equal(localCiteText('cite', ['ak', 'gone'], [AK, null]), 'Akerlof and Kranton 2000; gone');
	assert.equal(localCiteText('cite', [], []), '?');
});
