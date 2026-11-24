// "Export notes as PDF (reading view)" on the iPad (src/shim/export-notes.js,
// Clew-app 393d482): the iPad's driver around upstream's print-batch.js,
// against a fake bridge. What native does with each call — the picker, the
// folder writer that never changes a file there, the printer — is
// NotesExportFolder's Swift tests and the simulator's
// (tools/sim-export-notes-checks.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotesExport, existingQuestion } from '../src/shim/export-notes.js';
import { ARM_SCRIPT, READY_PROBE, LIGHT_THEME_SCRIPT } from '../src/shim/print-pdf.js';

const deferred = () => {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
};

/** A fake bridge: a folder with `files` in it, answers by method. */
function harness({ folder = { id: 'f1', name: 'Marked', inVault: null }, files = [], answer = 'keep', fail = [], onPrint = null } = {}) {
	const calls = [];
	const events = [];
	const resolved = [];
	const into = [];
	const bridgeCall = async (method, params = {}) => {
		calls.push([method, params]);
		switch (method) {
			case 'exportFolderPick': return folder;
			case 'exportFolderList': return { files: files.filter((f) => params.dirs.includes(f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '')) };
			case 'exportFolderAsk': return { answer };
			case 'exportPrintToFolder':
				await onPrint?.(params);
				if (fail.includes(params.name)) throw new Error(`could not print ${params.name}`);
				return { bytes: 100 };
			case 'exportFolderRelease': return null;
			case 'exportFolderReveal': return { opened: true };
			default: throw new Error(`unexpected ${method}`);
		}
	};
	const vaults = { sessionId: 'sABC', resolve: (rel) => { if (rel.startsWith('../')) throw new Error('Path escapes vault'); resolved.push(rel); return `/vault/${rel}`; } };
	const exporter = createNotesExport({
		vaults, bridgeCall,
		send: (channel, payload) => events.push([channel, payload]),
		paperSize: () => 'Letter',
		intoVault: async (rels) => { into.push(rels); },
	});
	const printed = () => calls.filter(([m]) => m === 'exportPrintToFolder').map(([, p]) => p.name);
	return { exporter, calls, events, resolved, printed, into: () => into };
}

test('the question about PDFs already there: export.js#askExisting\'s words, Keep Both and Cancel (Replace held for the owner)', () => {
	const one = existingQuestion('Marked', ['Ann.pdf']);
	assert.equal(one.title, '"Ann.pdf" already exists in "Marked".');
	assert.equal(one.message, '• Ann.pdf\n\nKeep Both numbers the new one, and leaves the one already there as it is.');
	assert.deepEqual(one.buttons, [{ id: 'keep', label: 'Keep Both' }, { id: 'cancel', label: 'Cancel', cancel: true }], 'no Replace');
	const many = existingQuestion('Marked', ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf', 'f.pdf', 'g.pdf', 'h.pdf']);
	assert.equal(many.title, '8 of these PDFs already exist in "Marked".');
	assert.equal(many.message, '• a.pdf\n• b.pdf\n• c.pdf\n• d.pdf\n• e.pdf\n• f.pdf\n• and 2 more\n\nKeep Both numbers the new ones, and leaves those already there as they are.');
});

test('a batch: the notes only (no drawing, no other file, no repeat), each the vault\'s own, a PDF each by the reading-view printer, progress as the Mac sends it', async () => {
	const h = harness();
	const result = await h.exporter.print({ paths: ['Essays/Ann.md', 'Essays/Bob.jmd', 'Essays/Ann.md', 'Essays/Sketch.excalidraw.md', 'Essays/essay.pdf', 'Essays/Week 2/Cy.md'] });
	assert.deepEqual(h.resolved, ['Essays/Ann.md', 'Essays/Bob.jmd', 'Essays/Week 2/Cy.md']);
	assert.deepEqual(h.calls[0], ['exportFolderPick', { start: 'Essays' }], 'the picker opens on the notes\' common folder');
	assert.deepEqual(h.calls[1], ['exportFolderList', { id: 'f1', dirs: ['', 'Week 2'] }], 'asked what is in the folders it writes into');
	assert.deepEqual(h.printed(), ['Ann.pdf', 'Bob.pdf', 'Week 2/Cy.pdf'], 'named from the common folder, subfolders kept');
	const first = h.calls.find(([m]) => m === 'exportPrintToFolder')[1];
	assert.deepEqual(first, {
		id: 'f1', name: 'Ann.pdf', url: 'clew-preview://vault/sABC/Essays/Ann.md.html', paperSize: 'letter',
		arm: ARM_SCRIPT, probe: READY_PROBE, lightTheme: LIGHT_THEME_SCRIPT,
	}, 'the single note\'s printer and its scripts, the paper size the setting\'s');
	assert.equal(h.calls.find(([, p]) => p.name === 'Week 2/Cy.pdf')[1].url, 'clew-preview://vault/sABC/Essays/Week%202/Cy.md.html');
	assert.deepEqual(h.events, [
		['clew:ev-export-notes-progress', { done: 0, total: 3, path: 'Essays/Ann.md' }],
		['clew:ev-export-notes-progress', { done: 1, total: 3, path: 'Essays/Bob.jmd' }],
		['clew:ev-export-notes-progress', { done: 2, total: 3, path: 'Essays/Week 2/Cy.md' }],
		['clew:ev-export-notes-progress', { done: 3, total: 3, path: null }],
	]);
	assert.deepEqual(result, { outDir: 'Marked', written: ['Ann.pdf', 'Bob.pdf', 'Week 2/Cy.pdf'], failed: [], stopped: [], replaced: 0 });
	assert.deepEqual(h.calls.at(-1), ['exportFolderRelease', { id: 'f1' }], 'the folder let go at the end');
	assert.deepEqual(h.into(), [], 'not in the vault: nothing to show');
});

test('nothing to export, a note outside the vault, the picker cancelled', async () => {
	let h = harness();
	await assert.rejects(h.exporter.print({ paths: ['a.pdf', 'x.excalidraw.md'] }), /no notes to export/);
	await assert.rejects(h.exporter.print({}), /no notes to export/);
	assert.deepEqual(h.calls, [], 'no picker');
	await assert.rejects(h.exporter.print({ paths: ['../out.md'] }), /escapes/);
	assert.deepEqual(h.calls, [], 'refused before the picker');
	h = harness({ folder: null });
	assert.deepEqual(await h.exporter.print({ paths: ['a.md'] }), { canceled: true }, 'the sheet goes back to its list');
	assert.deepEqual(h.calls.map(([m]) => m), ['exportFolderPick'], 'nothing printed, nothing to let go');
});

test('PDFs already there: asked once; Cancel goes back to the list and prints nothing; Keep Both numbers past every name taken, case aside', async () => {
	let h = harness({ files: ['ann.PDF', 'Week 2/Cy.pdf', 'Notes.txt'], answer: 'cancel' });
	assert.deepEqual(await h.exporter.print({ paths: ['Ann.md', 'Bob.md', 'Week 2/Cy.md'] }), { canceled: true });
	const ask = h.calls.find(([m]) => m === 'exportFolderAsk');
	assert.equal(ask[1].title, '2 of these PDFs already exist in "Marked".');
	assert.match(ask[1].message, /^• Ann\.pdf\n• Week 2\/Cy\.pdf\n\n/);
	assert.deepEqual(h.printed(), [], 'nothing printed');
	assert.deepEqual(h.calls.at(-1), ['exportFolderRelease', { id: 'f1' }]);

	h = harness({ files: ['Ann.pdf', 'ann 2.pdf', 'Week 2/Cy.pdf'], answer: 'keep' });
	const kept = await h.exporter.print({ paths: ['Ann.md', 'Bob.md', 'Week 2/Cy.md'] });
	assert.deepEqual(h.printed(), ['Ann 3.pdf', 'Bob.pdf', 'Week 2/Cy 2.pdf'], 'numbered past "ann 2.pdf" too');
	assert.deepEqual(kept.written, ['Ann 3.pdf', 'Bob.pdf', 'Week 2/Cy 2.pdf']);
	assert.equal(kept.replaced, 0, 'nothing replaced, ever');
	assert.equal(h.calls.filter(([m]) => m === 'exportFolderAsk').length, 1, 'asked once for all');

	h = harness({ files: ['Other.pdf'] });
	await h.exporter.print({ paths: ['Ann.md'] });
	assert.equal(h.calls.filter(([m]) => m === 'exportFolderAsk').length, 0, 'no clash, no question');
});

test('a note that fails is said and passed over; Stop ends it after the note being printed; one batch at a time', async () => {
	let h = harness({ fail: ['Bob.pdf'] });
	const result = await h.exporter.print({ paths: ['Ann.md', 'Bob.md', 'Cy.md'] });
	assert.deepEqual(result.written, ['Ann.pdf', 'Cy.pdf']);
	assert.deepEqual(result.failed, [{ path: 'Bob.md', error: 'could not print Bob.pdf' }]);

	const gate = deferred();
	const started = deferred();
	h = harness({ onPrint: async (p) => { if (p.name === 'Bob.pdf') { started.resolve(); await gate.promise; } } });
	assert.equal(h.exporter.stop(), false, 'nothing running');
	const running = h.exporter.print({ paths: ['Ann.md', 'Bob.md', 'Cy.md', 'Dee.md'] });
	await started.promise;
	await assert.rejects(h.exporter.print({ paths: ['Ann.md'] }), /already running/);
	assert.equal(h.exporter.stop(), true);
	gate.resolve();
	const stopped = await running;
	assert.deepEqual(stopped.written, ['Ann.pdf', 'Bob.pdf'], 'the note being printed finishes');
	assert.deepEqual(stopped.stopped, ['Cy.md', 'Dee.md']);
	assert.deepEqual(h.calls.at(-1), ['exportFolderRelease', { id: 'f1' }]);
	assert.deepEqual((await h.exporter.print({ paths: ['Ann.md'] })).written, ['Ann.pdf'], 'and the next batch may start');
});

test('a folder inside the vault: the explorer is told of each PDF written, by its vault path, and the sheet names the folder by its path there; Show in Files', async () => {
	let h = harness({ folder: { id: 'f2', name: 'PDFs', inVault: 'Marking/PDFs' }, fail: ['Bob.pdf'] });
	assert.equal((await h.exporter.print({ paths: ['Marking/Ann.md', 'Marking/Bob.md', 'Marking/Week 2/Cy.md'] })).outDir, 'Marking/PDFs');
	assert.deepEqual(h.into(), [['Marking/PDFs/Ann.pdf', 'Marking/PDFs/Week 2/Cy.pdf']], 'the ones written, once');
	h = harness({ folder: { id: 'f3', name: 'My Vault', inVault: '' } });
	assert.equal((await h.exporter.print({ paths: ['Ann.md'] })).outDir, 'My Vault', 'the vault\'s own top: its name');
	assert.deepEqual(h.into(), [['Ann.pdf']]);
	h = harness({ folder: { id: 'f4', name: 'PDFs', inVault: 'PDFs' }, fail: ['Ann.pdf'] });
	await h.exporter.print({ paths: ['Ann.md'] });
	assert.deepEqual(h.into(), [], 'nothing written: nothing to show');
	assert.equal(await h.exporter.reveal(), true);
	assert.deepEqual(h.calls.at(-1), ['exportFolderReveal', {}]);
});
