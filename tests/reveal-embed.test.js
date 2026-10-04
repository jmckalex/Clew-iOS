// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// `@reveal[…]` — a presentation embedded in a note (src/engine/reveal-embed.js).
// The owner's ask, 2026-09-25. Two kinds of target, because presentations
// live in two places: an http(s) URL (what a served, generated deck gives
// you — theirs are index.php behind a local Apache) and a vault path to an
// HTML file or a folder holding index.html. Everything else is refused BY
// NAME rather than embedded blindly.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reveal, resolveTarget, frameStyle, attrsOf } from '../vendor/clew/engine/reveal-embed.js';

// One temp root for this file, removed when it is done: fixtures used to
// be left in the system's temp folder, thousands of them over the runs.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-reveal-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

/** A vault with a couple of decks in it. */
const root = fs.mkdtempSync(path.join(tmpRoot, 'clew-reveal-'));
fs.mkdirSync(path.join(root, 'Talks/intro'), { recursive: true });
fs.writeFileSync(path.join(root, 'Talks/intro/index.html'), '<html>deck</html>');
fs.mkdirSync(path.join(root, 'Talks/generated'), { recursive: true });
fs.writeFileSync(path.join(root, 'Talks/generated/index.php'), '<?php echo "deck"; ?>');
fs.mkdirSync(path.join(root, 'Talks/empty'), { recursive: true });
fs.writeFileSync(path.join(root, 'Talks/loose.html'), '<html>deck</html>');

// reveal.html() reads the vault root from the environment, exactly as it
// does in the render worker (CLEW_VAULT_ROOT, set by render-service.js), so
// the wiring is part of what these tests cover.
const html = (text, attrs) => {
	const saved = process.env.CLEW_VAULT_ROOT;
	process.env.CLEW_VAULT_ROOT = root;
	try { return reveal.html({ rawText: text, attrs }); }
	finally {
		if (saved === undefined) delete process.env.CLEW_VAULT_ROOT;
		else process.env.CLEW_VAULT_ROOT = saved;
	}
};

test('an http(s) URL is embedded as written', () => {
	// The only thing that works for a deck a server generates.
	const url = 'http://localhost:8888/prez/teaching/ph341/voting-theory/';
	assert.deepEqual(resolveTarget(url, root), { src: url });
	assert.match(html(url), /<iframe class="reveal-embed" src="http:\/\/localhost:8888\/prez[^"]*"/);
	assert.deepEqual(resolveTarget('https://example.org/deck/', root), { src: 'https://example.org/deck/' });
});

test('a vault folder means its index.html; a vault file means itself', () => {
	// sitePath() is what puts the session id on the front, so the frame
	// resolves against the preview origin and a site export can relativize it.
	assert.match(resolveTarget('Talks/intro', root).src, /Talks\/intro\/index\.html$/);
	assert.match(resolveTarget('Talks/intro/', root).src, /Talks\/intro\/index\.html$/);
	assert.match(resolveTarget('./Talks/loose.html', root).src, /Talks\/loose\.html$/);
});

test('a deck that needs a server is refused BY NAME, with what to do instead', () => {
	// The owner's own case: index.php served out of the vault would be its
	// source text, which is worse than saying so.
	const folder = resolveTarget('Talks/generated', root);
	assert.match(folder.refusal, /index\.php/);
	assert.match(folder.refusal, /URL your web server gives it/);
	const file = resolveTarget('Talks/generated/index.php', root);
	assert.match(file.refusal, /program rather than a page/);
	assert.match(html('Talks/generated'), /class="clew-embed-refused"/);
});

test('a target that is not there, or is not a page, says which', () => {
	assert.match(resolveTarget('Talks/nope', root).refusal, /found nothing at "Talks\/nope"/);
	assert.match(resolveTarget('Talks/empty', root).refusal, /no index\.html in "Talks\/empty"/);
	assert.match(resolveTarget('', root).refusal, /needs a target/);
});

test('only http(s) — a javascript: or file: URL is refused', () => {
	assert.match(resolveTarget('javascript:alert(1)', root).refusal, /will not embed a javascript: URL/);
	assert.match(resolveTarget('file:///etc/passwd', root).refusal, /will not embed a file: URL/);
	assert.match(resolveTarget('data:text/html,<b>x', root).refusal, /will not embed a data: URL/);
});

test('a path cannot climb out of the vault', () => {
	assert.match(resolveTarget('../../etc', root).refusal, /climbs out of the vault/);
	assert.match(resolveTarget('Talks/../../secrets', root).refusal, /climbs out of the vault/);
});

test('width, height and aspect are the shape of a deck; style is the escape hatch', () => {
	assert.equal(frameStyle({}), 'width: 100%; aspect-ratio: 16/9');
	assert.equal(frameStyle({ width: '80%' }), 'width: 80%; aspect-ratio: 16/9');
	// A height given wins over the aspect: the author asked for a box.
	assert.equal(frameStyle({ height: '520px' }), 'width: 100%; height: 520px');
	assert.equal(frameStyle({ aspect: '4:3' }), 'width: 100%; aspect-ratio: 4/3');
	assert.equal(frameStyle({ style: 'margin: 2em auto;' }), 'width: 100%; aspect-ratio: 16/9; margin: 2em auto');
});

test('the frame carries what a deck needs, and the attributes are escaped', () => {
	const out = html('https://example.org/d/', { height: '400px', class: 'wide', title: 'My "talk"' });
	assert.match(out, /allow="fullscreen"/);           // the deck's own fullscreen control
	assert.match(out, /loading="lazy"/);               // a note full of decks boots none of them
	assert.match(out, /class="reveal-embed wide"/);
	assert.match(out, /style="width: 100%; height: 400px"/);
	assert.match(out, /title="My &quot;talk&quot;"/);
	assert.ok(!out.includes('sandbox'), 'deliberately unsandboxed — see the file header');
});

test("the engine's attribute grammar severs unquoted units; they are glued back", () => {
	// attributes-parser ends an unquoted value at the first non-word
	// character, so `height=300px` reaches a directive as TWO attributes
	// (measured 2026-09-25). Every spelling an author might reach for has
	// to survive that, or `{height=300px}` silently becomes no height at
	// all and the frame collapses to its 150px default — which is exactly
	// what the first run of this feature did.
	assert.deepEqual(attrsOf({ attrs: { height: 300, px: 'px' } }), { height: '300px' });
	assert.deepEqual(attrsOf({ attrs: { width: 80, '%': '%' } }), { width: '80%' });
	assert.deepEqual(attrsOf({ attrs: { aspect: 16, ':9': ':9' } }), { aspect: '16:9' });
	assert.deepEqual(attrsOf({ attrs: { width: 40, em: 'em' } }), { width: '40em' });
	// A quoted value arrives whole and must be left exactly alone.
	assert.deepEqual(attrsOf({ attrs: { height: '300px' } }), { height: '300px' });
	// And a real attribute that merely looks unit-ish is not swallowed: it
	// only counts as an orphan when its value IS its own name.
	assert.deepEqual(attrsOf({ attrs: { height: 300, em: 'stress' } }), { height: '300', em: 'stress' });
});

test('a bare number is pixels, and a severed unit still lands in the CSS', () => {
	assert.equal(frameStyle(attrsOf({ attrs: { height: 300, px: 'px' } })), 'width: 100%; height: 300px');
	assert.equal(frameStyle(attrsOf({ attrs: { height: 300 } })), 'width: 100%; height: 300px');
	assert.equal(frameStyle(attrsOf({ attrs: { width: 800 } })), 'width: 800px; aspect-ratio: 16/9');
	assert.equal(frameStyle(attrsOf({ attrs: { aspect: 16, ':9': ':9' } })), 'width: 100%; aspect-ratio: 16/9');
});

test('attrsOf tolerates whatever the attribute parser hands back', () => {
	assert.deepEqual(attrsOf({ attrs: { Width: '50%' } }), { width: '50%' });
	assert.deepEqual(attrsOf({ attrs: new Map([['HEIGHT', '9']]) }), { height: '9' });
	assert.deepEqual(attrsOf({}), {});
	assert.deepEqual(attrsOf(null), {});
});

test('the handler resolves against the vault root the worker gives it', () => {
	// Not a detail: without this the directive would embed a path that was
	// never checked, and the refusals above would never fire in the app.
	assert.match(html('Talks/intro'), /src="[^"]*Talks\/intro\/index\.html"/);
	assert.match(html('Talks/nope'), /class="clew-embed-refused"/);
});

test('with no vault root at all, a path is passed through rather than refused', () => {
	// The CLI runs the engine without one; a note is not broken by that.
	assert.match(resolveTarget('Talks/intro/index.html', null).src, /Talks\/intro\/index\.html$/);
});
