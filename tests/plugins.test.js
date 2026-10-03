// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listPlugins, enabledPlugins, engineExtensionEntries, previewPluginScripts } from '../vendor/clew/main/plugins.js';

function writePlugins(base, plugins) {
	for (const [id, files] of Object.entries(plugins)) {
		const dir = path.join(base, id);
		fs.mkdirSync(dir, { recursive: true });
		for (const [name, content] of Object.entries(files)) {
			fs.writeFileSync(path.join(dir, name), content);
		}
	}
}

function vaultWith(plugins) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-plug-'));
	writePlugins(path.join(root, '.clew', 'plugins'), plugins);
	return root;
}

/** A stand-in for <userData>/plugins/. */
function globalWith(plugins) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-gplug-'));
	writePlugins(dir, plugins);
	return dir;
}

const manifest = (id, surfaces) => JSON.stringify({ id, version: '1.0.0', surfaces });

test('discovers valid plugins, skips broken ones', () => {
	const root = vaultWith({
		good: {
			'manifest.json': JSON.stringify({
				id: 'good', name: 'Good', version: '1.0.0',
				surfaces: { preview: 'p.js', engine: { file: 'e.js', extensions: 'fenceA' } },
			}),
			'p.js': '// p', 'e.js': '// e',
		},
		'bad-id': { 'manifest.json': JSON.stringify({ id: 'mismatch', surfaces: {} }) },
		'no-manifest': { 'p.js': '// orphan' },
		'missing-file': {
			'manifest.json': JSON.stringify({ id: 'missing-file', surfaces: { preview: 'gone.js' } }),
		},
		'too-new': {
			'manifest.json': JSON.stringify({ id: 'too-new', apiVersion: 99, surfaces: {} }),
		},
		escape: {
			'manifest.json': JSON.stringify({ id: 'escape', surfaces: { preview: '../../evil.js' } }),
		},
	});
	const plugins = listPlugins(root);
	assert.deepEqual(plugins.map((p) => p.id).sort(), ['escape', 'good', 'missing-file']);
	const good = plugins.find((p) => p.id === 'good');
	assert.deepEqual(Object.keys(good.surfaces).sort(), ['engine', 'preview']);
	// Path-escaping and missing surface files are dropped, not resolved.
	assert.deepEqual(plugins.find((p) => p.id === 'escape').surfaces, {});
	assert.deepEqual(plugins.find((p) => p.id === 'missing-file').surfaces, {});
	fs.rmSync(root, { recursive: true, force: true });
});

test('enabled subset, engine entries, preview paths', () => {
	const root = vaultWith({
		alpha: {
			'manifest.json': JSON.stringify({
				id: 'alpha', surfaces: { engine: { file: 'e.js', extensions: 'x, y' }, preview: 'p.js' },
			}),
			'e.js': '', 'p.js': '',
		},
		beta: {
			'manifest.json': JSON.stringify({ id: 'beta', surfaces: { preview: 'p.js' } }),
			'p.js': '',
		},
	});
	const settings = { plugins: ['alpha'], trusted: true };
	assert.deepEqual(enabledPlugins(root, settings).map((p) => p.id), ['alpha']);
	// A vault's OWN plugins run only where this device trusts the vault —
	// and an access object without `trusted` is untrusted (fails closed).
	assert.deepEqual(enabledPlugins(root, { plugins: ['alpha'], trusted: false }), []);
	assert.deepEqual(enabledPlugins(root, { plugins: ['alpha'] }), []);
	assert.deepEqual(engineExtensionEntries(root, { plugins: ['alpha'] }), []);
	const entries = engineExtensionEntries(root, settings);
	assert.equal(entries.length, 1);
	assert.ok(entries[0].startsWith('x, y from '));
	assert.ok(entries[0].endsWith('.clew/plugins/alpha/e.js'));
	assert.deepEqual(previewPluginScripts(root, settings).map((p) => p.vaultRel),
		['.clew/plugins/alpha/p.js']);
	assert.deepEqual(previewPluginScripts(root, {}), []);
	fs.rmSync(root, { recursive: true, force: true });
});

test('global plugins are discovered alongside the vault\'s own', () => {
	const root = vaultWith({
		local: { 'manifest.json': manifest('local', { preview: 'p.js' }), 'p.js': '' },
	});
	const globalDir = globalWith({
		shared: { 'manifest.json': manifest('shared', { preview: 'p.js' }), 'p.js': '' },
	});
	const plugins = listPlugins(root, globalDir);
	assert.deepEqual(plugins.map((p) => `${p.id}:${p.scope}`).sort(), ['local:vault', 'shared:global']);
	// Without a global dir, only the vault's own — the old behaviour.
	assert.deepEqual(listPlugins(root).map((p) => p.id), ['local']);
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(globalDir, { recursive: true, force: true });
});

test('installing globally does NOT enable: the vault still opts in', () => {
	const root = vaultWith({});
	const globalDir = globalWith({
		shared: { 'manifest.json': manifest('shared', { preview: 'p.js' }), 'p.js': '' },
	});
	// Present, but nothing runs until vault-settings names it.
	assert.equal(listPlugins(root, globalDir).length, 1);
	assert.deepEqual(enabledPlugins(root, {}, globalDir), []);
	assert.deepEqual(enabledPlugins(root, { plugins: [] }, globalDir), []);
	assert.deepEqual(enabledPlugins(root, { plugins: ['shared'] }, globalDir).map((p) => p.id), ['shared']);
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(globalDir, { recursive: true, force: true });
});

test('a vault plugin shadows a global one of the same id', () => {
	const root = vaultWith({
		dup: { 'manifest.json': manifest('dup', { preview: 'p.js' }), 'p.js': '// vault' },
	});
	const globalDir = globalWith({
		dup: { 'manifest.json': manifest('dup', { preview: 'p.js' }), 'p.js': '// global' },
	});
	const plugins = listPlugins(root, globalDir);
	assert.equal(plugins.length, 1, 'one id is one plugin');
	assert.equal(plugins[0].scope, 'vault', 'the more specific copy wins');
	// The enabled id resolves to the vault copy, so its files are the ones served.
	const [script] = previewPluginScripts(root, { plugins: ['dup'], trusted: true }, globalDir);
	assert.equal(script.vaultRel, '.clew/plugins/dup/p.js');
	assert.equal(fs.readFileSync(path.join(script.dir, script.file), 'utf8'), '// vault');
	// …but only in a trusted vault: an untrusted one cannot replace the
	// user's plugin with its own by naming it — the global copy runs.
	const [untrusted] = previewPluginScripts(root, { plugins: ['dup'], trusted: false }, globalDir);
	assert.equal(untrusted.scope, 'global');
	assert.equal(fs.readFileSync(path.join(untrusted.dir, untrusted.file), 'utf8'), '// global');
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(globalDir, { recursive: true, force: true });
});

test('a global plugin\'s surfaces resolve to its own folder', () => {
	const root = vaultWith({});
	const globalDir = globalWith({
		shared: {
			'manifest.json': manifest('shared', {
				engine: { file: 'e.js', extensions: 'fenceX' }, preview: 'p.js', app: 'a.js',
			}),
			'e.js': '', 'p.js': '', 'a.js': '',
		},
	});
	const settings = { plugins: ['shared'] };
	// Engine extensions are absolute paths into the GLOBAL folder…
	const [entry] = engineExtensionEntries(root, settings, globalDir);
	assert.ok(entry.startsWith('fenceX from '));
	assert.ok(entry.endsWith(path.join(globalDir, 'shared', 'e.js')));
	assert.ok(!entry.includes('.clew/plugins'), 'not resolved against the vault');
	// …and a global preview surface has no vault-relative URL (it is served
	// from the __clew_plugin_file__ namespace instead).
	const [script] = previewPluginScripts(root, settings, globalDir);
	assert.equal(script.scope, 'global');
	assert.equal(script.vaultRel, null);
	assert.equal(script.dir, path.join(globalDir, 'shared'));
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(globalDir, { recursive: true, force: true });
});
