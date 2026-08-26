// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseYaml, parseBase, compileFilter, runView, renderBase } from '../vendor/clew/engine/bases.js';
import { scanPages, resetCache } from '../vendor/clew/engine/vault-model.js';

// ---- the YAML subset ---------------------------------------------------------

test('nested maps, block sequences and scalars', () => {
	const doc = parseYaml([
		'filters:',
		'  and:',
		'    - rating > 0',
		'    - \'!file.name.contains("Template")\'',
		'formulas:',
		'  Path: file.path',
		'properties:',
		'  note.rating:',
		'    displayName: Rating',
		'views:',
		'  - type: table',
		'    name: Ratings',
		'    order:',
		'      - file.name',
		'      - rating',
		'    limit: 100',
	].join('\n'));

	assert.deepEqual(doc.filters, { and: ['rating > 0', '!file.name.contains("Template")'] });
	assert.deepEqual(doc.formulas, { Path: 'file.path' });
	assert.equal(doc.properties['note.rating'].displayName, 'Rating');
	assert.equal(doc.views.length, 1);
	assert.equal(doc.views[0].type, 'table');
	assert.deepEqual(doc.views[0].order, ['file.name', 'rating']);
	assert.equal(doc.views[0].limit, 100);
});

test('a sequence of maps keeps each item whole', () => {
	// Two views, the second with its own nested filters — the shape that a
	// naive indentation reader flattens into one.
	const doc = parseYaml([
		'views:',
		'  - type: table',
		'    name: All',
		'  - type: cards',
		'    name: Recent',
		'    filters:',
		'      and:',
		'        - last > now() - "60d"',
		'    cardSize: 70',
	].join('\n'));
	assert.equal(doc.views.length, 2);
	assert.deepEqual(doc.views[0], { type: 'table', name: 'All' });
	assert.equal(doc.views[1].name, 'Recent');
	assert.deepEqual(doc.views[1].filters, { and: ['last > now() - "60d"'] });
	assert.equal(doc.views[1].cardSize, 70);
});

test('empty lists and empty strings survive', () => {
	const doc = parseYaml('views:\n  - type: cards\n    order: []\n    imageFit: ""\n');
	assert.deepEqual(doc.views[0].order, []);
	assert.equal(doc.views[0].imageFit, '');
});

// ---- a fixture vault ----------------------------------------------------------

let root;

const NOTES = {
	'Trips/Kyoto.md': '---\nstart: 2024-04-01\nend: 2024-04-10\nloc: "[[Japan]]"\ncategories: "[[Trips]]"\nrating: 4\n---\nA trip.\n',
	'Trips/Lisbon.md': '---\nstart: 2023-06-01\nend: 2023-06-08\nloc: "[[Portugal]]"\ncategories: "[[Trips]]"\nrating: 5\n---\nAnother trip.\n',
	'Trips/Template Trip.md': '---\ncategories: "[[Trips]]"\n---\nA template.\n',
	'Places/Japan.md': '---\nrating: 0\n---\nJapan.\n',
	'Places/Portugal.md': '---\nrating: 2\n---\nPortugal.\n',
	'Notes/Plain.md': 'Nothing special. Links to [[Japan]].\n',
	// The shapes kepano's vault stores coordinates in: a list of two strings,
	// and (for coverage) a single "lat, long" string; one note with none.
	'Spots/Fushimi Inari.md': '---\ncategories: "[[Spots]]"\ncolor: green\ncoordinates:\n  - "34.9689499"\n  - "135.7692576"\n---\nA shrine.\n',
	'Spots/Osaka.md': '---\ncategories: "[[Spots]]"\ncolor: "#ff0000"\ncoordinates: "34.6937, 135.5023"\n---\nA city.\n',
	'Spots/Somewhere.md': '---\ncategories: "[[Spots]]"\n---\nNo coordinates.\n',
};

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-base-'));
	for (const [rel, text] of Object.entries(NOTES)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, text);
	}
	fs.mkdirSync(path.join(root, 'Attachments'), { recursive: true });
	fs.writeFileSync(path.join(root, 'Attachments/photo.png'), 'not really a png');
	process.env.CLEW_VAULT_ROOT = root;
	resetCache();
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
	delete process.env.CLEW_VAULT_ROOT;
	delete global.current_file;
	resetCache();
});

const inside = (rel) => { global.current_file = path.join(root, rel); };
const names = (rows) => rows.map((p) => p.name).sort();

// kepano's Trips.base, near enough verbatim.
const TRIPS_BASE = [
	'filters:',
	'  and:',
	'    - note.categories.contains(link("Trips"))',
	'    - \'!file.name.contains("Template")\'',
	'properties:',
	'  note.start:',
	'    displayName: Start',
	'  file.name:',
	'    displayName: Trip',
	'views:',
	'  - type: table',
	'    name: All trips',
	'    order:',
	'      - file.name',
	'      - start',
	'      - loc',
	'    sort:',
	'      - property: start',
	'        direction: DESC',
	'  - type: table',
	'    name: Location',
	'    filters:',
	'      and:',
	'        - list(loc).contains(this)',
	'    order:',
	'      - file.name',
	'      - start',
].join('\n');

test("kepano's filter shape: a link-valued property containing a link", () => {
	const base = parseBase(TRIPS_BASE);
	inside('Notes/Plain.md');
	const rows = runView(base, base.views[0], scanPages().pages, null);
	// Both trips, and NOT the template — the '!contains' filter must bite.
	assert.deepEqual(names(rows), ['Kyoto', 'Lisbon']);
});

test('a view filter narrows the base filter, and `this` is the embedding note', () => {
	const base = parseBase(TRIPS_BASE);
	const pages = scanPages().pages;
	const japan = pages.find((p) => p.name === 'Japan');
	// Embedded in Japan, the Location view shows only trips whose loc is Japan.
	const rows = runView(base, base.views[1], pages, japan);
	assert.deepEqual(names(rows), ['Kyoto']);

	const portugal = pages.find((p) => p.name === 'Portugal');
	assert.deepEqual(names(runView(base, base.views[1], pages, portugal)), ['Lisbon']);
});

test('SORT direction is honoured', () => {
	const base = parseBase(TRIPS_BASE);
	const rows = runView(base, base.views[0], scanPages().pages, null);
	assert.deepEqual(rows.map((p) => p.name), ['Kyoto', 'Lisbon'], 'start DESC puts 2024 first');
});

test('filters compose and/or/not to any depth', () => {
	const pages = scanPages().pages;
	const ctxRows = (node) => pages.filter((page) => {
		const base = parseBase('filters:\n  and: []\n');
		return runView({ ...base, filters: node }, { type: 'table' }, [page], null).length > 0;
	});
	assert.deepEqual(names(ctxRows('rating > 3')), ['Kyoto', 'Lisbon']);
	assert.deepEqual(names(ctxRows({ or: ['rating > 4', 'file.name.contains("Japan")'] })), ['Japan', 'Lisbon']);
	assert.deepEqual(names(ctxRows({ not: ['rating > 0'] })).includes('Japan'), true);
});

test('formulas compute, and a later one may use an earlier one', () => {
	const base = parseBase([
		'formulas:',
		'  Nights: (date(end) - date(start)).days',
		'  Label: "trip: " + file.name',
		'filters:',
		'  and:',
		'    - \'!formula.Label.isEmpty()\'',
		'views:',
		'  - type: table',
		'    name: T',
		'    order:',
		'      - file.name',
		'      - formula.Label',
	].join('\n'));
	inside('Notes/Plain.md');
	const html = renderBase(base_yaml_of(base), 'T');
	assert.match(html, /trip: Kyoto/);
});

// Round-trips the parsed base back through the renderer via its source text.
function base_yaml_of() {
	return [
		'formulas:',
		'  Label: "trip: " + file.name',
		'filters:',
		'  and:',
		'    - note.categories.contains(link("Trips"))',
		'views:',
		'  - type: table',
		'    name: T',
		'    order:',
		'      - file.name',
		'      - formula.Label',
	].join('\n');
}

test('a formula that references itself does not hang', () => {
	inside('Notes/Plain.md');
	const html = renderBase([
		'formulas:',
		'  Loop: formula.Loop + "x"',
		'views:',
		'  - type: table',
		'    name: T',
		'    order:',
		'      - file.name',
		'      - formula.Loop',
	].join('\n'), 'T');
	assert.match(html, /<table/);
});

test('attachments are rows, which is what an "unused files" base needs', () => {
	inside('Notes/Plain.md');
	const html = renderBase([
		'filters:',
		'  and:',
		'    - \'file.ext.containsAny("png", "jpg")\'',
		'views:',
		'  - type: table',
		'    name: Files',
		'    order:',
		'      - file.name',
		'      - file.ext',
	].join('\n'), 'Files');
	assert.match(html, /photo/, 'a .png is a row even though it is not a note');
});

test('display names from `properties` become the column headings', () => {
	inside('Notes/Plain.md');
	const html = renderBase(TRIPS_BASE, 'All trips');
	assert.match(html, /<th>Trip<\/th>/);
	assert.match(html, /<th>Start<\/th>/);
	assert.match(html, /<th>loc<\/th>/, 'a column with no displayName keeps its own name');
});

test('a named view is selected by name; a missing one says which exist', () => {
	// Inside Japan, because the Location view is `list(loc).contains(this)` —
	// embedded anywhere else it correctly matches nothing.
	inside('Places/Japan.md');
	const located = renderBase(TRIPS_BASE, 'Location');
	assert.match(located, /clew-query-group">Location/);
	assert.match(located, /Kyoto/);
	assert.doesNotMatch(located, /Lisbon/);

	inside('Notes/Plain.md');
	const missing = renderBase(TRIPS_BASE, 'Nonexistent');
	assert.match(missing, /no view called/);
	assert.match(missing, /All trips, Location/);
});

test('a view type Clew cannot draw is refused, not approximated', () => {
	inside('Notes/Plain.md');
	const html = renderBase('views:\n  - type: chart\n    name: M\n', 'M');
	assert.match(html, /does not render &quot;chart&quot;/);
	assert.doesNotMatch(html, /<table/);
});

// kepano's Map.base, near enough: coordinates property, zoom, marker colors.
const MAP_BASE = [
	'filters:',
	'  and:',
	'    - note.categories.contains(link("Spots"))',
	'views:',
	'  - type: map',
	'    name: Map',
	'    coordinates: note.coordinates',
	'    defaultZoom: 10.6',
	'    markerColor: note.color',
].join('\n');

test('map views become the leaflet placeholder, one marker per located row', () => {
	inside('Notes/Plain.md');
	const html = renderBase(MAP_BASE, 'Map');
	assert.match(html, /<div class="clew-leaflet" data-leaflet="/);
	const config = JSON.parse(/data-leaflet="([^"]*)"/.exec(html)[1]
		.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&amp;/g, '&'));
	assert.equal(config.noteMarkers.length, 2); // Somewhere has no coordinates
	assert.equal(config.zoom, 10.6);
	const fushimi = config.noteMarkers.find((m) => m.label === 'Fushimi Inari');
	assert.equal(fushimi.lat, 34.9689499);
	assert.equal(fushimi.long, 135.7692576);
	assert.equal(fushimi.link, 'Spots/Fushimi Inari.md');
	assert.equal(fushimi.type, 'green'); // a NAMED color tints the pin…
	const osaka = config.noteMarkers.find((m) => m.label === 'Osaka');
	assert.equal(osaka.lat, 34.6937); // …the "lat, long" string form parses…
	assert.equal(osaka.type, undefined); // …and a hex color falls back to the default pin
});

test('a map whose rows have no coordinates says so instead of drawing', () => {
	inside('Notes/Plain.md');
	const html = renderBase([
		'filters:',
		'  and:',
		'    - note.categories.contains(link("Trips"))',
		'views:',
		'  - type: map',
		'    name: M',
	].join('\n'), 'M');
	assert.match(html, /No rows in this view carry coordinates/);
	assert.doesNotMatch(html, /clew-leaflet/);
});

test('card views render cards, with the image the view names', () => {
	inside('Notes/Plain.md');
	const html = renderBase([
		'views:',
		'  - type: cards',
		'    name: Gallery',
		'    cardSize: 70',
		'    image: file.file',
		'    filters:',
		'      and:',
		'        - \'file.ext.containsAny("png")\'',
	].join('\n'), 'Gallery');
	assert.match(html, /class="clew-cards"/);
	assert.match(html, /--clew-card-size: 70px/);
	assert.match(html, /<img class="clew-card-image"[^>]*Attachments\/photo\.png/);
});

test('a base column over a real stored field stays editable', () => {
	inside('Notes/Plain.md');
	const html = renderBase([
		'views:',
		'  - type: table',
		'    name: T',
		'    order:',
		'      - file.name',
		'      - note.rating',
	].join('\n'), 'T');
	assert.match(html, /data-edit-field="rating"/);
	assert.doesNotMatch(html, /data-edit-field="name"/, 'file.* is computed, not stored');
});
