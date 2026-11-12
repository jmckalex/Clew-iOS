// The file explorer's icons on the iPad (Clew-app cd39a81 + cfa279b, the
// owner's ask of 2026-11-12). renderer/lib/file-icons.js asks for
// file-icons/<icon>.svg relative to the app page; scripts/build.js#stageStatic
// copies vendor/material-icons/ there. This reads the built webroot to prove
// every icon the table can name is beside index.html, as the vendored set
// has it, with the set's licence. The lookup itself is Clew-app's
// tests/file-icons.test.js; the explorer in the app is tools/sim-explorer-checks.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE_ICONS } from '../vendor/clew/renderer/lib/file-icons-data.js';
import { fileIconName, folderIconName, fileIconUrl } from '../vendor/clew/renderer/lib/file-icons.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const webroot = path.join(root, 'dist', 'webroot');
const vendored = path.join(root, 'vendor', 'material-icons');

test('every icon the explorer can ask for is beside the app page, byte for byte the vendored set, with its LICENSE', () => {
	assert.ok(fs.existsSync(path.join(webroot, 'index.html')), 'run scripts/build.js first');
	const named = new Set([
		FILE_ICONS.file, FILE_ICONS.folder, FILE_ICONS.folderOpen,
		...Object.values(FILE_ICONS.fileNames), ...Object.values(FILE_ICONS.extensions),
	]);
	const urls = [...named].flatMap((icon) => [fileIconUrl(icon, 'dark'), fileIconUrl(icon, 'light')]);
	const missing = [...new Set(urls)].filter((url) => !fs.existsSync(path.join(webroot, url)));
	assert.deepEqual(missing, [], 'each URL resolved against index.html');
	for (const name of fs.readdirSync(vendored)) {
		assert.ok(fs.readFileSync(path.join(webroot, 'file-icons', name)).equals(fs.readFileSync(path.join(vendored, name))), `${name} as vendored`);
	}
	assert.match(fs.readFileSync(path.join(webroot, 'file-icons', 'LICENSE'), 'utf8'), /MIT License/);
});

test('the kinds the iPad opens get their own icon, and a light page the `_light` variant (the lookup as the app bundles it)', () => {
	assert.equal(fileIconUrl(fileIconName('Sketch.excalidraw.md'), 'dark'), `file-icons/${FILE_ICONS.extensions['excalidraw.md']}.svg`);
	assert.equal(fileIconUrl(fileIconName('page.jinja'), 'light'), 'file-icons/jinja_light.svg');
	assert.equal(fileIconUrl(fileIconName('page.jinja'), 'dark'), 'file-icons/jinja.svg');
	assert.equal(fileIconUrl(folderIconName(true), 'dark'), 'file-icons/folder-open.svg');
	for (const name of ['Note.md', 'Paper.pdf', 'Map.canvas', 'List.base', 'refs.bib', 'Essay.docx', 'a.png', 'clip.ogg']) {
		assert.notEqual(fileIconName(name), FILE_ICONS.file, `${name}: an icon of its own`);
	}
	const bundle = fs.readFileSync(path.join(webroot, 'bundle.js'), 'utf8');
	assert.ok(bundle.includes('file-icons/') && bundle.includes('tree-icon'), 'the app bundle carries the explorer\'s icons');
});
