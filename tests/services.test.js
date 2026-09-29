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
// The global plugin folder (Documents/Plugins on the device), snapshotted
// by the bridge beside the vault at open — see VaultStore.openVault.
let globalDir;

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

// The contract's atomic shape, exactly as VaultStore's AtomicFile produces
// it on the device: a FIXED dot-temp beside the target, then a rename —
// so the suite can assert that no write path ever leaves a `.clew-tmp`
// behind, and that the JS side never asks the bridge to write one.
const writeAtomic = (abs, data) => {
	const temp = path.join(path.dirname(abs), `.${path.basename(abs)}.clew-tmp`);
	fs.writeFileSync(temp, data);
	fs.renameSync(temp, abs);
};

// The session the fake native side minted last (sid + caller token).
let fakeOpens = 0;
let fakeSession = null;
const fakeBridge = {
	calls: [],
	async call(method, params) {
		this.calls.push([method, params]);
		switch (method) {
			case 'vaultBootstrap': return { path: vaultDir };
			case 'vaultOpen':
				// A new session per opening, as VaultStore.swift#newSession.
				fakeSession = { sessionId: `s${(++fakeOpens).toString(16).padStart(32, '0')}`, callerToken: 'ab'.repeat(32) };
				return {
					...fakeSession,
					name: path.basename(params.path), path: params.path, files: listFiles(params.path),
					...(globalDir && fs.existsSync(globalDir)
						? { globalPlugins: { path: globalDir, files: listFiles(globalDir) } } : {}),
				};
			case 'revealGlobalPlugins':
				fs.mkdirSync(globalDir, { recursive: true });
				return { path: globalDir };
			case 'printPdf':
				return { bytes: 1234 };
			case 'noteFonts':
				// What NoteFonts.swift answers once the four faces are built.
				return { family: 'Avenir Next', dir: '/fake/notefonts', faces: {
					Regular: 'NoteFont-Regular.ttf', Bold: 'NoteFont-Bold.ttf',
					Italic: 'NoteFont-Italic.ttf', BoldItalic: 'NoteFont-BoldItalic.ttf',
				} };
			case 'write': {
				const abs = path.join(params.vault, params.rel);
				fs.mkdirSync(path.dirname(abs), { recursive: true });
				writeAtomic(abs, params.text);
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
			case 'setMtime': {
				const date = new Date(params.mtimeMs);
				fs.utimesSync(path.join(params.vault, params.rel), date, date);
				return null;
			}
			case 'quickLook':
				return null;
			case 'officeThumbnail':
				return { ok: false, reason: 'no Quick Look under Node' };
			case 'demoVaultPath':
				return { path: vaultDir };
			case 'createVault': {
				const dir = path.join(os.tmpdir(), `clew-ios-test-created-${process.pid}`, 'My Vault');
				fs.mkdirSync(dir, { recursive: true });
				return { path: dir };
			}
			case 'remove':
				// VaultStore.remove's refusal: only history pruning hard-deletes.
				if (!params.rel.startsWith('.clew/history/')) throw new Error(`Refused: ${params.rel}`);
				fs.rmSync(path.join(params.vault, params.rel), { recursive: true, force: true });
				return null;
			// Overwrite-in-place, like VaultStore.updateBinary: never creates,
			// never dedupes a name. The shim's own guards are what the tests
			// below exercise, but this mirrors the native refusal too.
			case 'updateBinary': {
				const abs = path.join(vaultDir, params.rel);
				if (!fs.existsSync(abs)) throw new Error(`No such file: ${params.rel}`);
				writeAtomic(abs, Buffer.from(params.base64, 'base64'));
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
const workerInits = [];
const fakeWorkerFactory = () => {
	const worker = {
		onmessage: null,
		onerror: null,
		postMessage(msg) {
			if (msg.type === 'build') workerBuilds.push(msg);
			if (msg.type === 'init') workerInits.push(msg);
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
	VAULT_SETTINGS_SET: 'clew:vault-settings-set',
	HISTORY_LIST: 'clew:history-list',
	HISTORY_READ: 'clew:history-read',
	HISTORY_RESTORE: 'clew:history-restore',
	OFFICE_ENGINE_STATUS: 'clew:office-engine-status',
	OFFICE_ENGINE_DOWNLOAD: 'clew:office-engine-download',
	OFFICE_SLOT_ACQUIRE: 'clew:office-slot-acquire',
	OFFICE_WRITE: 'clew:office-write',
	OFFICE_OPEN_EXTERNAL: 'clew:office-open-external',
	OFFICE_THUMBNAIL: 'clew:office-thumbnail',
	CONFIRM_DISCARD: 'clew:confirm-discard',
	VAULT_CREATE_DIALOG: 'clew:vault-create-dialog',
	VAULT_OPEN_DEMO: 'clew:vault-open-demo',
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
// A note whose disk mtime is well in the past when the vault opens, so the
// history tests can see the interval gate and the content-time stamp.
const BACKDATED_NOTE = 'Colosseum.md';
const backdatedMs = Date.now() - 90 * 60_000;

before(async () => {
	vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-ios-test-'));
	fs.cpSync(path.join(root, 'seed-vault'), vaultDir, { recursive: true });
	fs.utimesSync(path.join(vaultDir, BACKDATED_NOTE), new Date(backdatedMs), new Date(backdatedMs));
	// A PDF for the annotation-save path, in place before the vault opens so
	// the mirror carries it as a binary stub, exactly as a real one would be.
	fs.mkdirSync(path.join(vaultDir, 'Attachments'), { recursive: true });
	fs.writeFileSync(path.join(vaultDir, 'Attachments', 'Paper.pdf'), MINIMAL_PDF);
	// Two global plugins: one of its own, and a decoy sharing the id of a
	// vault plugin (the vault's must win).
	globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-ios-test-global-'));
	for (const [id, name] of [['hello-global', 'Hello Global'], ['header', 'Header (global decoy)']]) {
		const dir = path.join(globalDir, id);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
			id, name, version: '1.0.0', apiVersion: 1,
			surfaces: { engine: { file: 'engine.js', extensions: 'helloFence' }, preview: 'preview.js' },
		}));
		fs.writeFileSync(path.join(dir, 'engine.js'), 'export const helloFence = { name: "helloFence", level: "block" };\n');
		fs.writeFileSync(path.join(dir, 'preview.js'), 'document.body.dataset.helloGlobal = "loaded";\n');
	}
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
	assert.equal(vault.sessionId, fakeSession.sessionId, 'the sid the native side minted');
});

test('caller token: VAULT_CURRENT and the vault-opened event carry it; the open handlers\' answers and `info` do not', async () => {
	const current = await clew.invoke(CH.VAULT_CURRENT);
	assert.equal(current.callerToken, fakeSession.callerToken, 'the app page\'s own vault, token included');
	let opened = null;
	const off = clew.on('clew:ev-vault-opened', (payload) => { opened = payload; });
	const answer = await clew.invoke('clew:vault-open-path', { path: vaultDir });
	await new Promise((r) => setTimeout(r, 10));
	off?.();
	assert.ok(opened, 'the vault-opened event fired');
	assert.equal(opened.vault.callerToken, fakeSession.callerToken, 'an in-app vault switch hands the renderer the NEW token');
	assert.equal(opened.vault.sessionId, fakeSession.sessionId, 'and the new sid');
	assert.equal(answer?.callerToken, undefined, 'the open handler answers with info, never the token');
	assert.equal(services.vaults.info.callerToken, undefined, '`info` never holds it');
	assert.equal(native.sessionId, fakeSession.sessionId, '__clewNative.sessionId follows the session');
	assert.equal(services.renderService.sessionId, fakeSession.sessionId, 'the render service writes the new sid into preview URLs');
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
	// rename-links.js#rewriteCanvasRefs consults `vaults.excludes.isUnindexed`
	// (upstream 1747269) on every walk that meets a .canvas — without the
	// excludes on the shim VaultManager this rename THROWS. The demo vault
	// ships one, so this test is also that guard.
	assert.ok(fs.existsSync(path.join(vaultDir, 'Projects', 'Demo Canvas.canvas')), 'a canvas is present');
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

// ---- on-disk contracts shared with desktop --------------------------------

test('atomic writes: no .clew-tmp survives, and none is ever requested', async () => {
	await clew.invoke(CH.NOTE_WRITE, { path: 'Inbox.md', content: '# Written again\n' });
	await native.flush();
	const temps = [];
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(abs);
			else if (entry.name.endsWith('.clew-tmp')) temps.push(path.relative(vaultDir, abs));
		}
	};
	walk(vaultDir);
	assert.deepEqual(temps, [], 'every bridge write renamed its temp into place');
	const requested = fakeBridge.calls.filter(([m, p]) => m === 'write' && /\.clew-tmp$/.test(p.rel));
	assert.deepEqual(requested, [], 'the mirror never sends a temp path to the bridge');
	// The vendored modules (kv-store here) save through upstream's
	// writeFileAtomic — temp + rename inside the mirror — and that must
	// collapse to ONE bridge write of the target: Swift's AtomicFile already
	// gives every write that shape, and a temp must never leave the mirror.
	const mark = fakeBridge.calls.length;
	await clew.invoke(CH.KV_SET, { key: 'test/atomic', value: 'through writeFileAtomic' });
	await new Promise((resolve) => setTimeout(resolve, 400)); // kv debounce
	await native.flush();
	const since = fakeBridge.calls.slice(mark);
	const kvWrites = since.filter(([m, p]) => m === 'write' && p.rel === 'clewdata.json');
	assert.equal(kvWrites.length, 1, 'exactly one bridge write of the target');
	assert.match(kvWrites[0][1].text, /through writeFileAtomic/, 'carrying the committed bytes as text');
	assert.deepEqual(since.filter(([m]) => m === 'rename'), [], 'the temp→target rename never reaches the bridge');
	assert.equal(JSON.parse(fs.readFileSync(path.join(vaultDir, 'clewdata.json'), 'utf8'))['test/atomic'],
		'through writeFileAtomic');
});

const historyDir = (rel) => path.join(vaultDir, '.clew', 'history', rel);

test('history: overwriting a note snapshots the pre-image, stamped with its content time', async () => {
	const original = fs.readFileSync(path.join(vaultDir, BACKDATED_NOTE), 'utf8');
	await clew.invoke(CH.NOTE_WRITE, { path: BACKDATED_NOTE, content: original + '\nEdited on iOS.\n' });
	await native.flush();
	const names = fs.readdirSync(historyDir(BACKDATED_NOTE));
	assert.equal(names.length, 1);
	assert.match(names[0], /^\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.md$/, "upstream's stamp shape");
	assert.equal(fs.readFileSync(path.join(historyDir(BACKDATED_NOTE), names[0]), 'utf8'), original,
		'the PRE-write content, byte for byte');
	const mtime = fs.statSync(path.join(historyDir(BACKDATED_NOTE), names[0])).mtimeMs;
	assert.ok(Math.abs(mtime - backdatedMs) < 2000, `stamped for the content time on disk (${mtime} vs ${backdatedMs})`);
	const listed = await clew.invoke(CH.HISTORY_LIST, { path: BACKDATED_NOTE });
	assert.equal(listed.length, 1);
	assert.equal(listed[0].id, names[0]);
	assert.equal(await clew.invoke(CH.HISTORY_READ, { path: BACKDATED_NOTE, id: listed[0].id }), original);
});

test('history: restore writes the snapshot back and keeps what it displaced', async () => {
	const [snap] = await clew.invoke(CH.HISTORY_LIST, { path: BACKDATED_NOTE });
	const original = await clew.invoke(CH.HISTORY_READ, { path: BACKDATED_NOTE, id: snap.id });
	await clew.invoke(CH.HISTORY_RESTORE, { path: BACKDATED_NOTE, id: snap.id });
	await native.flush();
	assert.equal(fs.readFileSync(path.join(vaultDir, BACKDATED_NOTE), 'utf8'), original, 'restored on disk');
	const listed = await clew.invoke(CH.HISTORY_LIST, { path: BACKDATED_NOTE });
	assert.equal(listed.length, 2, 'the displaced edit was snapshotted despite the interval (force)');
	assert.match(await clew.invoke(CH.HISTORY_READ, { path: BACKDATED_NOTE, id: listed[0].id }), /Edited on iOS/);
	await assert.rejects(() => clew.invoke(CH.HISTORY_READ, { path: BACKDATED_NOTE, id: '../../Welcome.md' }),
		/Not a snapshot id/);
});

test('history: a rename carries the snapshots along', async () => {
	const moved = 'Projects/Colosseum Notes.md';
	await clew.invoke(CH.FS_RENAME, { path: BACKDATED_NOTE, newPath: moved });
	await native.flush();
	assert.ok(!fs.existsSync(historyDir(BACKDATED_NOTE)), 'old history directory gone');
	assert.equal(fs.readdirSync(historyDir(moved)).length, 2, 'both snapshots under the new name');
	assert.equal((await clew.invoke(CH.HISTORY_LIST, { path: moved })).length, 2);
});

test('history: pruning removes old snapshots from disk, never the newest', async () => {
	const rel = 'Projects/Colosseum Notes.md';
	await clew.invoke(CH.VAULT_SETTINGS_SET, { key: 'history', value: { minIntervalMinutes: 0, maxVersions: 2 } });
	for (const n of [1, 2, 3]) {
		await clew.invoke(CH.NOTE_WRITE, { path: rel, content: `version ${n}\n` });
	}
	await native.flush();
	assert.equal(fs.readdirSync(historyDir(rel)).length, 2, 'count cap enforced on disk');
	// Three saves inside one second share a stamp and differ by counter;
	// since upstream 0d17da7 a new snapshot takes the counter after the
	// highest, so the listing (newest first) tracks recency within the
	// second too.
	const listed = await clew.invoke(CH.HISTORY_LIST, { path: rel });
	const survivors = await Promise.all(listed.map((s) => clew.invoke(CH.HISTORY_READ, { path: rel, id: s.id })));
	assert.deepEqual(survivors, ['version 2\n', 'version 1\n'], 'the two most recent pre-images, newest first; the rest pruned');
	const removes = fakeBridge.calls.filter(([m]) => m === 'remove');
	assert.ok(removes.length >= 3, `pruning reached the bridge (${removes.length} removes)`);
	assert.ok(removes.every(([, p]) => p.rel.startsWith('.clew/history/')), 'only ever history paths');
});

test('history: false in vault-settings disables snapshots', async () => {
	const rel = 'Projects/Colosseum Notes.md';
	await clew.invoke(CH.VAULT_SETTINGS_SET, { key: 'history', value: false });
	const before = fs.readdirSync(historyDir(rel));
	await clew.invoke(CH.NOTE_WRITE, { path: rel, content: 'version 4\n' });
	await native.flush();
	assert.deepEqual(fs.readdirSync(historyDir(rel)), before, 'nothing new on disk');
	assert.equal(fs.readFileSync(path.join(vaultDir, rel), 'utf8'), 'version 4\n', 'the write itself still landed');
});

// ---- upstream 0.10: the office surfaces, without the office engine -------

test('office: the engine reports not installed and every office channel answers', async () => {
	const status = await clew.invoke(CH.OFFICE_ENGINE_STATUS);
	assert.equal(status.installed, false);
	assert.equal(status.downloading, false);
	assert.equal(status.soffice, false, 'no desktop LibreOffice rung either');
	await assert.rejects(() => clew.invoke(CH.OFFICE_ENGINE_DOWNLOAD), /not available on iOS/);
	await assert.rejects(() => clew.invoke(CH.OFFICE_WRITE, { path: 'Doc.docx', bytes: new Uint8Array(1) }),
		/read-only on iOS/);
	assert.deepEqual(await clew.invoke(CH.OFFICE_SLOT_ACQUIRE, { tabId: 't1', path: 'Doc.docx' }),
		{ ok: false, path: null });
	assert.equal(await clew.invoke(CH.CONFIRM_DISCARD, { message: 'Unsaved changes' }), 'cancel');
});

test('office: open-externally is Quick Look and thumbnails come from the bridge, both narrow', async () => {
	// A document that arrived from outside (Files app): the rescan diff
	// carries binaries as size-only stubs, exactly as the device does.
	fs.writeFileSync(path.join(vaultDir, 'Attachments', 'Memo.docx'), 'not really a docx');
	native.externalDiff({ changed: { 'Attachments/Memo.docx': { size: 17, mtimeMs: Date.now() } }, removed: [] });
	await clew.invoke(CH.OFFICE_OPEN_EXTERNAL, { path: 'Attachments/Memo.docx' });
	await settle();
	assert.ok(fakeBridge.calls.some(([m, p]) => m === 'quickLook' && p.rel === 'Attachments/Memo.docx'),
		'Quick Look was asked for the document');
	await assert.rejects(() => clew.invoke(CH.OFFICE_OPEN_EXTERNAL, { path: 'Welcome.md' }), /Not an office document/);
	await assert.rejects(() => clew.invoke(CH.OFFICE_THUMBNAIL, { path: '../Escape.docx' }), /Bad office path/);
	assert.deepEqual(await clew.invoke(CH.OFFICE_THUMBNAIL, { path: 'Attachments/Nope.docx' }),
		{ ok: false, reason: 'missing document' }, 'never asks native for a file the mirror lacks');
	const thumb = await clew.invoke(CH.OFFICE_THUMBNAIL, { path: 'Attachments/Memo.docx' });
	assert.equal(thumb.ok, false);
	assert.match(thumb.reason, /Quick Look/, "the bridge's answer passes through");
	assert.ok(fakeBridge.calls.some(([m, p]) => m === 'officeThumbnail' && p.rel === 'Attachments/Memo.docx'));
});

// Last: these swap the open vault.
test('first-run: create-vault and open-demo go through the bridge and open the result', async () => {
	const created = await clew.invoke(CH.VAULT_CREATE_DIALOG);
	assert.equal(created.name, 'My Vault');
	assert.ok(fs.existsSync(created.path), 'the folder exists on disk');
	const demo = await clew.invoke(CH.VAULT_OPEN_DEMO);
	assert.equal(demo.path, vaultDir);
	assert.equal(demo.name, path.basename(vaultDir));
});

// ---- 0.11: global plugins, open externally ----------------------------------

test('global plugins: discovered beside the vault\'s own, shadowed by it, enabled per vault; reveal goes through the bridge', async () => {
	await clew.invoke('clew:vault-open-path', { path: vaultDir });
	const { plugins, enabled, globalDir: dir } = await clew.invoke('clew:plugins-list');
	const byId = Object.fromEntries(plugins.map((p) => [p.id, p]));
	assert.equal(byId['hello-global']?.scope, 'global', 'the global plugin is listed, and says so');
	assert.equal(byId['hello-global'].dir, '/global-plugins/hello-global', 'its dir is the mirror root, where plugins.js resolves surfaces');
	assert.equal(byId.header?.scope, 'vault', 'a vault plugin shadows a global one of the same id');
	assert.equal(plugins.filter((p) => p.id === 'header').length, 1, 'one id is one plugin');
	assert.ok(!enabled.includes('hello-global'), 'installing globally does not enable');
	assert.equal(dir, globalDir, 'the device path of the folder, for the settings row');
	const mark = fakeBridge.calls.length;
	assert.equal(await clew.invoke('clew:plugins-reveal-global'), globalDir);
	assert.ok(fakeBridge.calls.slice(mark).some(([m]) => m === 'revealGlobalPlugins'), 'reveal is the bridge\'s (the Files app)');
});

test('open externally: planOpen over the mirror, then Quick Look; refusals by name, by place and by kind', async () => {
	await clew.invoke('clew:vault-open-path', { path: vaultDir });
	const mark = fakeBridge.calls.length;
	assert.deepEqual(await clew.invoke('clew:shell-open-path', { path: 'Attachments/Paper.pdf' }), { ok: true });
	assert.ok(fakeBridge.calls.slice(mark).some(([m, p]) => m === 'quickLook' && p.rel === 'Attachments/Paper.pdf'),
		'a vault file opens in Quick Look — the iOS default app');
	const exe = await clew.invoke('clew:shell-open-path', { path: '.clew/plugins/word-count/app.js' });
	assert.equal(exe.ok, false);
	assert.match(exe.reason, /\.js/, 'executables are refused by name (upstream open-file.js)');
	const missing = await clew.invoke('clew:shell-open-path', { path: 'Nope.pdf' });
	assert.equal(missing.ok, false);
	assert.match(missing.reason, /Not found/);
	assert.equal((await clew.invoke('clew:shell-open-path', { path: '../outside.pdf' })).ok, false, 'clamped inside the vault');
	const folder = await clew.invoke('clew:shell-open-path', { path: 'Attachments' });
	assert.equal(folder.ok, false);
	assert.match(folder.reason, /Folders/, 'a folder has no viewer here');
	// file:// links: inside the open vault they are that vault file; anywhere
	// else is unreachable from the sandbox and says so.
	assert.deepEqual(await clew.invoke('clew:shell-open-path', { url: 'file://' + path.join(vaultDir, 'Attachments/Paper.pdf') }), { ok: true });
	const outside = await clew.invoke('clew:shell-open-path', { url: 'file:///etc/hosts' });
	assert.equal(outside.ok, false);
	assert.match(outside.reason, /inside the open vault/);
	assert.equal((await clew.invoke('clew:shell-open-path', { url: 'https://example.com/x.pdf' })).ok, false, 'not a file:// link');
	const quickLooks = fakeBridge.calls.slice(mark).filter(([m]) => m === 'quickLook').length;
	assert.equal(quickLooks, 2, 'exactly the two permitted opens reached the bridge');
});

test('export as PDF (reading view): the bridge prints this session\'s own preview document with upstream\'s ready probe', async () => {
	await clew.invoke('clew:vault-open-path', { path: vaultDir });
	await clew.invoke('clew:settings-set', { key: 'printPaperSize', value: 'letter' });
	const mark = fakeBridge.calls.length;
	const result = await clew.invoke('clew:export-note', { path: 'Guide/Links and Embeds.md', format: 'print-pdf' });
	assert.deepEqual(result, { shared: true });
	const [, params] = fakeBridge.calls.slice(mark).find(([m]) => m === 'printPdf') ?? [];
	assert.ok(params, 'the bridge was asked to print');
	assert.equal(params.url, `clew-preview://vault/${fakeSession.sessionId}/Guide/Links%20and%20Embeds.md.html`, 'the same document the reading pane shows, under this session\'s sid');
	assert.equal(params.name, 'Links and Embeds.pdf');
	assert.equal(params.paperSize, 'letter', 'the printPaperSize setting, as upstream');
	assert.match(params.arm, /__clewPrintReady = true/, 'upstream\'s arm script');
	assert.match(params.probe, /__clewFiguresPending/, 'upstream\'s probe waits for figures too');
	assert.match(params.lightTheme, /theme: 'light'/, 'prints light whatever the app wears');
	await clew.invoke('clew:settings-set', { key: 'printPaperSize', value: 'nonsense' });
	await clew.invoke('clew:export-note', { path: 'Guide/Links and Embeds.md', format: 'print-pdf' });
	assert.equal(fakeBridge.calls.at(-1)[1].paperSize, 'a4', 'an unknown paper size falls back to A4');
	await assert.rejects(clew.invoke('clew:export-note', { path: '../outside.md', format: 'print-pdf' }), /escapes/i);
});

test('font=note: the bridge\'s face map reaches EVERY engine worker\'s env, the first standby included', async () => {
	assert.ok(workerInits.length > 0, 'workers were spawned');
	for (const init of workerInits) {
		const map = JSON.parse(init.env.CLEW_NOTE_FONTS || 'null');
		assert.deepEqual(map, {
			Regular: 'NoteFont-Regular.ttf', Bold: 'NoteFont-Bold.ttf',
			Italic: 'NoteFont-Italic.ttf', BoldItalic: 'NoteFont-BoldItalic.ttf',
		}, 'the file names the scheme handler serves, as figures.js#noteFontFaces reads them');
	}
	assert.ok(fakeBridge.calls.some(([m]) => m === 'noteFonts'), 'asked the bridge once');
	assert.equal(fakeBridge.calls.filter(([m]) => m === 'noteFonts').length, 1, 'built once, not per vault open');
});

// ---- the live-edit sync: exclusion lists, citations as objects, the shell,
// TeX fragments (UPSTREAM-LIVE-EDIT-PLAN.md §1, §2.8–2.9) ------------------

test('BIB_ENTRIES: upstream\'s object shape — the .bib each entry came from, and where its file field points', async () => {
	// A second .bib, written mid-session so the mirror and the disk both
	// carry it: one entry whose PDF is in the vault (Attachments/Paper.pdf,
	// planted in before()), one whose relative path exists nowhere, one
	// absolute — which on iOS is outside the sandbox by definition.
	await clew.invoke(CH.NOTE_WRITE, { path: 'Features/more.bib', content: [
		'@article{withpdf, title={Has a PDF}, author={A. Uthor}, year={2020},',
		'  file={:Attachments/Paper.pdf:PDF}}',
		'@article{missing, title={Gone}, author={B. Uthor}, year={2021}, file={papers/gone.pdf}}',
		'@article{outside, title={Elsewhere}, author={C. Uthor}, year={2022}, file={/Users/someone/Zotero/x.pdf}}',
		'@article{nofile, title={No file at all}, author={D. Uthor}, year={2023}}',
	].join('\n') + '\n' });
	const entries = await clew.invoke(CH.BIB_ENTRIES);
	const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
	assert.ok(byKey.alexander2023, 'the demo vault\'s refs.bib is still scanned');
	assert.equal(byKey.alexander2023.bib, 'Features/refs.bib', '`bib` is the .bib\'s vault path');
	assert.equal(byKey.withpdf.bib, 'Features/more.bib');
	// The old `file: <bib rel>` key is GONE: `file` is now the raw BibTeX field.
	assert.equal(byKey.alexander2023.file, '', 'no file field → empty string, never the .bib path');
	assert.deepEqual(byKey.withpdf.pdf, { path: 'Attachments/Paper.pdf', inVault: true, exists: true },
		'resolved against the vault root, vault-relative, found');
	assert.deepEqual(byKey.missing.pdf, { path: 'Features/papers/gone.pdf', inVault: true, exists: false },
		'the .bib\'s own folder is the first candidate for a relative path');
	assert.deepEqual(byKey.outside.pdf, { path: '/Users/someone/Zotero/x.pdf', inVault: false, exists: false },
		'an absolute path is reported as upstream would; nothing outside the sandbox exists here');
	assert.equal(byKey.nofile.pdf, null);
});

test('exclusion lists: `unindexed` keeps a folder in the tree but out of the index and the .bib scan', async () => {
	const before = await clew.invoke(CH.INDEX_GET);
	assert.ok(before.notes['Features/Diagrams.md'], 'Features is indexed to begin with');
	assert.ok((await clew.invoke(CH.BIB_ENTRIES)).some((e) => e.bib === 'Features/refs.bib'));

	await clew.invoke(CH.VAULT_SETTINGS_SET, { key: 'unindexed', value: ['Features'] });
	await settle();
	const tree = await clew.invoke(CH.VAULT_TREE);
	assert.ok(tree.some((e) => e.name === 'Features'), 'still listed — that is the difference from hidden');
	const index = await clew.invoke(CH.INDEX_GET);
	assert.ok(!Object.keys(index.notes).some((p) => p.startsWith('Features/')), 'no Features note in the index');
	assert.ok(!(await clew.invoke(CH.BIB_ENTRIES)).some((e) => e.bib.startsWith('Features/')),
		'a .bib inside an unindexed folder is that library\'s, not this vault\'s');
	// On disk, in vault-settings.json, the way desktop would read it.
	await native.flush();
	const saved = JSON.parse(fs.readFileSync(path.join(vaultDir, '.clew', 'vault-settings.json'), 'utf8'));
	assert.deepEqual(saved.unindexed, ['Features']);

	await clew.invoke(CH.VAULT_SETTINGS_SET, { key: 'unindexed', value: [] });
	await settle();
	assert.ok((await clew.invoke(CH.INDEX_GET)).notes['Features/Diagrams.md'], 'back in the index once admitted');
});

test('exclusion lists: `hidden` removes a folder from the tree, and the tree event fires', async () => {
	let trees = 0;
	const off = clew.on('clew:ev-tree-changed', () => { trees++; });
	await clew.invoke(CH.VAULT_SETTINGS_SET, { key: 'hidden', value: ['Projects', '**/Templates'] });
	await settle();
	const tree = await clew.invoke(CH.VAULT_TREE);
	const names = tree.map((e) => e.name);
	assert.ok(!names.includes('Projects'), 'hidden: not there at all');
	assert.ok(!names.includes('Templates'), 'a `**/` pattern matches at the root too');
	assert.ok(names.includes('Guide'));
	assert.ok(trees >= 1, 'reloadExcludes pushed a fresh tree');
	assert.ok(!(await clew.invoke(CH.INDEX_GET)).notes['Projects/Clew Design.md'], 'hidden implies unindexed');
	// The built-in rules hold regardless of the lists.
	assert.ok(!names.includes('.clew') && !names.includes('.obsidian'));
	off();
	await clew.invoke(CH.VAULT_SETTINGS_SET, { key: 'hidden', value: [] });
	await settle();
	assert.ok((await clew.invoke(CH.VAULT_TREE)).some((e) => e.name === 'Projects'));
});

test('the shell panel answers with upstream\'s refusal shapes and never throws', async () => {
	assert.deepEqual(await clew.invoke('clew:shell-open'), { ok: false, error: 'A shell is not available on iOS' });
	assert.deepEqual(await clew.invoke('clew:shell-write', { data: 'ls\n' }), { ok: false });
	assert.deepEqual(await clew.invoke('clew:shell-resize', { cols: 80, rows: 24 }), { ok: false });
	assert.deepEqual(await clew.invoke('clew:shell-close'), { ok: false });
});

test('WORKSPACE_LOAD forces a desktop-saved open shell panel closed, keeping its height', async () => {
	await clew.invoke(CH.WORKSPACE_SAVE, { layout: { probe: 2 }, shell: { open: true, height: 300 } });
	const loaded = await clew.invoke(CH.WORKSPACE_LOAD);
	assert.deepEqual(loaded.shell, { open: false, height: 300 });
	assert.deepEqual(loaded.layout, { probe: 2 }, 'nothing else is touched');
	// A workspace without a shell key at all (pre-shell desktop, or fresh)
	// passes through unchanged.
	await clew.invoke(CH.WORKSPACE_SAVE, { layout: { probe: 3 } });
	assert.deepEqual(await clew.invoke(CH.WORKSPACE_LOAD), { layout: { probe: 3 } });
});

test('TeX fragments: both scopes reach every engine worker\'s env, and editing either list respawns the standby', async () => {
	const last = () => JSON.parse(workerInits.at(-1).env.CLEW_TEX_FRAGMENTS);
	// The seed vault ships two fragments; the app-level list starts empty.
	assert.deepEqual(last().global, []);
	assert.deepEqual(last().vault.map((f) => f.name), ['math macros', 'diagram colours']);

	const spawns = workerInits.length;
	await clew.invoke('clew:settings-set', { key: 'texFragments', value: [{ name: 'colours', text: '\\usepackage{xcolor}' }] });
	await settle();
	assert.equal(workerInits.length, spawns + 1, 'a global fragment change retires the standby (reconfigure)');
	assert.deepEqual(last().global, [{ name: 'colours', text: '\\usepackage{xcolor}' }]);

	await clew.invoke(CH.VAULT_SETTINGS_SET, { key: 'texFragments', value: [{ name: 'math macros', text: '\\newcommand{\\R}{\\mathbb{R}}' }] });
	await settle();
	assert.equal(workerInits.length, spawns + 2, 'so does a vault fragment change');
	assert.deepEqual(last().vault, [{ name: 'math macros', text: '\\newcommand{\\R}{\\mathbb{R}}' }]);
	assert.deepEqual(last().global, [{ name: 'colours', text: '\\usepackage{xcolor}' }], 'the other scope is untouched');
	await native.flush();
	const saved = JSON.parse(fs.readFileSync(path.join(vaultDir, '.clew', 'vault-settings.json'), 'utf8'));
	assert.equal(saved.texFragments[0].name, 'math macros', 'on disk, where the desktop reads it');
});

test('the iOS settings defaults carry every key upstream defines, with the plan\'s overrides', async () => {
	const all = await clew.invoke('clew:settings-get');
	for (const key of ['defaultEditMode', 'liveReveal', 'liveRenderMath', 'liveRenderFences', 'liveRenderEmbeds',
		'liveFrameCap', 'editorToolbar', 'editorToolbarPrev', 'editorToolbarGroups', 'selectionBubble',
		'slashCommands', 'linkPreview', 'previewPane', 'graphReferences', 'sidenotes', 'texFragments']) {
		assert.ok(key in all, `${key} is defined`);
	}
	assert.equal(all.newTabMode, 'live');
	assert.equal(all.defaultEditMode, 'live');
	assert.equal(all.editorToolbar, 'always');
	assert.equal(all.liveFrameCap, 8);
	assert.equal(all.linkPreview, 'off');
	assert.equal(all.selectionBubble, false);
	// Upstream's own defaults where the plan keeps them.
	assert.equal(all.liveReveal, 'construct');
	assert.equal(all.previewPane, 'on');
	assert.equal(all.sidenotes, 'auto');
	assert.equal(all.slashCommands, true);
});

// ---- live-edit block frames (plan §2.2): keys, sidecars, eviction ----------

test('renderBlock builds a FULL document from a temp note + .source sidecar in the fragments dir, keyed for reuse', async () => {
	const builds = workerBuilds.length;
	const hash = await native.renderBlock('# A block\n\nwith $x$', 'Guide/Editing Notes.md');
	assert.match(hash, /^[0-9a-f]+$/, 'a hex key, safe in a URL');
	assert.equal(native.blockDocument(hash), '<html>fake</html>', 'served by key while cached');
	assert.equal(workerBuilds.length, builds + 1);
	const build = workerBuilds.at(-1);
	assert.equal(build.options.fragment, false, 'a block is a whole document (template, MathJax config)');
	assert.equal(build.file, `/vault/.clew/cache/fragments/${hash}.md`, 'where vault-model.js#currentFilePath looks');
	assert.equal(build.files[build.file], '# A block\n\nwith $x$');
	assert.equal(build.files[`/vault/.clew/cache/fragments/${hash}.source`], 'Guide/Editing Notes.md',
		'the sidecar that makes Dataview `this` the owning note');
	// Beside the fragment pair, the only .clew content in a snapshot is the
	// engine config and the enabled plugins' engine surfaces (#snapshot).
	assert.ok(!Object.keys(build.files).some((f) => f.startsWith('/vault/.clew/')
		&& !/\/\.clew\/(cache\/fragments|engine|plugins)\//.test(f)), 'nothing else under .clew rides along');
	// Same text, same note: the cached key, no build.
	assert.equal(await native.renderBlock('# A block\n\nwith $x$', 'Guide/Editing Notes.md'), hash);
	assert.equal(workerBuilds.length, builds + 1, 'served from the cache');
	// A different owning note is a different document (Dataview `this` differs).
	assert.notEqual(await native.renderBlock('# A block\n\nwith $x$', 'Welcome.md'), hash);
	// A canvas card of the same text is a fragment, not a document: its own key.
	await native.renderFragment('# A block\n\nwith $x$');
	const frag = workerBuilds.at(-1);
	assert.equal(frag.options.fragment, true);
	assert.ok(!Object.keys(frag.files).some((f) => f.endsWith('.source')), 'no sidecar without a source note');
	assert.notEqual(frag.file, build.file, 'frag and doc keys never collide');
});

test('a dependent block\'s key moves with every file change; an independent one\'s does not', async () => {
	const dependent = await native.renderBlock('![[Welcome]]', 'Inbox.md');
	const plain = await native.renderBlock('just *text*', 'Inbox.md');
	await clew.invoke(CH.NOTE_WRITE, { path: 'Tasks.md', content: '# Tasks\n\n- [ ] one\n' });
	await settle();
	assert.notEqual(await native.renderBlock('![[Welcome]]', 'Inbox.md'), dependent, 'an embed re-renders after any change');
	assert.equal(await native.renderBlock('just *text*', 'Inbox.md'), plain, 'plain text is content-addressed');
	assert.equal(native.blockDocument(dependent), '<html>fake</html>', 'the old document stays served until evicted');
});

test('a block renders under its note\'s citation keys (upstream 707ed87): header prepended, dependent on the note', async () => {
	// Features/Citations.md's header names refs.bib (relative to Features/).
	const cited = await native.renderBlock('> [!note]\n> As \\citet{lewis1969} argued.\n', 'Features/Citations.md');
	const build = workerBuilds.at(-1);
	const text = build.files[build.file];
	assert.match(text, /^---\n/, 'a fenced header in front of the block');
	assert.match(text, /Bibliography: \/vault\/Features\/refs\.bib/, 'the bibliography path made absolute against the note\'s folder');
	assert.match(text, /\\citet\{lewis1969\}/, 'the block itself follows');
	// No source note, or a note without citation keys: no header.
	await native.renderBlock('> [!note]\n> plain\n', 'Inbox.md');
	assert.doesNotMatch(workerBuilds.at(-1).files[workerBuilds.at(-1).file], /^---\n/, 'nothing to prepend');
	// Dependent: a change to any file moves its key, as for an embed.
	await clew.invoke(CH.NOTE_WRITE, { path: 'Tasks.md', content: '# Tasks\n\n- [ ] two\n' });
	await settle();
	assert.notEqual(await native.renderBlock('> [!note]\n> As \\citet{lewis1969} argued.\n', 'Features/Citations.md'), cited);
});

test('a reconfigure retires every block: new keys, old documents gone', async () => {
	const before = await native.renderBlock('reconfigure me', 'Inbox.md');
	await clew.invoke(CH.VAULT_SETTINGS_SET, { key: 'normalSyntax', value: true });
	await settle();
	const after = await native.renderBlock('reconfigure me', 'Inbox.md');
	assert.notEqual(after, before, 'the configuration generation is in the key');
	assert.equal(native.blockDocument(before), null, 'evicted — the handler answers 404 and the frame POSTs again');
	assert.equal(native.blockDocument(after), '<html>fake</html>');
	assert.equal(native.blockDocument('deadbeef'), null);
	await clew.invoke(CH.VAULT_SETTINGS_SET, { key: 'normalSyntax', value: false });
	await settle();
});

test('a block whose source note escapes the vault is refused', async () => {
	await assert.rejects(native.renderBlock('x', '../outside.md'), /escapes vault/);
	// No source note at all is fine (an anonymous block).
	assert.match(await native.renderBlock('anonymous', null), /^[0-9a-f]+$/);
});
