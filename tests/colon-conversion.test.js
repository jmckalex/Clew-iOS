// "Convert this vault" on the iPad (src/shim/colon-conversion.js): upstream's
// converter run verbatim over the mirror, through the shim's COLON_*
// channels, against a real folder behind a fake native bridge that answers as
// VaultStore and ColonConversion.swift do. What the sheet does with the
// answers is upstream's (renderer/colon-conversion.js); the simulator run is
// in the record.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BufferShim } from '../src/worker/shims/buffer.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CH = {
	VAULT_CURRENT: 'clew:vault-current',
	NOTE_WRITE: 'clew:note-write',
	COLON_SCAN: 'clew:colon-scan',
	COLON_APPLY: 'clew:colon-apply',
	COLON_FINISH: 'clew:colon-finish',
	COLON_UNDO: 'clew:colon-undo',
	COLON_LAST: 'clew:colon-last',
	EV_COLON_PROGRESS: 'clew:ev-colon-progress',
};
const BACKUP_WORDS = "Clew's own storage on this iPad (outside the vault)";
const VAULT_NAME = 'Colon Vault';

// ---- the device: an app container whose path changes on update ------------
const device = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-colon-'));
const container = () => path.join(device, 'Containers', 'Data', 'Application', randomUUID().toUpperCase());
let vaultDir = path.join(container(), 'Documents', VAULT_NAME);
// Application Support/colon-conversion: moves with the container on the
// device; here it simply persists, which is what an update preserves.
const backupDir = path.join(device, 'AppSupport', 'colon-conversion');
let identity = `documents:${VAULT_NAME}`;

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const isUtf8 = (bytes) => { try { utf8.decode(bytes); return true; } catch { return false; } };
const TEXT = /\.(md|jmd|bib|canvas|json|css|js|txt)$/i;

/** VaultStore's snapshot: dot entries skipped but .clew; a text file that is
 *  not UTF-8 is "" (String(contentsOf:encoding:.utf8) fails). */
const listFiles = (dir, rel = '') => {
	const out = {};
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name.startsWith('.') && e.name !== '.clew') continue;
		const childRel = rel ? `${rel}/${e.name}` : e.name;
		const abs = path.join(dir, e.name);
		if (e.isDirectory()) Object.assign(out, listFiles(abs, childRel));
		else {
			const bytes = fs.readFileSync(abs);
			const stat = fs.statSync(abs);
			out[childRel] = TEXT.test(e.name)
				? { text: isUtf8(bytes) ? bytes.toString('utf8') : '', size: stat.size, mtimeMs: stat.mtimeMs }
				: { size: stat.size, mtimeMs: stat.mtimeMs };
		}
	}
	return out;
};
const plainRel = (rel) => typeof rel === 'string' && rel !== '' && !rel.startsWith('/')
	&& rel.split('/').every((s) => s && s !== '.' && s !== '..');
const inStore = (rel) => {
	if (!plainRel(rel)) throw new Error('that path is not inside the conversion backups');
	return path.join(backupDir, rel);
};
const writeAtomic = (abs, data) => {
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	const temp = path.join(path.dirname(abs), `.${path.basename(abs)}.clew-tmp`);
	fs.writeFileSync(temp, data);
	fs.renameSync(temp, abs);
};
const walkFiles = (dir, rel = '') => {
	const out = [];
	if (!fs.existsSync(dir)) return out;
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const childRel = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) out.push(...walkFiles(path.join(dir, e.name), childRel));
		else out.push(childRel);
	}
	return out;
};

let failWrite = new Map(); // rel → the device's error, once
let failBackup = null; // (store path) → the device refuses that backup write
const calls = [];
const fakeBridge = {
	async call(method, params = {}) {
		calls.push([method, params]);
		switch (method) {
			case 'vaultBootstrap': return { path: vaultDir };
			case 'vaultOpen':
				return {
					name: path.basename(params.path), path: params.path, files: listFiles(params.path),
					sessionId: 's' + '1'.repeat(32), callerToken: 'ab'.repeat(32), identity,
					trusted: false, access: { trusted: false },
				};
			case 'noteFonts': return null;
			case 'write': {
				if (failWrite.has(params.rel)) {
					const why = failWrite.get(params.rel);
					failWrite.delete(params.rel);
					throw new Error(why);
				}
				const bytes = params.text !== undefined ? Buffer.from(params.text, 'utf8') : Buffer.from(params.base64, 'base64');
				writeAtomic(path.join(params.vault, params.rel), bytes);
				return null;
			}
			case 'mkdir': fs.mkdirSync(path.join(params.vault, params.rel), { recursive: true }); return null;
			case 'setMtime': {
				const abs = path.join(params.vault, params.rel);
				if (fs.existsSync(abs)) fs.utimesSync(abs, new Date(params.mtimeMs), new Date(params.mtimeMs));
				return null;
			}
			case 'remove': fs.rmSync(path.join(params.vault, params.rel), { force: true }); return null;
			case 'readNoteBytes': return fs.readFileSync(path.join(params.vault, params.rel)).toString('base64');
			case 'colonPrepare': {
				// ColonVaultFiles: the folder configs, and of `empty` the notes
				// that are not UTF-8.
				const configs = {};
				const visit = (dir, rel) => {
					const config = path.join(dir, '.jmarkdown', 'config.json');
					if (fs.existsSync(config)) configs[rel] = fs.readFileSync(config, 'utf8');
					for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
						if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') visit(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
					}
				};
				visit(params.vault, '');
				const raw = {};
				for (const rel of params.empty ?? []) {
					const bytes = fs.readFileSync(path.join(params.vault, rel));
					if (bytes.length && !isUtf8(bytes)) raw[rel] = bytes.toString('base64');
				}
				return { configs, raw };
			}
			case 'colonBackupWrite':
				if (failBackup?.(params.path)) throw new Error('The file name is too long.');
				writeAtomic(inStore(params.path), Buffer.from(params.base64, 'base64'));
				return null;
			case 'colonBackupManifests': {
				const base = inStore(params.folder);
				const out = {};
				for (const id of fs.existsSync(base) ? fs.readdirSync(base) : []) {
					const file = path.join(base, id, 'manifest.json');
					if (fs.existsSync(file)) out[id] = fs.readFileSync(file, 'utf8');
				}
				return out;
			}
			case 'colonBackupNotes': {
				// Those named, a missing or escaping one left out.
				const base = inStore(`${params.folder}/${params.id}/notes`);
				return Object.fromEntries(params.paths.filter((rel) => plainRel(rel) && fs.existsSync(path.join(base, rel)))
					.map((rel) => [rel, fs.readFileSync(path.join(base, rel)).toString('base64')]));
			}
			default: return null;
		}
	},
};

// ---- the vault -------------------------------------------------------------
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const NOTES = {
	'Same.md': '# Same\n\n:::note\nA body.\n:::\n\nWritten :today.\n',
	'Second.md': '# Second\n\n::title[A title]\n',
	'Behind.md': '# Behind\n\n:::note\nChanged on another device after the dry run.\n:::\n',
	'Open.md': '# Open\n\n:::note\nIn an editor.\n:::\n',
	'Output/Theorem.md': '# Theorem\n\n:::theorem[Result]\nNumbered once converted.\n:::\n',
	'Edges/CRLF.md': '# CRLF\r\n\r\n:::note\r\nWindows lines.\r\n:::\r\n',
	'Edges/Mixed.md': '# Mixed\r\n\n:::note\nTwo kinds.\r\n:::\n',
	'Loads/Header.md': '---\nLoad directives: callout from my.js\n---\n\n:::note\nIts own.\n:::\n',
	'Loads/Folder/Note.md': '# Folder\n\n:::note\nA generic block.\n:::\n',
	'Plain.md': '# Plain\n\nNo directives here.\n',
	'Secret/Hidden.md': '# Hidden\n\n:::note\nIn a folder the vault hides.\n:::\n',
	'Drawing.excalidraw.md': '---\nexcalidraw-plugin: parsed\n---\n:::note\nA drawing.\n:::\n',
};
const BYTES = {
	...Object.fromEntries(Object.entries(NOTES).map(([rel, text]) => [rel, Buffer.from(text, 'utf8')])),
	'Edges/BOM.md': Buffer.concat([BOM, Buffer.from('# BOM\n\n:::note\nA byte-order mark first.\n:::\n')]),
	'Edges/Latin1.md': Buffer.from([...Buffer.from('# Latin-1 caf'), 0xe9, ...Buffer.from('\n\n:::note\nx\n:::\n')]),
};
const disk = (rel) => fs.readFileSync(path.join(vaultDir, rel));

let shim, clew;
const replies = [];
const progress = [];
const errors = [];
async function invoke(channel, payload) {
	try {
		const answer = await clew.invoke(channel, payload);
		replies.push([channel, answer]);
		return answer;
	} catch (err) {
		errors.push(String(err?.message ?? err));
		throw err;
	}
}
async function launch() {
	globalThis.__clewBridgeImpl = fakeBridge;
	const { createClewShim } = await import(path.join(root, 'dist', 'test', 'services.js'));
	shim = createClewShim({ workerFactory: () => ({ postMessage() {}, terminate() {} }), assetLoader: async () => '', iconTableLoader: async () => ({ icons: {} }) });
	clew = shim.clew;
	clew.on(CH.EV_COLON_PROGRESS, (p) => progress.push(p));
	await clew.invoke(CH.VAULT_CURRENT);
}

before(async () => {
	for (const [rel, bytes] of Object.entries(BYTES)) {
		fs.mkdirSync(path.dirname(path.join(vaultDir, rel)), { recursive: true });
		fs.writeFileSync(path.join(vaultDir, rel), bytes);
	}
	fs.mkdirSync(path.join(vaultDir, 'Loads', 'Folder', '.jmarkdown'), { recursive: true });
	fs.writeFileSync(path.join(vaultDir, 'Loads', 'Folder', '.jmarkdown', 'config.json'), JSON.stringify({ Directives: ['/nonexistent/my.js'] }));
	fs.mkdirSync(path.join(vaultDir, '.clew'), { recursive: true });
	fs.writeFileSync(path.join(vaultDir, '.clew', 'vault-settings.json'), JSON.stringify({ hidden: ['Secret'] }));
	globalThis.window ??= globalThis;
	await launch();
});

test('the Buffer shim keeps a BOM as Node does (ignoreBOM)', () => {
	const bytes = BufferShim.from([0xef, 0xbb, 0xbf, 0x41]);
	assert.equal(bytes.toString('utf8'), '﻿A');
	assert.ok(BufferShim.from(bytes.toString('utf8')).equals(bytes), 'and round-trips byte for byte');
});

let report;
test('the dry run: every note planned from the device\'s view, nothing written', async () => {
	const before = calls.length;
	report = await invoke(CH.COLON_SCAN);
	assert.equal(report.vault, VAULT_NAME, 'the sheet says the vault\'s name');
	const byPath = Object.fromEntries(report.notes.map((n) => [n.path, n]));
	assert.match(byPath['Edges/Latin1.md']?.refuse ?? '', /not UTF-8/, 'a note that is not UTF-8 is refused by name (its bytes came from native)');
	assert.match(byPath['Edges/Mixed.md']?.refuse ?? '', /both ways/, 'mixed line endings are refused by name');
	assert.ok(byPath['Edges/BOM.md'] && !byPath['Edges/BOM.md'].refuse && byPath['Edges/BOM.md'].autoItems > 0, 'a BOM note is planned, not refused');
	assert.ok(byPath['Edges/CRLF.md']?.autoItems > 0, 'CRLF converts');
	assert.equal(byPath['Loads/Header.md']?.loads?.by, 'header', 'a header that loads directives');
	assert.equal(byPath['Loads/Folder/Note.md']?.loads?.by, 'folder', 'a folder config the mirror does not carry still counts');
	assert.equal(byPath['Loads/Folder/Note.md']?.loads?.file, 'Loads/Folder/.jmarkdown/config.json');
	assert.ok(!byPath['Plain.md'], 'a note with nothing to convert is not listed');
	assert.ok(!byPath['Secret/Hidden.md'], 'a note in a folder the vault hides is not looked at (desktop\'s tree walk)');
	assert.ok(!byPath['Drawing.excalidraw.md'], 'nor an Excalidraw drawing');
	assert.equal(report.scanned, Object.keys(BYTES).length - 2, 'every other note was looked at');
	assert.ok(report.restricted, 'a restricted vault is offered');
	const since = calls.slice(before).map(([m]) => m);
	assert.ok(!since.includes('write') && !since.includes('colonBackupWrite'), `the dry run writes nothing: ${[...new Set(since)]}`);
	for (const [rel, bytes] of Object.entries(BYTES)) assert.ok(disk(rel).equals(bytes), `${rel} untouched`);
	assert.ok(progress.some((p) => p.total > 0), 'progress reaches the sheet');
});

let applied;
test('convert: backups and the manifest reach the device first; a note changed behind the mirror is not written', async () => {
	// Another device's edit, which the mirror has not seen.
	fs.writeFileSync(path.join(vaultDir, 'Behind.md'), NOTES['Behind.md'] + '\nAdded elsewhere.\n');
	const before = calls.length;
	applied = await invoke(CH.COLON_APPLY, { scanId: report.scanId, picks: {}, editing: ['Open.md'] });
	assert.equal(applied.backup, BACKUP_WORDS, 'the backup\'s place in words');
	assert.deepEqual(applied.changed, ['Behind.md'], 'the note changed behind the mirror');
	assert.equal(applied.again?.notes?.[0]?.path, 'Behind.md', 'planned again, from what it holds now');
	assert.ok(disk('Behind.md').toString().includes('Added elsewhere.') && disk('Behind.md').toString().includes(':::note'), 'and never written');
	for (const rel of ['Same.md', 'Second.md', 'Edges/BOM.md', 'Edges/CRLF.md']) assert.ok(applied.written.includes(rel), `${rel} written`);
	assert.ok(!disk('Same.md').toString().includes(':::') && disk('Same.md').toString().includes('@'), 'converted to the @ forms');
	assert.ok(disk('Edges/BOM.md').subarray(0, 3).equals(BOM), 'the BOM kept');
	assert.ok(disk('Edges/CRLF.md').toString().includes('\r\n') && !/[^\r]\n/.test(disk('Edges/CRLF.md').toString()), 'CRLF kept');
	for (const rel of ['Edges/Latin1.md', 'Edges/Mixed.md', 'Loads/Header.md', 'Loads/Folder/Note.md', 'Output/Theorem.md', 'Plain.md']) {
		assert.ok(disk(rel).equals(BYTES[rel]), `${rel} left as it was`);
	}
	// The open note: handed back for its editor, not written here.
	assert.deepEqual(applied.editorPlans.map((p) => p.path), ['Open.md']);
	assert.ok(disk('Open.md').equals(BYTES['Open.md']), 'an open note is the editor\'s to change');
	// The device's store: each note as it was, and the manifest.
	const [folder] = fs.readdirSync(backupDir);
	assert.match(folder, /^Colon Vault-[0-9a-f]{12}$/, 'named after the vault, and a hash of its virtual root');
	const dir = path.join(backupDir, folder, applied.id);
	for (const rel of applied.written) assert.ok(fs.readFileSync(path.join(dir, 'notes', rel)).equals(BYTES[rel]), `${rel} backed up byte for byte`);
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
	assert.match(manifest.vault, /^\/colon-vaults\/[0-9a-f]{16}\/Colon Vault$/, 'the manifest holds the virtual root, no device path');
	// The order: every backup and the manifest before the first note.
	const since = calls.slice(before);
	const firstNote = since.findIndex(([m, p]) => m === 'write' && applied.written.includes(p.rel));
	const lastBackup = since.findLastIndex(([m, p]) => m === 'colonBackupWrite' && p.path.includes('/notes/'));
	const firstManifest = since.findIndex(([m, p]) => m === 'colonBackupWrite' && p.path.endsWith('/manifest.json'));
	assert.ok(firstNote > lastBackup && firstNote > firstManifest && firstManifest >= 0, `backups ${lastBackup}, manifest ${firstManifest}, then notes from ${firstNote}`);
	// History kept each one's text.
	const history = walkFiles(path.join(vaultDir, '.clew', 'history')).map((rel) => fs.readFileSync(path.join(vaultDir, '.clew', 'history', rel)));
	assert.ok(history.some((b) => b.equals(BYTES['Same.md'])), 'kept in its history');
	assert.ok(history.some((b) => b.equals(BYTES['Edges/BOM.md'])), 'a BOM note\'s history keeps its BOM');
});

test('FINISH: the editor\'s save is counted; LAST and FINISH read manifests only', async () => {
	const plan = applied.editorPlans[0];
	const before = calls.length;
	assert.equal(await invoke(CH.NOTE_WRITE, { path: 'Open.md', content: plan.after, guard: true }), null, 'the editor saves');
	const finished = await invoke(CH.COLON_FINISH, { id: applied.id, applied: ['Open.md'] });
	assert.equal(finished.ok, true);
	assert.equal(finished.notes, applied.notes + 1, 'the open note joins the conversion');
	const last = await invoke(CH.COLON_LAST);
	assert.equal(last.id, applied.id);
	assert.equal(last.notes, applied.notes + 1);
	assert.ok(!calls.slice(before).some(([m]) => m === 'colonBackupNotes'), 'no note bytes loaded for LAST or FINISH');
});

test('undo: each note still as converted is put back byte for byte; one changed since is left and named', async () => {
	const changedSince = disk('Second.md').toString() + '\nEdited after.\n';
	fs.writeFileSync(path.join(vaultDir, 'Second.md'), changedSince);
	// What the mirror has seen matters not: undo reads the device.
	const before = calls.length;
	const undone = await invoke(CH.COLON_UNDO, { id: applied.id });
	const loads = calls.slice(before).filter(([m]) => m === 'colonBackupNotes');
	assert.ok(loads.length >= 1 && loads.every(([, p]) => p.id === applied.id && p.paths.length <= 200), 'the notes loaded at undo, this conversion\'s, a few hundred a call');
	assert.deepEqual(loads.flatMap(([, p]) => p.paths).sort(), [...applied.written, 'Open.md'].sort(), 'exactly the notes it wrote');
	assert.deepEqual(undone.changed, ['Second.md']);
	assert.equal(disk('Second.md').toString(), changedSince, 'left as it is');
	for (const rel of ['Same.md', 'Edges/BOM.md', 'Edges/CRLF.md', 'Open.md']) assert.ok(disk(rel).equals(BYTES[rel]), `${rel} byte-identical to before`);
	assert.equal(undone.backup, BACKUP_WORDS);
	assert.equal(await invoke(CH.COLON_LAST), null, 'nothing left to undo');
	await assert.rejects(invoke(CH.COLON_UNDO, { id: applied.id }), /undone on/);
});

test('a relaunch after an app update: the container moved, Undo still finds the conversion', async () => {
	fs.writeFileSync(path.join(vaultDir, 'Second.md'), BYTES['Second.md']);
	fs.writeFileSync(path.join(vaultDir, 'Behind.md'), BYTES['Behind.md']);
	await shim.services.vaults.flush();
	shim.services.vaults.close();
	await launch();
	const scan = await invoke(CH.COLON_SCAN);
	const done = await invoke(CH.COLON_APPLY, { scanId: scan.scanId, picks: {}, editing: [] });
	assert.ok(done.notes >= 4);
	const converted = Object.fromEntries(done.written.map((rel) => [rel, disk(rel)]));
	await shim.services.vaults.flush();
	shim.services.vaults.close();
	// The update: the same Documents, under a new container path.
	const moved = path.join(container(), 'Documents', VAULT_NAME);
	fs.mkdirSync(path.dirname(moved), { recursive: true });
	fs.renameSync(vaultDir, moved);
	vaultDir = moved;
	await launch();
	assert.equal((await invoke(CH.VAULT_CURRENT)).name, VAULT_NAME);
	const last = await invoke(CH.COLON_LAST);
	assert.equal(last?.id, done.id, 'the conversion is found under the new path');
	for (const [rel, bytes] of Object.entries(converted)) assert.ok(disk(rel).equals(bytes), `${rel} as converted`);
	const undone = await invoke(CH.COLON_UNDO, { id: null });
	assert.deepEqual(undone.changed, []);
	for (const rel of done.written) assert.ok(disk(rel).equals(BYTES[rel]), `${rel} restored after the move`);
	// Another vault on this device sees none of it.
	await shim.services.vaults.flush();
	shim.services.vaults.close();
	identity = 'documents:Another';
	await launch();
	assert.equal(await invoke(CH.COLON_LAST), null, 'a different vault identity: no conversion of its own');
	identity = `documents:${VAULT_NAME}`;
});

const noteBytes = () => Object.fromEntries(walkFiles(vaultDir).filter((rel) => !rel.startsWith('.clew/')).map((rel) => [rel, disk(rel)]));

async function refusedBackup(failing) {
	await shim.services.vaults.flush();
	shim.services.vaults.close();
	await launch();
	const before = noteBytes();
	const scan = await invoke(CH.COLON_SCAN);
	const planned = scan.notes.filter((n) => !n.refuse && n.autoItems).map((n) => n.path);
	failBackup = failing;
	const writesBefore = calls.length;
	let result;
	try {
		result = await invoke(CH.COLON_APPLY, { scanId: scan.scanId, picks: {}, editing: ['Open.md'] });
		await shim.services.vaults.flush();
	} finally { failBackup = null; }
	const noteWrites = calls.slice(writesBefore).filter(([m, p]) => m === 'write' && !p.rel.startsWith('.clew/'));
	return { before, planned, result, noteWrites };
}

test('a backup the device refuses: no note is written, none goes to an editor, and Undo has nothing to put back', async () => {
	const { before, planned, result, noteWrites } = await refusedBackup((p) => p.endsWith('/notes/Same.md'));
	assert.deepEqual(noteWrites, [], 'not one note written');
	assert.equal(result.notes, 0);
	assert.deepEqual(result.written, []);
	assert.deepEqual(result.editorPlans, [], 'no note handed to an editor');
	assert.equal(result.backup, null, 'the sheet does not say each note was copied');
	const failed = Object.fromEntries(result.failed.map((f) => [f.path, f.why]));
	for (const rel of planned) assert.match(failed[rel] ?? '', /its backup could not be saved on this iPad \(The file name is too long\.\), so it was left as it was/, `${rel} named, with the reason`);
	assert.deepEqual(noteBytes(), before, 'every note byte for byte as it was');
	const last = await invoke(CH.COLON_LAST);
	assert.ok(last === null || last.notes === 0, `LAST claims nothing written: ${JSON.stringify(last)}`);
	if (last) {
		const undone = await invoke(CH.COLON_UNDO, { id: last.id });
		assert.deepEqual(undone.restored, [], 'Undo puts back nothing');
		assert.deepEqual(noteBytes(), before, 'and changes nothing');
	}
});

test('the manifest write refused: nothing is written', async () => {
	const { before, planned, result, noteWrites } = await refusedBackup((p) => p.endsWith('/manifest.json'));
	assert.deepEqual(noteWrites, [], 'not one note written');
	assert.equal(result.notes, 0);
	assert.deepEqual(result.editorPlans, []);
	assert.deepEqual(result.failed.map((f) => f.path).sort(), [...planned].sort(), 'each planned note named, the open one among them');
	assert.ok(result.failed.every((f) => /its backup could not be saved on this iPad/.test(f.why)));
	assert.deepEqual(noteBytes(), before, 'every note byte for byte as it was');
	// After a relaunch the device holds no record of it: nothing to undo.
	await shim.services.vaults.flush();
	shim.services.vaults.close();
	await launch();
	const last = await invoke(CH.COLON_LAST);
	assert.ok(last === null || last.notes === 0, `LAST claims nothing written: ${JSON.stringify(last)}`);
});

test('no device path reaches the renderer or a file the user sees', async () => {
	await shim.services.vaults.flush();
	shim.services.vaults.close();
	await launch();
	const scan = await invoke(CH.COLON_SCAN);
	// The device refuses three writes, and its messages name full paths —
	// spaces in them, as "Application Support" and "Mobile Documents" have.
	failWrite.set('Same.md', `The file “Same.md” couldn’t be saved in the folder “${vaultDir}” (/private/var/mobile/Containers/Data/Application/ABC/Documents/x).`);
	failWrite.set('Second.md', 'Could not write /private/var/mobile/Containers/Data/Application/ABCD/Library/Application Support/colon-conversion/v-1/2026/notes/a b.md');
	failWrite.set('Edges/CRLF.md', 'Could not write /private/var/mobile/Library/Mobile Documents/com~apple~CloudDocs/Vault/x.md');
	const result = await invoke(CH.COLON_APPLY, { scanId: scan.scanId, picks: {}, editing: [] });
	assert.equal(result.failed.length, 3, 'the refused writes are named');
	assert.ok(result.failed.every((f) => /couldn’t be saved|Could not write/.test(f.why)), JSON.stringify(result.failed));
	await invoke(CH.COLON_LAST);
	await invoke(CH.COLON_UNDO, { id: result.id });
	await assert.rejects(invoke(CH.COLON_APPLY, { scanId: 'scan-0' }), /out of date/);
	// Every conversion reply (VAULT_CURRENT's vault info carries the path by
	// design: the renderer's vault store holds it).
	const colonReplies = replies.filter(([channel]) => channel.startsWith('clew:colon-'));
	const seen = JSON.stringify({ colonReplies, progress, errors });
	for (const leak of [vaultDir, path.dirname(vaultDir), device, '/var/mobile', 'Containers', 'CoreSimulator', '/colon-conversion/', '/colon-vaults/',
		'Application Support', 'Support/', 'Mobile Documents', 'Documents/com~apple', 'CloudDocs', 'notes/a b.md', ' b.md']) {
		assert.ok(!seen.includes(leak), `no ${leak} in any reply, event or error`);
	}
	for (const rel of walkFiles(backupDir).filter((r) => r.endsWith('manifest.json'))) {
		const text = fs.readFileSync(path.join(backupDir, rel), 'utf8');
		for (const leak of [device, 'Containers', '/var/mobile']) assert.ok(!text.includes(leak), `no ${leak} in ${rel}`);
	}
});
