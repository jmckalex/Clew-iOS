// "Export notes as PDF (reading view)" on the iPad (Clew-app 393d482): many
// notes, a PDF each, into one folder — the owner's ask of 2026-11-24, a
// folder of marked essays, each to go back to its writer.
//
// Upstream's sheet (vendor renderer/export-notes.js) runs as it is, and so
// do its plan and its loop (vendor main/print-batch.js: batchPdfNames,
// runPrintBatch). This is the iPad's twin of export.js#exportNotesPrint, the
// Mac's driver, around the iPad's own pieces (FSBridge.swift):
//   - the folder: the document picker, as the Mac's one-folder dialog
//     (Clew-boss: no design round); held security-scoped for the batch;
//   - what is there already: the names in the folders the batch writes into,
//     so a clash is asked about once, and Keep Both numbers past them;
//   - each PDF: the single note's reading-view printer (PrintPDF.swift, the
//     note's own clew-preview document, settled by upstream's probe), one
//     at a time, written into the folder by NotesExportFolder.swift, which
//     never changes a file already there;
//   - Show in Files: the Files app at the folder.
// Replace — the old PDFs somewhere recoverable, never deleted — waits on the
// owner (Clew-boss, 2026-11-24: iOS has no Trash for a local folder, measured
// 3328 in the simulator). Until then the question offers Keep Both and
// Cancel, and `replaced` is always 0.
import { isPrintableNote, commonFolder, batchPdfNames, runPrintBatch } from '../../vendor/clew/main/print-batch.js';
import { CH } from '../../vendor/clew/shared/channels.js';
import { ARM_SCRIPT, READY_PROBE, LIGHT_THEME_SCRIPT, PAPER_SIZES } from './print-pdf.js';

/**
 * The one question about PDFs already in the folder — export.js#askExisting's
 * words, Keep Both and Cancel its buttons.
 * @param {string} folder - the folder's name, as Files shows it
 * @param {string[]} names - the batch's names already taken there
 */
export function existingQuestion(folder, names) {
	const one = names.length === 1;
	const shown = names.slice(0, 6).map((n) => `• ${n}`);
	if (names.length > shown.length) shown.push(`• and ${names.length - shown.length} more`);
	return {
		title: one ? `"${names[0]}" already exists in "${folder}".` : `${names.length} of these PDFs already exist in "${folder}".`,
		message: `${shown.join('\n')}\n\nKeep Both numbers the new ${one ? 'one' : 'ones'}, and leaves ${one ? 'the one' : 'those'} already there as ${one ? 'it is' : 'they are'}.`,
		buttons: [{ id: 'keep', label: 'Keep Both' }, { id: 'cancel', label: 'Cancel', cancel: true }],
	};
}

/** The folder a batch name is written into ('' for the chosen folder itself). */
const dirOf = (name) => (name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '');

/**
 * @param {{ vaults: { resolve: (rel: string) => string, sessionId: string },
 *   bridgeCall: (method: string, params?: object) => Promise<any>,
 *   send: (channel: string, payload: object) => void,
 *   paperSize: () => string,
 *   intoVault?: (rels: string[]) => Promise<void> }} deps
 *   `intoVault` hears the vault paths of the PDFs a batch wrote into the
 *   open vault, so the explorer shows them now (the Mac's refreshIfInside;
 *   the iPad's rescan diffs text files only).
 */
export function createNotesExport({ vaults, bridgeCall, send, paperSize, intoVault = async () => {} }) {
	let batch = null;

	/** EXPORT_NOTES_PRINT: export.js#exportNotesPrint's contract and answers. */
	async function print({ paths } = {}) {
		if (batch) throw new Error('an export of notes is already running in this window');
		const job = batch = { stop: false };
		let folder = null;
		try {
			const notes = [...new Set(Array.isArray(paths) ? paths : [])].filter(isPrintableNote);
			if (!notes.length) throw new Error('no notes to export');
			// Every one the vault's own (a restricted vault's realpath clamp).
			for (const rel of notes) vaults.resolve(rel);

			folder = await bridgeCall('exportFolderPick', { start: commonFolder(notes) });
			if (!folder?.id) return { canceled: true };

			let plan = batchPdfNames(notes);
			const listed = await bridgeCall('exportFolderList', { id: folder.id, dirs: [...new Set(plan.map((p) => dirOf(p.name)))] });
			// Case aside, as the Mac's disk and iCloud take names: a clash is
			// asked about, never written over.
			const there = new Set((listed?.files ?? []).map((f) => String(f).toLowerCase()));
			const taken = (name) => there.has(name.toLowerCase());
			const clash = plan.filter((p) => taken(p.name));
			if (clash.length) {
				const answer = (await bridgeCall('exportFolderAsk', existingQuestion(folder.name, clash.map((p) => p.name))))?.answer;
				if (answer !== 'keep') return { canceled: true };
				plan = batchPdfNames(notes, { taken });
			}

			const paper = String(paperSize() ?? 'a4').toLowerCase();
			const result = await runPrintBatch({
				plan,
				stopped: () => job.stop,
				progress: (p) => send(CH.EV_EXPORT_NOTES_PROGRESS, p),
				print: async (item) => {
					const encoded = item.path.split('/').map(encodeURIComponent).join('/');
					await bridgeCall('exportPrintToFolder', {
						id: folder.id,
						name: item.name,
						url: `clew-preview://vault/${encodeURIComponent(vaults.sessionId)}/${encoded}.html`,
						paperSize: PAPER_SIZES.includes(paper) ? paper : 'a4',
						arm: ARM_SCRIPT,
						probe: READY_PROBE,
						lightTheme: LIGHT_THEME_SCRIPT,
					});
				},
			});
			if (typeof folder.inVault === 'string' && result.written.length) {
				const base = folder.inVault ? `${folder.inVault}/` : '';
				await intoVault(result.written.map((name) => base + name)).catch(() => {});
			}
			// What the sheet says it wrote to: the folder inside the vault by
			// its path there, any other by its name — never a device path.
			return { outDir: folder.inVault || folder.name, ...result, replaced: 0 };
		} finally {
			if (folder?.id) await bridgeCall('exportFolderRelease', { id: folder.id }).catch(() => {});
			batch = null;
		}
	}

	return {
		print,
		/** EXPORT_NOTES_STOP: after the note being printed. */
		stop() {
			if (batch) batch.stop = true;
			return Boolean(batch);
		},
		/** EXPORT_NOTES_REVEAL: the last batch's folder, in the Files app. */
		async reveal() {
			return Boolean((await bridgeCall('exportFolderReveal'))?.opened);
		},
	};
}
