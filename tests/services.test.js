// M2: the iOS services layer (window.clew channels over the vault mirror
// and vendored upstream services) against a real on-disk vault via a fake
// native bridge. Rendering is faked here — M1's engine tests cover it.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ---- fake native bridge over a temp copy of the seed vault ----------------

const TEXT_EXT = /\.(md|jmd|bib|canvas|json|css|js|txt)$/i;
let vaultDir;

const listFiles = (dir, rel = '') => {
	const out = {};
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === '.DS_Store' || entry.name === '.git') continue;
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) Object.assign(out, listFiles(abs, childRel));
		else {
			const stat = fs.statSync(abs);
			out[childRel] = TEXT_EXT.test(entry.name)
				? { text: fs.readFileSync(abs, 'utf8'), size: stat.size, mtimeMs: stat.mtimeMs }
				: { size: stat.size, mtimeMs: stat.mtimeMs };
		}
	}
	return out;
};

const fakeBridge = {
	calls: [],
	async call(method, params) {
		this.calls.push([method, params]);
		switch (method) {
			case 'vaultBootstrap': return { path: vaultDir };
			case 'vaultOpen':
				return { name: path.basename(params.path), path: params.path, files: listFiles(params.path) };
			case 'write': {
				const abs = path.join(params.vault, params.rel);
				fs.mkdirSync(path.dirname(abs), { recursive: true });
				fs.writeFileSync(abs, params.text);
				return null;
			}
			case 'mkdir':
				fs.mkdirSync(path.join(params.vault, params.rel), { recursive: true });
				return null;
			case 'rename': {
				const to = path.join(params.vault, params.newRel);
				fs.mkdirSync(path.dirname(to), { recursive: true });
				fs.renameSync(path.join(params.vault, params.rel), to);
				return null;
			}
			case 'trash':
				fs.rmSync(path.join(params.vault, params.rel), { recursive: true, force: true });
				return null;
			// Overwrite-in-place, like VaultStore.updateBinary: never creates,
			// never dedupes a name. The shim's own guards are what the tests
			// below exercise, but this mirrors the native refusal too.
			case 'updateBinary': {
				const abs = path.join(vaultDir, params.rel);
				if (!fs.existsSync(abs)) throw new Error(`No such file: ${params.rel}`);
				fs.writeFileSync(abs, Buffer.from(params.base64, 'base64'));
				return null;
			}
			default:
				return null;
		}
	},
};

// A worker that answers ready + fake html (real rendering is M1-tested).
// Build messages are recorded so tests can assert on their payloads.
const workerBuilds = [];
const fakeWorkerFactory = () => {
	const worker = {
		onmessage: null,
		onerror: null,
		postMessage(msg) {
			if (msg.type === 'build') workerBuilds.push(msg);
			queueMicrotask(() => {
				if (msg.type === 'init') worker.onmessage?.({ data: { type: 'ready' } });
				if (msg.type === 'build') worker.onmessage?.({ data: { type: 'done', output: msg.options.output, html: '<html>fake</html>' } });
			});
		},
		terminate() {},
	};
	return worker;
};

const CH = {
	VAULT_CURRENT: 'clew:vault-current',
	VAULT_TREE: 'clew:vault-tree',
	INDEX_GET: 'clew:index-get',
	SEARCH: 'clew:search',
	NOTE_READ: 'clew:note-read',
	NOTE_WRITE: 'clew:note-write',
	NOTE_CREATE: 'clew:note-create',
	FS_RENAME: 'clew:fs-rename',
	KV_SET: 'clew:kv-set',
	KV_GET: 'clew:kv-get',
	BIB_ENTRIES: 'clew:bib-entries',
	WORKSPACE_SAVE: 'clew:workspace-save',
	WORKSPACE_LOAD: 'clew:workspace-load',
	PDF_WRITE: 'clew:pdf-write',
	PDF_FONTS_STATUS: 'clew:pdf-fonts-status',
	PDF_FONTS_DOWNLOAD: 'clew:pdf-fonts-download',
	EXCALIDRAW_LIB_GET: 'clew:excalidraw-lib-get',
	EXCALIDRAW_LIB_SET: 'clew:excalidraw-lib-set',
};

// A byte-for-byte valid, one-page PDF — small enough to inline, real enough
// that "we wrote a PDF" means something.
const MINIMAL_PDF = Buffer.from(
	'%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
	+ '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
	+ '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 99 99]>>endobj\n'
	+ 'trailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');

let clew, native, services;
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

before(async () => {
	vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-ios-test-'));
	fs.cpSync(path.join(root, 'seed-vault'), vaultDir, { recursive: true });
	// A PDF for the annotation-save path, in place before the vault opens so
	// the mirror carries it as a binary stub, exactly as a real one would be.
	fs.mkdirSync(path.join(vaultDir, 'Attachments'), { recursive: true });
	fs.writeFileSync(path.join(vaultDir, 'Attachments', 'Paper.pdf'), MINIMAL_PDF);
	globalThis.__clewBridgeImpl = fakeBridge;
	const { createClewShim } = await import(path.join(root, 'dist', 'test', 'services.js'));
	({ clew, native, services } = createClewShim({
		workerFactory: fakeWorkerFactory,
		assetLoader: async () => '',
	}));
	globalThis.window ??= globalThis; // renderer-free environment
});

test('vault auto-opens through the bridge and reports info', async () => {
	const vault = await clew.invoke(CH.VAULT_CURRENT);
	assert.equal(vault.name, path.basename(vaultDir));
	assert.equal(vault.sessionId, 's1');
});

test('tree walks the mirror (folders first, alphabetical)', async () => {
	const tree = await clew.invoke(CH.VAULT_TREE);
	const names = tree.map((e) => e.name);
	assert.ok(names.includes('Welcome.md'));
	assert.ok(names.includes('Guide'));
	assert.equal(tree[0].type, 'folder');
});

test('indexer resolves wikilinks across the vault', async () => {
	const index = await clew.invoke(CH.INDEX_GET);
	const welcome = index.notes['Welcome.md'];
	assert.ok(welcome, 'Welcome.md indexed');
	const resolved = welcome.links.filter((l) => l.resolved);
	assert.ok(resolved.length > 5, `resolved links: ${resolved.length}`);
});

test('search finds content with line-level matches', async () => {
	const results = await clew.invoke(CH.SEARCH, { query: 'wikilink' });
	assert.ok(results.length > 0);
	assert.ok(results[0].matches.length > 0);
	assert.ok(typeof results[0].matches[0].line === 'number');
});

test('note write persists through the bridge to disk', async () => {
	await clew.invoke(CH.NOTE_WRITE, { path: 'Inbox.md', content: '# Edited on iOS\n' });
	await native.flush();
	assert.equal(fs.readFileSync(path.join(vaultDir, 'Inbox.md'), 'utf8'), '# Edited on iOS\n');
});

test('note create dedupes names', async () => {
	const first = await clew.invoke(CH.NOTE_CREATE, { path: 'Fresh.md' });
	const second = await clew.invoke(CH.NOTE_CREATE, { path: 'Fresh.md' });
	assert.equal(first, 'Fresh.md');
	assert.equal(second, 'Fresh 1.md');
	await native.flush();
	assert.ok(fs.existsSync(path.join(vaultDir, 'Fresh 1.md')));
});

test('rename propagates wikilinks and lands on disk', async () => {
	await settle();
	const result = await clew.invoke(CH.FS_RENAME, { path: 'Guide/Editing.md', newPath: 'Guide/Editing Notes.md' });
	assert.ok(result.rewrittenLinks > 0, `rewrote ${result.rewrittenLinks} links`);
	await native.flush();
	assert.ok(fs.existsSync(path.join(vaultDir, 'Guide', 'Editing Notes.md')));
	assert.ok(!fs.existsSync(path.join(vaultDir, 'Guide', 'Editing.md')));
	// Some note now links to the new name.
	const changed = fakeBridge.calls
		.filter(([m, p]) => m === 'write' && p.text.includes('[[Editing Notes'));
	assert.ok(changed.length > 0, 'a linking note was rewritten on disk');
});

test('kv store round-trips and lands in clewdata.json', async () => {
	await clew.invoke(CH.KV_SET, { key: 'test/answer', value: 42 });
	assert.equal(await clew.invoke(CH.KV_GET, { key: 'test/answer' }), 42);
	await new Promise((resolve) => setTimeout(resolve, 400)); // kv debounce
	await native.flush();
	const data = JSON.parse(fs.readFileSync(path.join(vaultDir, 'clewdata.json'), 'utf8'));
	assert.equal(data['test/answer'], 42);
});

test('bib entries surface for citation completion', async () => {
	const entries = await clew.invoke(CH.BIB_ENTRIES);
	assert.ok(Array.isArray(entries));
	// The demo vault ships references.bib; if present, entries have keys.
	if (entries.length) assert.ok(entries[0].key);
});

test('workspace state round-trips via .clew', async () => {
	await clew.invoke(CH.WORKSPACE_SAVE, { layout: { probe: true } });
	const loaded = await clew.invoke(CH.WORKSPACE_LOAD);
	assert.deepEqual(loaded, { layout: { probe: true } });
	await native.flush();
	assert.ok(fs.existsSync(path.join(vaultDir, '.clew', 'workspace.json')));
});

test('rendered html comes back through the render service', async () => {
	const html = await native.renderNote('Welcome.md');
	assert.equal(html, '<html>fake</html>');
	void services;
});

// ---- upstream 0.8 channels the iOS shim had to supply ---------------------

test('pdf write overwrites an existing PDF in place', async () => {
	const annotated = Buffer.concat([MINIMAL_PDF, Buffer.from('\n% annotated\n')]);
	const result = await clew.invoke(CH.PDF_WRITE, {
		path: 'Attachments/Paper.pdf',
		bytes: new Uint8Array(annotated),
	});
	assert.equal(result, true);
	const onDisk = fs.readFileSync(path.join(vaultDir, 'Attachments', 'Paper.pdf'));
	assert.ok(onDisk.equals(annotated), 'the annotated bytes reached the vault file');
});

test('pdf write refuses anything that is not an existing vault PDF', async () => {
	const bytes = new Uint8Array(MINIMAL_PDF);
	// This channel is reachable from a PREVIEW document, which renders
	// vault-authored content — so its narrowness is the security argument.
	// Each of these must throw, not quietly create a file.
	await assert.rejects(
		() => clew.invoke(CH.PDF_WRITE, { path: 'Notes/Secret.md', bytes }),
		/Not a PDF/, 'non-PDF extension');
	await assert.rejects(
		() => clew.invoke(CH.PDF_WRITE, { path: '../Escape.pdf', bytes }),
		/Bad PDF path/, 'parent-directory segment');
	await assert.rejects(
		() => clew.invoke(CH.PDF_WRITE, { path: 'Attachments/Nope.pdf', bytes }),
		/No such PDF/, 'never creates a file that does not exist');
	await assert.rejects(
		() => clew.invoke(CH.PDF_WRITE, { path: 'Attachments/Paper.pdf', bytes: new Uint8Array(0) }),
		/Empty PDF payload/, 'empty payload');
	assert.ok(!fs.existsSync(path.join(vaultDir, 'Attachments', 'Nope.pdf')));
});

test('excalidraw shape library round-trips per vault', async () => {
	assert.deepEqual(await clew.invoke(CH.EXCALIDRAW_LIB_GET), []);
	const items = [{ id: 'lib-1', status: 'published', elements: [] }];
	assert.equal(await clew.invoke(CH.EXCALIDRAW_LIB_SET, { items }), true);
	assert.deepEqual(await clew.invoke(CH.EXCALIDRAW_LIB_GET), items);
	await native.flush();
	assert.ok(fs.existsSync(path.join(vaultDir, '.clew', 'excalidraw-library.json')));
});

test('CJK PDF fonts answer honestly instead of failing as unknown channels', async () => {
	const status = await clew.invoke(CH.PDF_FONTS_STATUS);
	assert.equal(status.installed, false);
	assert.equal(status.downloading, false);
	assert.deepEqual(status.packs, []);
	await assert.rejects(() => clew.invoke(CH.PDF_FONTS_DOWNLOAD), /not available on iOS/);
});

test('builds carry the CURRENT vault, not the standby snapshot', async () => {
	// Regression: standbys spawn with a warmup snapshot that predates recent
	// edits; the build message itself must resend fresh content (type in the
	// editor → toggle reading → the new text must render).
	await native.renderNote('Welcome.md'); // ensure at least one standby cycle
	await clew.invoke(CH.NOTE_WRITE, { path: 'Welcome.md', content: '# Freshness marker\n' });
	workerBuilds.length = 0;
	await native.renderNote('Welcome.md');
	const build = workerBuilds.find((b) => b.file.endsWith('Welcome.md'));
	assert.ok(build, 'a build ran for the edited note');
	assert.equal(build.replaceVault, true);
	assert.match(String(build.files['/vault/Welcome.md']?.data ?? ''), /Freshness marker/);
});
